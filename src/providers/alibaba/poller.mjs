/**
 * src/providers/alibaba/poller.mjs — Alibaba (Bailian) coding-plan quota → claude-hud bridge.
 *
 * Standalone, local-only background process. Queries the Alibaba Cloud Model
 * Studio / Bailian coding-plan quota API and atomically writes a claude-hud
 * "external usage" snapshot so claude-hud's statusline can render a usage bar.
 *
 * Same shape as the GLM/MiniMax pollers: zero npm deps (Node 18+ built-ins +
 * global fetch), atomic snapshot write, --ensure/--once, key auto-detect.
 *
 * Auth: API key only (Bearer + x-api-key + X-DashScope-API-Key). The cookie /
 * web-session path from CodexBar is intentionally NOT ported (it needs
 * sec_token + CSRF scraping, too brittle for a headless poller).
 *
 * Region: international (modelstudio.console.alibabacloud.com) or china mainland
 * (bailian.console.aliyun.com). On the intl host the API-key path may be
 * unavailable for some accounts → automatically retried on the cn host.
 *
 * Parsing ported from CodexBar's AlibabaCodingPlanUsageFetcher: recursively
 * expand nested JSON strings, pick the active coding-plan instance, read the
 * 5h and weekly quota windows (per5Hour*, perWeek*). Monthly is dropped
 * (claude-hud only has five_hour/seven_day slots).
 */

import fs, { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { fetchWithTimeout } from '../shared/proxy-fetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REGIONS = {
  intl: {
    gateway: 'https://modelstudio.console.alibabacloud.com',
    regionId: 'ap-southeast-1',
    commodityCode: 'sfm_codingplan_public_intl',
    referer:
      'https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan',
  },
  cn: {
    gateway: 'https://bailian.console.aliyun.com',
    regionId: 'cn-beijing',
    commodityCode: 'sfm_codingplan_public_cn',
    referer: 'https://bailian.console.aliyun.com/cn-beijing/?tab=model',
  },
};

const PID_FILE = join(homedir(), '.claude', 'alibaba-poller.pid');

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nonEmpty = (s) => (typeof s === 'string' && s.trim().length > 0 ? s.trim() : undefined);

function readSettingsEnv() {
  try {
    const raw = fs.readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8');
    const s = JSON.parse(raw);
    return s && typeof s === 'object' && s.env && typeof s.env === 'object' ? s.env : {};
  } catch {
    return {};
  }
}

/** Detect region from a settings.json ANTHROPIC_BASE_URL pointing at Alibaba. */
function detectRegion(env) {
  const base = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.toLowerCase() : '';
  if (base.includes('aliyun.com') || base.includes('bailian')) return 'cn';
  if (base.includes('alibabacloud') || base.includes('alibaba')) return 'intl';
  return undefined;
}

/**
 * Auto-detect an Alibaba API key from Claude Code settings. Prefers explicit
 * ALIBABA_API_KEY / DASHSCOPE_API_KEY. Falls back to ANTHROPIC_AUTH_TOKEN ONLY
 * when ANTHROPIC_BASE_URL points at Alibaba.
 */
function keyFromSettings(env) {
  const explicit = nonEmpty(env.ALIBABA_API_KEY) ?? nonEmpty(env.DASHSCOPE_API_KEY);
  if (explicit) return explicit;
  const base = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';
  const token = nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
  if (token && /alibaba|aliyun|bailian|dashscope/i.test(base)) return token;
  return undefined;
}

function resolveConfig() {
  const defaults = {
    intervalSec: 300,
    snapshotPath: join(homedir(), '.claude', 'alibaba-usage-snapshot.json'),
    region: 'intl',
  };
  let fromFile = {};
  try {
    const raw = fs.readFileSync(join(__dirname, 'config.json'), 'utf8');
    fromFile = JSON.parse(raw);
    if (fromFile === null || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
      fromFile = {};
    }
  } catch {
    fromFile = {};
  }
  const intervalRaw = Number(fromFile.intervalSec);
  const intervalSec =
    Number.isFinite(intervalRaw) && intervalRaw >= 10 ? intervalRaw : defaults.intervalSec;
  const snapshotPath =
    typeof fromFile.snapshotPath === 'string' && fromFile.snapshotPath.trim().length > 0
      ? fromFile.snapshotPath
      : defaults.snapshotPath;
  const settingsEnv = readSettingsEnv();
  const apiKey =
    nonEmpty(process.env.ALIBABA_API_KEY) ??
    nonEmpty(process.env.DASHSCOPE_API_KEY) ??
    nonEmpty(fromFile.apiKey) ??
    keyFromSettings(settingsEnv);
  const regionRaw = nonEmpty(fromFile.region) ?? detectRegion(settingsEnv) ?? defaults.region;
  const region = regionRaw === 'cn' ? 'cn' : 'intl';
  return { apiKey, intervalSec, snapshotPath, region };
}

function quotaURL(region) {
  const r = REGIONS[region];
  const u = new URL(r.gateway + '/data/api.json');
  u.searchParams.set('action', 'zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2');
  u.searchParams.set('product', 'broadscope-bailian');
  u.searchParams.set('api', 'queryCodingPlanInstanceInfoV2');
  u.searchParams.set('currentRegionId', r.regionId);
  return u.toString();
}

// ── JSON parsing helpers (ported from CodexBar's recursive walkers) ───────

function expandJson(value) {
  if (Array.isArray(value)) return value.map(expandJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = expandJson(value[k]);
    return out;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const nested = JSON.parse(trimmed);
        if (nested && typeof nested === 'object') return expandJson(nested);
      } catch {
        // not JSON, keep as string
      }
    }
  }
  return value;
}

function findFirstDict(keys, value) {
  if (!value || typeof value !== 'object') return null;
  const dict = Array.isArray(value) ? null : value;
  if (dict) {
    for (const k of keys) {
      const v = dict[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    }
  }
  const iterable = Array.isArray(value) ? value : Object.values(dict || {});
  for (const v of iterable) {
    if (v && typeof v === 'object') {
      const found = findFirstDict(keys, v);
      if (found) return found;
    }
  }
  return null;
}

function findFirstArray(keys, value) {
  if (!value || typeof value !== 'object') return null;
  const dict = Array.isArray(value) ? null : value;
  if (dict) {
    for (const k of keys) {
      if (Array.isArray(dict[k])) return dict[k];
    }
  }
  const iterable = Array.isArray(value) ? value : Object.values(dict || {});
  for (const v of iterable) {
    if (v && typeof v === 'object') {
      const found = findFirstArray(keys, v);
      if (found) return found;
    }
  }
  return null;
}

function findFirstInt(keys, value) {
  if (!value || typeof value !== 'object') return null;
  const dict = Array.isArray(value) ? null : value;
  if (dict) {
    for (const k of keys) {
      const n = parseIntLoose(dict[k]);
      if (n !== null) return n;
    }
  }
  const iterable = Array.isArray(value) ? value : Object.values(dict || {});
  for (const v of iterable) {
    if (v && typeof v === 'object') {
      const found = findFirstInt(keys, v);
      if (found !== null) return found;
    }
  }
  return null;
}

function parseIntLoose(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function parseDateLoose(raw) {
  const n = parseIntLoose(raw);
  if (n !== null) {
    if (n > 1e12) return new Date(n).toISOString(); // ms
    if (n > 1e9) return new Date(n * 1000).toISOString(); // seconds
  }
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

function findFirstDate(keys, value) {
  if (!value || typeof value !== 'object') return null;
  const dict = Array.isArray(value) ? null : value;
  if (dict) {
    for (const k of keys) {
      const d = parseDateLoose(dict[k]);
      if (d) return d;
    }
  }
  const iterable = Array.isArray(value) ? value : Object.values(dict || {});
  for (const v of iterable) {
    if (v && typeof v === 'object') {
      const found = findFirstDate(keys, v);
      if (found) return found;
    }
  }
  return null;
}

function anyInt(keys, dict) {
  for (const k of keys) {
    const n = parseIntLoose(dict[k]);
    if (n !== null) return n;
  }
  return null;
}

function activeScore(info) {
  const status = typeof info.status === 'string' || typeof info.instanceStatus === 'string'
    ? (info.status || info.instanceStatus).toUpperCase()
    : null;
  if (status) {
    if (['VALID', 'ACTIVE'].includes(status)) return 3;
    if (['EXPIRED', 'INVALID', 'INACTIVE', 'DISABLED', 'TERMINATED', 'STOPPED'].includes(status)) return -1;
  }
  if (info.isActive === true || info.active === true) return 3;
  if (info.isActive === false || info.active === false) return -1;
  return 0;
}

function findActiveInstance(payload) {
  const infos = findFirstArray(['codingPlanInstanceInfos', 'coding_plan_instance_infos'], payload);
  if (!infos) return null;
  let first = null;
  let best = null;
  let bestScore = -Infinity;
  for (const item of infos) {
    if (!item || typeof item !== 'object') continue;
    if (first === null) first = item;
    const score = activeScore(item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : first;
}

function findQuotaInfo(payload) {
  const direct = findFirstDict(['codingPlanQuotaInfo', 'coding_plan_quota_info'], payload);
  if (direct) return direct;
  return findFirstDict(
    [
      'per5HourUsedQuota',
      'per5HourTotalQuota',
      'perWeekUsedQuota',
      'perWeekTotalQuota',
    ],
    payload,
  );
}

function parseWindow(quota, usedKeys, totalKeys, resetKeys) {
  const used = anyInt(usedKeys, quota);
  const total = anyInt(totalKeys, quota);
  if (used === null || !total || total <= 0) return null;
  const pct = Math.round(Math.min(100, Math.max(0, (used / total) * 100)));
  const resetsAt = (() => {
    for (const k of resetKeys) {
      const d = parseDateLoose(quota[k]);
      if (d) return d;
    }
    return null;
  })();
  return { used_percentage: pct, resets_at: resetsAt };
}

/**
 * Parse the Alibaba coding-plan response. Ported from CodexBar's
 * parseUsageSnapshot. Returns { fiveHour, sevenDay } (monthly dropped).
 */
function parseAlibabaSnapshot(body) {
  const expanded = expandJson(body);
  const dict = expanded && typeof expanded === 'object' && !Array.isArray(expanded) ? expanded : {};
  const statusCode = findFirstInt(['statusCode', 'status_code', 'code'], dict);
  if (statusCode !== null && statusCode !== 0 && statusCode !== 200) {
    throw new Error('Alibaba API status code ' + statusCode);
  }
  const instance = findActiveInstance(dict);
  const quota = findQuotaInfo(instance || {}) || findQuotaInfo(dict);
  if (!quota) {
    throw new Error('no coding-plan quota data in response');
  }
  const fiveHour = parseWindow(
    quota,
    ['per5HourUsedQuota', 'perFiveHourUsedQuota'],
    ['per5HourTotalQuota', 'perFiveHourTotalQuota'],
    ['per5HourQuotaNextRefreshTime', 'perFiveHourQuotaNextRefreshTime'],
  );
  const sevenDay = parseWindow(
    quota,
    ['perWeekUsedQuota'],
    ['perWeekTotalQuota'],
    ['perWeekQuotaNextRefreshTime'],
  );
  return { fiveHour, sevenDay };
}

async function pollOnce(config, region, { once = false } = {}) {
  const { apiKey, snapshotPath } = config;
  const r = REGIONS[region];
  const url = quotaURL(region);
  const body = JSON.stringify({
    queryCodingPlanInstanceInfoRequest: { commodityCode: r.commodityCode },
  });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + apiKey,
      'x-api-key': apiKey,
      'X-DashScope-API-Key': apiKey,
      'User-Agent': BROWSER_UA,
      Origin: r.gateway,
      Referer: r.referer,
    },
    body,
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('Authentication failed (HTTP ' + res.status + ')');
    err.retryRegion = true;
    throw err;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error('Alibaba quota HTTP ' + res.status + ' ' + (t || '').slice(0, 200));
    err.retryRegion = res.status === 404;
    throw err;
  }
  const json = await res.json();
  const parsed = parseAlibabaSnapshot(json);
  return parsed;
}

async function poll(config, { once = false } = {}) {
  const { snapshotPath } = config;
  // Try configured region first, then the other on retryable failures.
  const order = config.region === 'cn' ? ['cn', 'intl'] : ['intl', 'cn'];
  let lastErr = null;
  for (const region of order) {
    try {
      const parsed = await pollOnce(config, region, { once });
      if (!parsed.fiveHour && !parsed.sevenDay) {
        throw new Error('no usable quota windows');
      }
      const snapshot = { updated_at: new Date().toISOString() };
      if (parsed.fiveHour) snapshot.five_hour = parsed.fiveHour;
      if (parsed.sevenDay) snapshot.seven_day = parsed.sevenDay;
      const tmp = snapshotPath + '.' + process.pid + '.tmp';
      try {
        await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await fsp.rename(tmp, snapshotPath);
      } catch (writeErr) {
        try { await fsp.rm(tmp, { force: true }); } catch {}
        throw writeErr;
      }
      if (once) {
        const fh = parsed.fiveHour ? parsed.fiveHour.used_percentage + '%' : '--';
        const wk = parsed.sevenDay ? ', weekly ' + parsed.sevenDay.used_percentage + '%' : '';
        process.stdout.write('Alibaba usage [' + region + ']: ' + fh + wk + ' -> ' + snapshotPath + '\n');
      }
      return;
    } catch (err) {
      lastErr = err;
      if (!err.retryRegion) break;
      // try next region
    }
  }
  const ts = new Date().toISOString();
  const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
  process.stderr.write('[' + ts + '] alibaba-poller: ' + msg + '\n');
  // Do NOT overwrite the existing snapshot.
}

function ensureRunning() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        process.stderr.write('[alibaba-poller] already running (pid ' + pid + '); --ensure exiting.\n');
        return;
      } catch {}
    }
  } catch {}
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: 'ignore',
    cwd: __dirname,
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch {}
  process.stderr.write('[alibaba-poller] started detached poller (pid ' + child.pid + ').\n');
}

async function main() {
  const config = resolveConfig();
  if (process.argv.includes('--ensure')) {
    if (!config.apiKey) {
      process.stderr.write('[alibaba-poller] --ensure: no API key resolved; skipping.\n');
      process.exitCode = 0;
      return;
    }
    ensureRunning();
    process.exitCode = 0;
    return;
  }
  if (!config.apiKey) {
    process.stderr.write(
      'alibaba-poller: no API key. Set ALIBABA_API_KEY (or DASHSCOPE_API_KEY) env, or "apiKey" in ' +
        join(__dirname, 'config.json') +
        ', or point ANTHROPIC_BASE_URL at Alibaba in ~/.claude/settings.json env.\n',
    );
    process.exit(1);
  }
  const once = process.argv.includes('--once');
  if (once) {
    await poll(config, { once: true });
    process.exitCode = 0;
    return;
  }
  const shutdown = (sig) => { process.stderr.write('[alibaba-poller] received ' + sig + ', exiting.\n'); process.exit(0); };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  await poll(config);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(config.intervalSec * 1000);
    await poll(config);
  }
}

process.on('unhandledRejection', (e) => {
  process.stderr.write('[' + new Date().toISOString() + '] alibaba-poller unhandledRejection: ' + (e && e.message ? e.message : String(e)) + '\n');
});
process.on('uncaughtException', (e) => {
  process.stderr.write('[' + new Date().toISOString() + '] alibaba-poller uncaughtException: ' + (e && e.message ? e.message : String(e)) + '\n');
});

main().catch((e) => {
  process.stderr.write('[' + new Date().toISOString() + '] alibaba-poller fatal: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
});

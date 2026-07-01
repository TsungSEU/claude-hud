/**
 * src/providers/kimi/poller.mjs — Kimi (Moonshot) Code API quota → claude-hud bridge.
 *
 * Standalone, local-only background process. Queries the Kimi Code API usage
 * endpoint and atomically writes a claude-hud "external usage" snapshot.
 *
 * Same shape as the GLM/MiniMax/Alibaba pollers: zero npm deps, atomic write,
 * --ensure/--once, key auto-detect.
 *
 * Auth: Kimi Code API key (Bearer). Endpoint: GET {baseURL}/coding/v1/usages
 * (baseURL defaults to https://api.kimi.com, override with config `baseURL` or
 * KIMI_CODE_BASE_URL env).
 *
 * Parsing ported from CodexBar's KimiUsageFetcher (Code API path). The web/JWT
 * path (www.kimi.com billing service) is NOT ported — needs browser-like
 * headers + JWT session decoding, too brittle for a headless poller.
 *
 * Mapping: response.usage (weekly) → snapshot.seven_day; response.limits[0]
 * (5-hour rate limit) → snapshot.five_hour.
 */

import fs, { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { fetchWithTimeout } from '../shared/proxy-fetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PID_FILE = join(homedir(), '.claude', 'kimi-poller.pid');
const DEFAULT_BASE_URL = 'https://api.kimi.com';

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

function keyFromSettings(env) {
  const explicit = nonEmpty(env.KIMI_CODE_API_KEY) ?? nonEmpty(env.KIMI_API_KEY);
  if (explicit) return explicit;
  const base = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';
  const token = nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
  if (token && /kimi|moonshot/i.test(base)) return token;
  return undefined;
}

function resolveConfig() {
  const defaults = {
    intervalSec: 300,
    snapshotPath: join(homedir(), '.claude', 'kimi-usage-snapshot.json'),
    baseURL: DEFAULT_BASE_URL,
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
    nonEmpty(process.env.KIMI_CODE_API_KEY) ??
    nonEmpty(process.env.KIMI_API_KEY) ??
    nonEmpty(fromFile.apiKey) ??
    keyFromSettings(settingsEnv);
  const baseURL =
    nonEmpty(process.env.KIMI_CODE_BASE_URL) ??
    nonEmpty(fromFile.baseURL) ??
    defaults.baseURL;
  return { apiKey, intervalSec, snapshotPath, baseURL };
}

function usageEndpoint(baseURL) {
  const base = baseURL.replace(/\/+$/, '');
  // If the user already included a coding path, just append "usages".
  if (/\/coding\/v\d+\/?$/.test(base)) return base + '/usages';
  if (/\/coding\/?$/.test(base)) return base + '/v1/usages';
  return base + '/coding/v1/usages';
}

function intLoose(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function parseResetTime(raw) {
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const n = intLoose(raw);
  if (n !== null) {
    if (n > 1e12) return new Date(n).toISOString();
    if (n > 1e9) return new Date(n * 1000).toISOString();
  }
  return null;
}

/**
 * Parse a Kimi usage detail ({limit, used?, remaining?, resetTime?}) into a
 * claude-hud window. Percent = used/limit*100; used falls back to limit-remaining.
 */
function parseDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const limit = intLoose(detail.limit);
  if (limit === null || limit <= 0) return null;
  let used = intLoose(detail.used);
  if (used === null) {
    const remaining = intLoose(detail.remaining);
    if (remaining === null) return null;
    used = Math.max(0, limit - remaining);
  }
  const pct = Math.round(Math.min(100, Math.max(0, (used / limit) * 100)));
  const resetsAt = parseResetTime(detail.resetTime ?? detail.resetAt ?? detail.reset_time ?? detail.reset_at);
  return { used_percentage: pct, resets_at: resetsAt };
}

/** Map Kimi Code API response → { fiveHour, sevenDay }. */
function parseKimiResponse(json) {
  const usage = json && json.usage;
  const limits = json && Array.isArray(json.limits) ? json.limits : null;
  const rateLimitDetail =
    limits && limits[0] && limits[0].detail ? limits[0].detail : null;
  return {
    fiveHour: rateLimitDetail ? parseDetail(rateLimitDetail) : null,
    sevenDay: usage ? parseDetail(usage) : null,
  };
}

async function poll(config, { once = false } = {}) {
  const { apiKey, snapshotPath, baseURL } = config;
  try {
    const url = usageEndpoint(baseURL);
    const res = await fetchWithTimeout(url, {
      headers: {
        Authorization: 'Bearer ' + apiKey,
        Accept: 'application/json',
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Authentication failed (HTTP ' + res.status + ') — invalid API key');
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('Kimi quota HTTP ' + res.status + ' ' + (t || '').slice(0, 200));
    }
    const json = await res.json();
    const parsed = parseKimiResponse(json);
    if (!parsed.fiveHour && !parsed.sevenDay) {
      throw new Error('no usable usage/limits in response');
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
      process.stdout.write('Kimi usage: ' + fh + wk + ' -> ' + snapshotPath + '\n');
    }
  } catch (err) {
    const ts = new Date().toISOString();
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write('[' + ts + '] kimi-poller: ' + msg + '\n');
    // Do NOT overwrite the existing snapshot.
  }
}

function ensureRunning() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        process.stderr.write('[kimi-poller] already running (pid ' + pid + '); --ensure exiting.\n');
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
  process.stderr.write('[kimi-poller] started detached poller (pid ' + child.pid + ').\n');
}

async function main() {
  const config = resolveConfig();
  if (process.argv.includes('--ensure')) {
    if (!config.apiKey) {
      process.stderr.write('[kimi-poller] --ensure: no API key resolved; skipping.\n');
      process.exitCode = 0;
      return;
    }
    ensureRunning();
    process.exitCode = 0;
    return;
  }
  if (!config.apiKey) {
    process.stderr.write(
      'kimi-poller: no API key. Set KIMI_CODE_API_KEY (or KIMI_API_KEY) env, or "apiKey" in ' +
        join(__dirname, 'config.json') +
        ', or point ANTHROPIC_BASE_URL at Kimi in ~/.claude/settings.json env.\n',
    );
    process.exit(1);
  }
  const once = process.argv.includes('--once');
  if (once) {
    await poll(config, { once: true });
    process.exitCode = 0;
    return;
  }
  const shutdown = (sig) => { process.stderr.write('[kimi-poller] received ' + sig + ', exiting.\n'); process.exit(0); };
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
  process.stderr.write('[' + new Date().toISOString() + '] kimi-poller unhandledRejection: ' + (e && e.message ? e.message : String(e)) + '\n');
});
process.on('uncaughtException', (e) => {
  process.stderr.write('[' + new Date().toISOString() + '] kimi-poller uncaughtException: ' + (e && e.message ? e.message : String(e)) + '\n');
});

main().catch((e) => {
  process.stderr.write('[' + new Date().toISOString() + '] kimi-poller fatal: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
});

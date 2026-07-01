/**
 * src/providers/minimax/poller.mjs — MiniMax coding-plan quota → claude-hud bridge.
 *
 * Standalone, local-only background process. Periodically queries the MiniMax
 * coding_plan/remains API and atomically writes a claude-hud "external usage"
 * snapshot ({ updated_at, five_hour, seven_day? }) so claude-hud's statusline
 * can render a real usage bar for MiniMax coding plans.
 *
 * Same shape/contract as the GLM poller (src/providers/glm/poller.mjs): zero
 * npm deps (Node 18+ built-ins + global fetch), independent of claude-hud's
 * short-lived statusline process, atomic snapshot write, --ensure/--once modes,
 * key auto-detected from ~/.claude/settings.json. Differs only in endpoint,
 * auth (Bearer), and response parsing (MiniMax returns remaining%, inverted to
 * used%; weekly bucket gated by current_weekly_status == 1).
 */

import fs, { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { fetchWithTimeout } from '../shared/proxy-fetch.mjs';

// import.meta.dirname only exists on Node 20.11+; derive it portably.
const __dirname = dirname(fileURLToPath(import.meta.url));

const ENDPOINTS = {
  cn: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  en: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
};

const PID_FILE = join(homedir(), '.claude', 'minimax-poller.pid');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nonEmpty = (s) => (typeof s === 'string' && s.trim().length > 0 ? s.trim() : undefined);

/**
 * Read the `env` block from Claude Code's ~/.claude/settings.json (best-effort),
 * used to auto-detect a MiniMax key + region so the user needn't configure them.
 */
function readSettingsEnv() {
  try {
    const raw = fs.readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8');
    const s = JSON.parse(raw);
    return s && typeof s === 'object' && s.env && typeof s.env === 'object' ? s.env : {};
  } catch {
    return {};
  }
}

/** Detect MiniMax region (cn/en) from a settings.json ANTHROPIC_BASE_URL. */
function detectRegion(env) {
  const base = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.toLowerCase() : '';
  if (base.includes('minimax.io')) return 'en';
  if (base.includes('minimaxi.com') || base.includes('minimax')) return 'cn';
  return undefined;
}

/**
 * Auto-detect a MiniMax key from Claude Code settings. Prefers an explicit
 * MINIMAX_API_KEY. Falls back to ANTHROPIC_AUTH_TOKEN ONLY when ANTHROPIC_BASE_URL
 * points at MiniMax — this guard ensures we never send a real Anthropic
 * credential to minimax.
 */
function keyFromSettings(env) {
  const explicit = nonEmpty(env.MINIMAX_API_KEY);
  if (explicit) return explicit;
  const base = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';
  const token = nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
  if (token && /minimax/i.test(base)) return token;
  return undefined;
}

/**
 * Resolve config from (1) env, (2) ./config.json next to this file, (3) defaults.
 * config.json is read synchronously at startup and silently ignored if
 * missing/invalid. apiKey has NO default.
 */
function resolveConfig() {
  const defaults = {
    intervalSec: 300,
    snapshotPath: join(homedir(), '.claude', 'minimax-usage-snapshot.json'),
    region: 'cn',
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
    nonEmpty(process.env.MINIMAX_API_KEY) ??
    nonEmpty(fromFile.apiKey) ??
    keyFromSettings(settingsEnv);
  const regionRaw = nonEmpty(fromFile.region) ?? detectRegion(settingsEnv) ?? defaults.region;
  const region = regionRaw === 'en' ? 'en' : 'cn';

  return { apiKey, intervalSec, snapshotPath, region };
}

const clamp100 = (n) => Math.round(Math.min(100, Math.max(0, n)));
const millisToIso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/**
 * Parse the MiniMax coding_plan/remains response into claude-hud windows.
 *
 * Ported from cc-switch's `parse_minimax_tiers` (src-tauri/src/services/coding_plan.rs):
 *  - take the `model_remains` entry whose model_name == "general" (skip video etc.)
 *  - 5h bucket from `current_interval_remaining_percent` (remaining% → used%)
 *  - weekly bucket ONLY when `current_weekly_status == 1` (3 = no weekly limit)
 *
 * @returns {{ fiveHour: object|null, sevenDay: object|null }}
 */
function parseMinimaxTiers(body) {
  const result = { fiveHour: null, sevenDay: null };
  const modelRemains = body && body.model_remains;
  if (!Array.isArray(modelRemains)) return result;

  const item = modelRemains.find(
    (m) => m && m.model_name === 'general',
  );
  if (!item) return result;

  // 5h (interval) bucket — remaining% inverted to used%.
  const intervalRemain = Number(item.current_interval_remaining_percent);
  if (Number.isFinite(intervalRemain)) {
    result.fiveHour = {
      used_percentage: clamp100(100 - intervalRemain),
      resets_at: millisToIso(Number(item.end_time)),
    };
  }

  // Weekly bucket — only when status == 1 (activated). status 3 etc. means the
  // plan has no weekly limit and remaining% is a meaningless 100 → skip.
  if (Number(item.current_weekly_status) === 1) {
    const weeklyRemain = Number(item.current_weekly_remaining_percent);
    if (Number.isFinite(weeklyRemain)) {
      result.sevenDay = {
        used_percentage: clamp100(100 - weeklyRemain),
        resets_at: millisToIso(Number(item.weekly_end_time)),
      };
    }
  }

  return result;
}

/**
 * Fetch MiniMax coding-plan quota once, parse it, and atomically write the
 * snapshot. Any error is logged to stderr and swallowed so the existing
 * snapshot is NEVER overwritten with bad data.
 */
async function poll(config, { once = false } = {}) {
  const { apiKey, snapshotPath, region } = config;

  try {
    const url = ENDPOINTS[region];
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
      throw new Error(
        'MiniMax quota request failed: HTTP ' + res.status + ' ' + (t || '').slice(0, 200),
      );
    }

    const json = await res.json();

    // Business-level error envelope (MiniMax uses base_resp.status_code).
    const baseResp = json && json.base_resp;
    if (baseResp && Number(baseResp.status_code) !== 0) {
      throw new Error(
        'MiniMax API error (code ' + baseResp.status_code + '): ' +
          (baseResp.status_msg || 'unknown'),
      );
    }

    const parsed = parseMinimaxTiers(json);
    if (!parsed.fiveHour && !parsed.sevenDay) {
      throw new Error('no general coding_plan tier found in response');
    }

    const snapshot = { updated_at: new Date().toISOString() };
    if (parsed.fiveHour) snapshot.five_hour = parsed.fiveHour;
    if (parsed.sevenDay) snapshot.seven_day = parsed.sevenDay;

    // Atomic write: temp file (exclusive flag) then rename over the target.
    const tmp = snapshotPath + '.' + process.pid + '.tmp';
    try {
      await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      await fsp.rename(tmp, snapshotPath);
    } catch (writeErr) {
      try {
        await fsp.rm(tmp, { force: true });
      } catch {
        // Best-effort cleanup; ignore.
      }
      throw writeErr;
    }

    if (once) {
      const fh = parsed.fiveHour ? parsed.fiveHour.used_percentage + '%' : '--';
      const wk = parsed.sevenDay ? ', weekly ' + parsed.sevenDay.used_percentage + '%' : '';
      process.stdout.write('MiniMax usage: ' + fh + wk + ' -> ' + snapshotPath + '\n');
    }
  } catch (err) {
    const ts = new Date().toISOString();
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write('[' + ts + '] minimax-poller: ' + msg + '\n');
    // Do NOT overwrite the existing snapshot.
  }
}

/**
 * --ensure mode (used by the SessionStart hook): start a detached long-lived
 * poller if one isn't already running, then return immediately. Idempotent via
 * a PID file + process.kill(pid, 0) liveness check.
 */
function ensureRunning() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // throws if the process is not alive
        process.stderr.write(
          '[minimax-poller] already running (pid ' + pid + '); --ensure exiting.\n',
        );
        return;
      } catch {
        // Stale PID file — fall through and (re)start.
      }
    }
  } catch {
    // No PID file yet — fall through.
  }

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: 'ignore',
    cwd: __dirname,
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();

  try {
    fs.writeFileSync(PID_FILE, String(child.pid));
  } catch {
    // Best-effort; the PID file only avoids duplicate spawns.
  }
  process.stderr.write(
    '[minimax-poller] started detached poller (pid ' + child.pid + ').\n',
  );
}

async function main() {
  const config = resolveConfig();

  // --ensure: daemonize if not already running, then exit 0 (never block the hook).
  if (process.argv.includes('--ensure')) {
    if (!config.apiKey) {
      process.stderr.write(
        '[minimax-poller] --ensure: no API key resolved; skipping (configure a key to enable).\n',
      );
      process.exitCode = 0;
      return;
    }
    ensureRunning();
    process.exitCode = 0;
    return;
  }

  if (!config.apiKey) {
    process.stderr.write(
      'minimax-poller: no API key found. Set MINIMAX_API_KEY env, or put "apiKey" in ' +
        join(__dirname, 'config.json') +
        ', or (auto) add MINIMAX_API_KEY (or a MiniMax ANTHROPIC_AUTH_TOKEN with a ' +
        'minimax ANTHROPIC_BASE_URL) to ~/.claude/settings.json env.\n',
    );
    process.exit(1);
  }

  const once = process.argv.includes('--once');

  if (once) {
    await poll(config, { once: true });
    process.exitCode = 0;
    return;
  }

  const shutdown = (sig) => {
    process.stderr.write('[minimax-poller] received ' + sig + ', exiting.\n');
    process.exit(0);
  };
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
  process.stderr.write(
    '[' + new Date().toISOString() + '] minimax-poller unhandledRejection: ' +
      (e && e.message ? e.message : String(e)) + '\n',
  );
});
process.on('uncaughtException', (e) => {
  process.stderr.write(
    '[' + new Date().toISOString() + '] minimax-poller uncaughtException: ' +
      (e && e.message ? e.message : String(e)) + '\n',
  );
});

main().catch((e) => {
  process.stderr.write(
    '[' + new Date().toISOString() + '] minimax-poller fatal: ' +
      (e && e.message ? e.message : String(e)) + '\n',
  );
  process.exit(1);
});

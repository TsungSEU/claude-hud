/**
 * src/providers/glm/poller.mjs — GLM (BigModel) → claude-hud quota bridge poller.
 *
 * Self-contained, local-only background process. Periodically queries the GLM
 * usage-quota API and atomically writes a claude-hud "external usage" snapshot
 * ({ updated_at, five_hour: { used_percentage, resets_at } }) so claude-hud's
 * statusline can render a real usage bar + reset countdown.
 *
 */

import fs, { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { fetchWithTimeout } from '../shared/proxy-fetch.mjs';

// import.meta.dirname only exists on Node 20.11+; derive it portably so the
// poller works on Node 18+ (the documented minimum runtime).
const __dirname = dirname(fileURLToPath(import.meta.url));

const ENDPOINT = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';

const PID_FILE = join(homedir(), '.claude', 'glm-poller.pid');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nonEmpty = (s) => (typeof s === 'string' && s.trim().length > 0 ? s.trim() : undefined);

/**
 * Read the `env` block from Claude Code's ~/.claude/settings.json (best-effort).
 * Used to auto-detect a GLM key so the user doesn't have to configure one separately.
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

/**
 * Auto-detect a GLM key from Claude Code settings. Prefers an explicit GLM_API_KEY.
 * Falls back to ANTHROPIC_AUTH_TOKEN ONLY when ANTHROPIC_BASE_URL points at BigModel
 * — this guard ensures we never send a real Anthropic credential to bigmodel.cn.
 */
function keyFromSettings(env) {
  const explicit = nonEmpty(env.GLM_API_KEY);
  if (explicit) return explicit;
  const base = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';
  const token = nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
  if (token && /bigmodel/i.test(base)) return token;
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
    snapshotPath: join(homedir(), '.claude', 'glm-usage-snapshot.json'),
  };

  let fromFile = {};
  try {
    // Read config.json located beside this module, synchronously at startup.
    const cfgPath = join(__dirname, 'config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    fromFile = JSON.parse(raw);
    if (fromFile === null || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
      fromFile = {};
    }
  } catch {
    // Missing or invalid config.json — ignore per spec.
    fromFile = {};
  }

  // Reject 0 / negative / non-finite values so a config typo can't turn the
  // loop into a busy-loop that hammers the GLM API. Floor at 10s; default 300s.
  const intervalRaw = Number(fromFile.intervalSec);
  const intervalSec =
    Number.isFinite(intervalRaw) && intervalRaw >= 10 ? intervalRaw : defaults.intervalSec;
  const snapshotPath =
    typeof fromFile.snapshotPath === 'string' && fromFile.snapshotPath.trim().length > 0
      ? fromFile.snapshotPath
      : defaults.snapshotPath;
  // apiKey priority: explicit GLM_API_KEY env > src/providers/glm/config.json > auto-detect from
  // ~/.claude/settings.json. NO default.
  const settingsEnv = readSettingsEnv();
  const apiKey =
    nonEmpty(process.env.GLM_API_KEY) ??
    nonEmpty(fromFile.apiKey) ??
    keyFromSettings(settingsEnv);

  // weeklyLimitType: which GLM quota window to mirror into the snapshot's
  // seven_day (the long-period / "weekly" row). 'none' (default) disables it.
  // GLM exposes 'TIME_LIMIT' (~18-day cycle) alongside 'TOKENS_LIMIT' (~5h,
  // already used for five_hour). Set e.g. 'TIME_LIMIT' to also render a
  // weekly-style row in claude-hud.
  const weeklyLimitType =
    typeof fromFile.weeklyLimitType === 'string' && fromFile.weeklyLimitType.trim().length > 0
      ? fromFile.weeklyLimitType.trim()
      : 'none';

  return { apiKey, intervalSec, snapshotPath, weeklyLimitType };
}

/**
 * Fetch GLM quota once, select the earliest-resetting TOKENS_LIMIT window, and
 * atomically write the snapshot. Any error is logged to stderr and swallowed so
 * the existing snapshot is NEVER overwritten with bad data.
 */
async function poll(config, { once = false } = {}) {
  const { apiKey, snapshotPath, weeklyLimitType } = config;

  try {
    const res = await fetchWithTimeout(ENDPOINT, {
      headers: {
        Authorization: apiKey,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en',
      },
    });

    if (!res.ok) {
      // Include HTTP status without JS template interpolation in the message.
      const status = res.status;
      const err = new Error('GLM quota request failed: HTTP ' + status);
      err.httpStatus = status;
      throw err;
    }

    const text = await res.text();
    if (!text || !text.trim()) {
      throw new Error('GLM quota request failed: empty body');
    }

    const json = JSON.parse(text);

    if (json.code !== 200 || !Array.isArray(json.data?.limits)) {
      throw new Error('GLM quota response invalid: code/limits unexpected');
    }

    const allLimits = json.data.limits;
    const windows = allLimits.filter(
      (l) =>
        l &&
        l.type === 'TOKENS_LIMIT' &&
        Number.isFinite(l.percentage) &&
        Number.isFinite(l.nextResetTime) &&
        l.nextResetTime > 0,
    );

    if (windows.length === 0) {
      throw new Error('no TOKENS_LIMIT windows');
    }

    // Earliest reset = smallest nextResetTime.
    const win = windows.reduce((a, b) => (b.nextResetTime < a.nextResetTime ? b : a));

    const used = Math.round(Math.min(100, Math.max(0, win.percentage)));

    // Optional long-period window mirrored into seven_day (the weekly row).
    // Enabled via config.weeklyLimitType (e.g. 'TIME_LIMIT'). Find a matching
    // window by type and emit it alongside five_hour.
    let sevenDay = null;
    if (weeklyLimitType && weeklyLimitType !== 'none') {
      const weeklyWin = allLimits.find(
        (l) =>
          l &&
          l.type === weeklyLimitType &&
          Number.isFinite(l.percentage) &&
          Number.isFinite(l.nextResetTime) &&
          l.nextResetTime > 0,
      );
      if (weeklyWin) {
        sevenDay = {
          used_percentage: Math.round(Math.min(100, Math.max(0, weeklyWin.percentage))),
          resets_at: new Date(weeklyWin.nextResetTime).toISOString(),
        };
      }
    }

    const snapshot = {
      updated_at: new Date().toISOString(),
      five_hour: {
        used_percentage: used,
        resets_at: new Date(win.nextResetTime).toISOString(),
      },
    };
    if (sevenDay) {
      snapshot.seven_day = sevenDay;
    }

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
      const resetIso = snapshot.five_hour.resets_at;
      const weeklyStr = sevenDay ? ', weekly ' + sevenDay.used_percentage + '%' : '';
      process.stdout.write(
        'GLM usage: ' + used + '% (resets at ' + resetIso + ')' + weeklyStr + ' -> ' + snapshotPath + '\n',
      );
    }
  } catch (err) {
    const ts = new Date().toISOString();
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write('[' + ts + '] glm-poller: ' + msg + '\n');
    // Do NOT overwrite the existing snapshot.
  }
}

/**
 * --ensure mode (used by the SessionStart hook): start a detached long-lived
 * poller if one isn't already running, then return immediately. Idempotent via
 * a PID file + process.kill(pid, 0) liveness check, so repeated hook fires
 * (every new Claude Code session) never spawn duplicates.
 */
function ensureRunning() {
  // 1. Is an instance already alive?
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // throws if the process is not alive
        process.stderr.write(
          '[glm-poller] already running (pid ' + pid + '); --ensure exiting.\n',
        );
        return;
      } catch {
        // Stale PID file — fall through and (re)start.
      }
    }
  } catch {
    // No PID file yet — fall through.
  }

  // 2. Spawn a detached long-lived instance of this same script (loop mode).
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
    '[glm-poller] started detached poller (pid ' + child.pid + ').\n',
  );
}

async function main() {
  const config = resolveConfig();

  // --ensure: daemonize if not already running, then exit 0 (never block the hook).
  if (process.argv.includes('--ensure')) {
    if (!config.apiKey) {
      process.stderr.write(
        '[glm-poller] --ensure: no API key resolved; skipping (configure a key to enable).\n',
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
      'glm-poller: no API key found. Set GLM_API_KEY env, or put "apiKey" in ' +
        join(__dirname, 'config.json') +
        ', or (auto) add GLM_API_KEY (or a BigModel ANTHROPIC_AUTH_TOKEN with a ' +
        'bigmodel ANTHROPIC_BASE_URL) to ~/.claude/settings.json env.\n',
    );
    process.exit(1);
  }

  const once = process.argv.includes('--once');

  if (once) {
    await poll(config, { once: true });
    // Exit naturally (no forced process.exit) so fetch/undici keep-alive sockets
    // and stdout flush cleanly. Forcing exit right after a successful fetch can
    // trigger a libuv assertion (UV_HANDLE_CLOSING) on Windows. undici releases
    // its idle socket within a few seconds, then the event loop drains and exits.
    process.exitCode = 0;
    return;
  }

  // Clean exit on SIGINT/SIGTERM.
  const shutdown = (sig) => {
    process.stderr.write('[glm-poller] received ' + sig + ', exiting.\n');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Poll immediately, then on interval.
  await poll(config);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(config.intervalSec * 1000);
    await poll(config);
  }
}

// Process-level safety nets so an unexpected rejection/exception logs instead
// of crashing the loop silently. Never reference the API key here (err.message only).
process.on('unhandledRejection', (e) => {
  process.stderr.write(
    '[' + new Date().toISOString() + '] glm-poller unhandledRejection: ' +
      (e && e.message ? e.message : String(e)) + '\n',
  );
});
process.on('uncaughtException', (e) => {
  process.stderr.write(
    '[' + new Date().toISOString() + '] glm-poller uncaughtException: ' +
      (e && e.message ? e.message : String(e)) + '\n',
  );
});

main().catch((e) => {
  process.stderr.write(
    '[' + new Date().toISOString() + '] glm-poller fatal: ' +
      (e && e.message ? e.message : String(e)) + '\n',
  );
  process.exit(1);
});
/**
 * src/providers/shared/proxy-fetch.mjs — proxy-aware fetch with timeout.
 *
 * Node's built-in fetch ignores HTTP(S)_PROXY env vars, which breaks the
 * provider pollers on corporate networks where direct egress is blocked. This
 * module tunnels through an HTTP CONNECT proxy using only Node built-ins
 * (zero deps), honors NO_PROXY and Basic proxy auth, and supports GET/POST
 * with a body.
 *
 * Returns a fetch-Response-like { ok, status, text } on the proxy path, or the
 * real Response on the direct path — both satisfy the pollers' usage of
 * `res.ok` / `res.status` / `await res.text()`.
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/**
 * Parse proxy { host, port, auth? } from env. Accepts a bare `host:port` by
 * prepending `http://`. `auth` is a base64 `user:pass` for Proxy-Authorization,
 * or null when the proxy URL has no credentials.
 */
function proxyFromEnv() {
  const p =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;
  if (!p) return null;
  let spec = p.trim();
  if (!/^https?:\/\//i.test(spec)) spec = 'http://' + spec;
  try {
    const u = new URL(spec);
    const auth = u.username
      ? Buffer.from(
          decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || ''),
        ).toString('base64')
      : null;
    return { host: u.hostname, port: Number(u.port) || 80, auth };
  } catch {
    return null;
  }
}

/** True if host matches a NO_PROXY entry (exact / suffix-domain / `*`). */
function noProxyMatches(host, noProxy) {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  return noProxy
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((np) => np === '*' || h === np || h.endsWith('.' + np));
}

/**
 * HTTPS request through an HTTP CONNECT tunnel. HTTP/chunked parsing is left
 * to Node's https module (via a custom Agent.createConnection that runs TLS
 * over the tunneled socket). Supports GET/POST with a body.
 */
function fetchViaProxyTunnel(targetUrl, opts, ms, proxy) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const method = (opts && opts.method) || 'GET';
    const headers = (opts && opts.headers) || {};
    const body = opts && opts.body ? String(opts.body) : null;
    let activeReq = null;
    let settled = false;
    const timer = setTimeout(() => {
      // Clean up so a hung CONNECT/TLS socket doesn't linger after the timeout.
      if (activeReq) {
        try { activeReq.destroy(); } catch { /* best-effort */ }
      }
      reject(new Error('proxy fetch timeout'));
    }, ms);
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const handle = (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => finish(() => resolve({ status: res.statusCode, body: chunks })));
      res.on('error', (e) => finish(() => reject(e)));
    };

    const connectHeaders = { Host: target.hostname + ':443' };
    if (proxy.auth) connectHeaders['Proxy-Authorization'] = 'Basic ' + proxy.auth;

    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: target.hostname + ':443',
      headers: connectHeaders,
    });
    activeReq = connectReq;
    connectReq.on('connect', (_resp, socket) => {
      if (_resp.statusCode !== 200) {
        return finish(() => reject(new Error('proxy CONNECT failed: HTTP ' + _resp.statusCode)));
      }
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = (_o, cb) => {
        const tlsSock = tls.connect({ socket, servername: target.hostname });
        tlsSock.once('secureConnect', () => cb(null, tlsSock));
        tlsSock.once('error', (e) => cb(e));
      };
      const req = https.request(
        {
          method,
          host: target.hostname,
          path: target.pathname + target.search,
          headers,
          agent,
          servername: target.hostname,
        },
        handle,
      );
      activeReq = req;
      req.on('error', (e) => finish(() => reject(e)));
      if (body) req.write(body);
      req.end();
    });
    connectReq.on('error', (e) => finish(() => reject(e)));
    connectReq.end();
  });
}

/**
 * fetch with a timeout. Routes through a CONNECT tunnel when an HTTP(S) proxy
 * is present AND the target isn't in NO_PROXY; otherwise uses the global fetch.
 */
export async function fetchWithTimeout(url, opts, ms = 15000) {
  let targetHost = '';
  try { targetHost = new URL(url).hostname; } catch { /* leave empty */ }
  const proxy = noProxyMatches(targetHost, process.env.NO_PROXY || process.env.no_proxy)
    ? null
    : proxyFromEnv();
  if (proxy) {
    const { status, body } = await fetchViaProxyTunnel(url, opts, ms, proxy);
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

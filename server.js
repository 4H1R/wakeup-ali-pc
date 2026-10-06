'use strict';

// Wake-on-LAN relay: a person toggles a wake request in the web UI, a MikroTik
// router polls /api/router/poll every minute and sends the magic packet while
// the request is active. No dependencies, Node >= 20.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const cfg = {
  port: Number(process.env.PORT || 3000),
  accessToken: process.env.ACCESS_TOKEN || '',
  routerToken: process.env.ROUTER_TOKEN || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  wakeTimeoutMs: Number(process.env.WAKE_TIMEOUT_MINUTES || 10) * 60_000,
  routerOnlineMs: 150_000, // router polls every 60 s; allow a missed poll
  sessionMaxAgeMs: 30 * 24 * 3600_000,
  trustProxy: process.env.TRUST_PROXY === '1',
};

for (const name of ['accessToken', 'routerToken']) {
  if (cfg[name].length < 24) {
    console.error(`${name === 'accessToken' ? 'ACCESS_TOKEN' : 'ROUTER_TOKEN'} must be set (at least 24 characters).`);
    process.exit(1);
  }
}
if (cfg.accessToken === cfg.routerToken) {
  console.error('ACCESS_TOKEN and ROUTER_TOKEN must be different.');
  process.exit(1);
}

// ---------------------------------------------------------------- state ----

const statePath = path.join(cfg.dataDir, 'state.json');
const state = {
  wakeRequested: false,
  requestedAt: null,
  lastRouterSeenAt: null,
  pcStatus: 'unknown', // up | down | unknown, as reported by the router
  pcStatusAt: null,
  lastWakeSentAt: null,
  events: [],
};

try {
  Object.assign(state, JSON.parse(fs.readFileSync(statePath, 'utf8')));
} catch (err) {
  if (err.code !== 'ENOENT') console.error('Could not read state, starting fresh:', err.message);
}

function save() {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

function logEvent(msg) {
  state.events.unshift({ at: Date.now(), msg });
  state.events.length = Math.min(state.events.length, 30);
  console.log(new Date().toISOString(), msg);
}

// ----------------------------------------------------------------- auth ----

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Stateless session cookie: "<issuedAt>.<hmac>". Changing ACCESS_TOKEN logs everyone out.
function signSession(issuedAt) {
  return crypto.createHmac('sha256', cfg.accessToken).update(`session:${issuedAt}`).digest('base64url');
}

function newSessionCookie() {
  const issuedAt = Date.now();
  return `${issuedAt}.${signSession(issuedAt)}`;
}

function validSession(value) {
  const [issuedAt, sig] = String(value || '').split('.');
  if (!issuedAt || !sig) return false;
  if (Date.now() - Number(issuedAt) > cfg.sessionMaxAgeMs) return false;
  return safeEqual(sig, signSession(issuedAt));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : null;
}

function isUser(req) {
  const token = bearer(req);
  if (token) return safeEqual(token, cfg.accessToken);
  return validSession(parseCookies(req).session);
}

// Failed-auth throttling: 10 failures per IP per 15 minutes.
const failures = new Map();
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_LIMIT = 10;

function clientIp(req) {
  if (cfg.trustProxy) {
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress;
}

function isThrottled(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > FAIL_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return f.count >= FAIL_LIMIT;
}

function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > FAIL_WINDOW_MS) failures.set(ip, { since: Date.now(), count: 1 });
  else f.count++;
}

// ------------------------------------------------------------- handlers ----

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css' };

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4096) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function isHttps(req) {
  return Boolean(req.socket.encrypted) || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

// Reject cross-site POSTs (defence in depth on top of SameSite=Strict).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function publicStatus() {
  const now = Date.now();
  return {
    now,
    wakeRequested: state.wakeRequested,
    requestedAt: state.requestedAt,
    wakeTimeoutMs: cfg.wakeTimeoutMs,
    routerOnline: state.lastRouterSeenAt !== null && now - state.lastRouterSeenAt < cfg.routerOnlineMs,
    lastRouterSeenAt: state.lastRouterSeenAt,
    pcStatus: state.pcStatus,
    pcStatusAt: state.pcStatusAt,
    lastWakeSentAt: state.lastWakeSentAt,
    events: state.events,
  };
}

function routerPoll(req, res, url) {
  const ip = clientIp(req);
  if (isThrottled(ip)) return send(res, 429, 'too many attempts');
  const token = bearer(req) || url.searchParams.get('token');
  if (!token || !safeEqual(token, cfg.routerToken)) {
    recordFailure(ip);
    return send(res, 401, 'unauthorized');
  }

  const now = Date.now();
  const reported = ['up', 'down'].includes(url.searchParams.get('pc')) ? url.searchParams.get('pc') : 'unknown';
  if (state.lastRouterSeenAt === null || now - state.lastRouterSeenAt > cfg.routerOnlineMs) {
    logEvent('Router is polling');
  }
  state.lastRouterSeenAt = now;
  if (reported !== state.pcStatus) logEvent(`PC is ${reported === 'up' ? 'online' : reported === 'down' ? 'offline' : 'unknown'}`);
  state.pcStatus = reported;
  state.pcStatusAt = now;

  let answer = 'idle';
  if (state.wakeRequested) {
    if (reported === 'up') {
      state.wakeRequested = false;
      logEvent('Wake request completed: PC is online');
    } else if (now - state.requestedAt > cfg.wakeTimeoutMs) {
      state.wakeRequested = false;
      logEvent('Wake request expired: PC did not come online');
    } else {
      answer = 'wake';
      state.lastWakeSentAt = now;
      logEvent('Told router to send the magic packet');
    }
  }
  save();
  send(res, 200, answer);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const file = path.join(__dirname, 'public', STATIC[url.pathname]);
    return send(res, 200, fs.readFileSync(file, 'utf8'), { 'Content-Type': MIME[path.extname(file)] });
  }
  if (route === 'GET /healthz') return send(res, 200, 'ok');
  if (route === 'GET /api/router/poll') return routerPoll(req, res, url);

  if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'cross-origin request' });

  if (route === 'POST /api/login') {
    const ip = clientIp(req);
    if (isThrottled(ip)) return send(res, 429, { error: 'Too many attempts, try again later.' });
    const body = await readJson(req);
    if (!body.token || !safeEqual(body.token, cfg.accessToken)) {
      recordFailure(ip);
      return send(res, 401, { error: 'Wrong access token.' });
    }
    const cookie = [
      `session=${newSessionCookie()}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${cfg.sessionMaxAgeMs / 1000}`,
      isHttps(req) ? 'Secure' : '',
    ].filter(Boolean).join('; ');
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (route === 'POST /api/logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (url.pathname.startsWith('/api/')) {
    if (!isUser(req)) {
      if (bearer(req)) recordFailure(clientIp(req));
      return send(res, 401, { error: 'unauthorized' });
    }
    if (route === 'GET /api/status') return send(res, 200, publicStatus());
    if (route === 'POST /api/wake') {
      if (!state.wakeRequested) {
        state.wakeRequested = true;
        state.requestedAt = Date.now();
        logEvent('Wake requested');
        save();
      }
      return send(res, 200, publicStatus());
    }
    if (route === 'POST /api/cancel') {
      if (state.wakeRequested) {
        state.wakeRequested = false;
        logEvent('Wake request cancelled');
        save();
      }
      return send(res, 200, publicStatus());
    }
  }

  send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 400, { error: 'bad request' });
  });
});

server.listen(cfg.port, () => console.log(`wakeup-ali-pc listening on :${cfg.port}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));

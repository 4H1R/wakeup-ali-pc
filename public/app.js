'use strict';

const $ = (id) => document.getElementById(id);
let status = null;

function ago(ts, now) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) showLogin();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showLogin() {
  $('panel').hidden = true;
  $('login').hidden = false;
  $('token').focus();
}

function render(s) {
  status = s;
  $('login').hidden = true;
  $('panel').hidden = false;

  const pc = $('pc');
  const pcKnown = s.routerOnline ? s.pcStatus : 'unknown';
  pc.textContent = { up: 'Online', down: 'Offline', unknown: 'Unknown' }[pcKnown];
  pc.className = `value ${pcKnown}`;
  $('pc-at').textContent = s.pcStatusAt ? `reported ${ago(s.pcStatusAt, s.now)}` : '';

  const router = $('router');
  router.textContent = s.routerOnline ? 'Online' : 'Offline';
  router.className = `value ${s.routerOnline ? 'up' : 'down'}`;
  $('router-at').textContent = `last check-in ${ago(s.lastRouterSeenAt, s.now)}`;

  const toggle = $('toggle');
  toggle.textContent = s.wakeRequested ? 'Cancel wake request' : 'Wake PC';
  toggle.classList.toggle('active', s.wakeRequested);

  let hint = '';
  if (s.wakeRequested) {
    const left = Math.max(0, Math.round((s.requestedAt + s.wakeTimeoutMs - s.now) / 60000));
    hint = `Waiting for the router (checks every minute). Turns off automatically when the PC is online, or in ~${left} min.`;
    if (!s.routerOnline) hint += ' The router has not checked in recently.';
  } else if (s.lastWakeSentAt) {
    hint = `Last magic packet: ${ago(s.lastWakeSentAt, s.now)}`;
  }
  $('hint').textContent = hint;

  const list = $('events');
  list.replaceChildren(
    ...s.events.slice(0, 15).map((e) => {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = new Date(e.at).toLocaleString();
      li.append(time, ` ${e.msg}`);
      return li;
    }),
  );
}

async function refresh() {
  try {
    render(await api('GET', '/api/status'));
  } catch {
    /* 401 already shows the login form; other errors retry on the next tick */
  }
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('POST', '/api/login', { token: $('token').value });
    $('token').value = '';
    await refresh();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('toggle').addEventListener('click', async () => {
  const btn = $('toggle');
  btn.disabled = true;
  try {
    render(await api('POST', status && status.wakeRequested ? '/api/cancel' : '/api/wake'));
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  showLogin();
});

refresh();
setInterval(() => {
  if (!$('panel').hidden) refresh();
}, 5000);

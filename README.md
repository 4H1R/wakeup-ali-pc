# wakeup-ali-pc

Turn on a PC at home from anywhere, even when the home network has **no public IP**
(CGNAT / ISP NAT).

```
 phone ──HTTPS──▶  VPS: wakeup-ali-pc  ◀──HTTPS poll every 1 min──  MikroTik router ──magic packet──▶ PC
   "Wake PC"        (this app, Docker)        "pc=down" → "wake"        (home LAN)
```

Nothing connects *into* the home network. The router only makes outbound HTTPS requests,
so no port forwarding or public IP is needed.

## How it works

1. You open the web page, enter the **access token**, and press **Wake PC**. This sets a
   *wake request* on the server.
2. Every minute the MikroTik checks whether the PC is up (ping, falling back to ARP) and calls
   `GET /api/router/poll?pc=up|down` with the **router token**.
3. If a wake request is active and the PC is down, the server answers `wake` and the router
   sends 3 Wake-on-LAN magic packets. Otherwise it answers `idle`.
4. The wake request **switches itself off** once the router reports the PC online, or after
   `WAKE_TIMEOUT_MINUTES` (default 10). You can also cancel it from the page. (It never stays
   on permanently, so shutting the PC down later doesn't immediately wake it again.)

The page shows whether the PC and the router are online, and recent activity.

## Deploy on a VPS

Requirements: a Linux VPS with Docker (Compose v2), ports **80** and **443** open, and a
domain/subdomain whose DNS **A record points to the VPS IP** (e.g. `wake.example.com`).

```bash
git clone https://github.com/4H1R/wakeup-ali-pc.git
cd wakeup-ali-pc
cp .env.example .env
```

Edit `.env`:

```bash
DOMAIN=wake.example.com
ACCESS_TOKEN=<openssl rand -hex 32>     # for you / the web page
ROUTER_TOKEN=<openssl rand -hex 32>     # for the MikroTik only, must differ
WAKE_TIMEOUT_MINUTES=10
```

A quick way to fill both tokens:

```bash
sed -i "s/^ACCESS_TOKEN=.*/ACCESS_TOKEN=$(openssl rand -hex 32)/; s/^ROUTER_TOKEN=.*/ROUTER_TOKEN=$(openssl rand -hex 32)/" .env
```

Start it:

```bash
docker compose up -d --build
docker compose logs -f        # Caddy obtains the Let's Encrypt certificate on first start
```

Check:

```bash
curl https://wake.example.com/healthz          # → ok
```

Then open `https://wake.example.com` and log in with `ACCESS_TOKEN`.

The URL the router must poll is **`https://<DOMAIN>/api/router/poll`**.

### Already have a reverse proxy on the VPS?

Delete the `caddy` service from `docker-compose.yml`, run `docker compose up -d --build`, and
point your proxy (nginx, Traefik, …) at `http://127.0.0.1:3000`. It must pass
`X-Forwarded-For` and `X-Forwarded-Proto` (the app sets `TRUST_PROXY=1` and uses them for rate
limiting and secure cookies). Example nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Without Docker

Node.js 20+ and no dependencies:

```bash
ACCESS_TOKEN=... ROUTER_TOKEN=... PORT=3000 DATA_DIR=./data node server.js
```

### Update / uninstall

```bash
git pull && docker compose up -d --build     # update
docker compose down -v                        # remove containers + stored state
```

## Configure the MikroTik (RouterOS 7)

1. Edit the config block at the top of [`mikrotik/wakeup.rsc`](mikrotik/wakeup.rsc):

   | Variable | Value |
   | --- | --- |
   | `url` | `https://<DOMAIN>/api/router/poll` |
   | `token` | the `ROUTER_TOKEN` from `.env` |
   | `pcMac` | the PC's wired NIC MAC, e.g. `AA:BB:CC:DD:EE:FF` |
   | `iface` | the LAN interface/bridge the PC is on (default `bridge`) |

   Keep the edited copy out of git (e.g. save it as `wakeup.local.rsc`, which is ignored).

2. Upload and import it:

   ```bash
   scp wakeup.local.rsc admin@<router-ip>:wakeup.rsc
   ssh admin@<router-ip> "/import file-name=wakeup.rsc; /file remove wakeup.rsc"
   ```

   (Or drag the file into WinBox → Files, then run `/import file-name=wakeup.rsc` in a terminal.)

   This creates a script `wakeup-poll` and a scheduler that runs it every minute. Re-importing
   replaces both.

3. Verify:

   ```
   /system script run wakeup-poll
   /log print where message~"wakeup-poll"
   ```

   The web page should now show **Router: Online** and the PC's status within a minute.

Notes:

- The router needs internet access and a correct clock (for certificate checks).
  `check-certificate=yes` relies on RouterOS's built-in trust store
  (`/certificate settings print` → `builtin-trust-store` includes `fetch`, default on 7.19+).
- Logs: `wakeup-poll: magic packets sent` when it wakes the PC,
  `wakeup-poll: could not reach server` if the request fails.
- Remove: `/system scheduler remove [find name=wakeup-poll]; /system script remove [find name=wakeup-poll]`

## Prepare the PC (one-time)

Wake-on-LAN must be enabled end to end:

- **BIOS/UEFI**: enable wake from the network card. On ASUS boards it's
  *Advanced → APM Configuration → Power On by PCI-E = Enabled* and *ErP Ready = Disabled*.
- **Windows**: Device Manager → network adapter → *Advanced*: *Wake on Magic Packet = Enabled*,
  *Shutdown Wake-On-Lan = Enabled*. *Power Management*: allow the device to wake the computer.
- **Windows Fast Startup off** (Control Panel → Power Options → *Choose what the power buttons do*).
- The PC must be **wired** to the same LAN as the router. Wi-Fi can't receive magic packets
  while the PC is off.

## API

All user endpoints accept the session cookie from the page **or** `Authorization: Bearer <ACCESS_TOKEN>`,
which is handy for phone shortcuts (e.g. an iOS Shortcut / Android HTTP widget):

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `POST` | `/api/wake` | access token | start a wake request |
| `POST` | `/api/cancel` | access token | cancel it |
| `GET` | `/api/status` | access token | JSON status |
| `GET` | `/api/router/poll?pc=up\|down` | router token | `wake` or `idle` (plain text) |
| `GET` | `/healthz` | none | `ok` |

```bash
curl -X POST -H "Authorization: Bearer $ACCESS_TOKEN" https://wake.example.com/api/wake
```

## Security notes

- Two separate tokens: leaking the router token only lets someone see `idle`/`wake` and report
  fake PC status; it can't start a wake. Leaking the access token lets someone turn your PC on.
  Rotate either by editing `.env` and running `docker compose up -d`.
- Tokens are compared in constant time. 10 failed attempts per IP lock that IP out for
  15 minutes.
- The session cookie is `HttpOnly`, `SameSite=Strict` and `Secure` over HTTPS, valid for 30 days.
  Changing `ACCESS_TOKEN` invalidates all sessions.
- Cross-origin POSTs are rejected. A strict Content-Security-Policy is set.
- State (`state.json`) lives in the `wakeup-data` Docker volume. It contains no secrets.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Page shows *Router: Offline* | `/log print where message~"wakeup-poll"` on the router; wrong URL/token; router has no internet or wrong clock |
| `could not reach server` in router log | `/tool fetch url="https://<DOMAIN>/healthz" check-certificate=yes output=user` on the router |
| Router says *magic packets sent* but PC stays off | BIOS setting (see above), ErP, Fast Startup, wrong MAC, PC not wired |
| PC status always *Offline* while it's on | wrong `pcMac`, or the PC is on a different L2 network than `iface` |

## License

MIT

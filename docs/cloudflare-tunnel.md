# Cloudflare Tunnel deployment

This runbook exposes a single-host Bobbit instance publicly through a **Cloudflare Tunnel**, with **Cloudflare Access (Zero Trust)** as the *only* authentication gate. It is written for the reference host `maciekm-z13` (Fedora Silverblue, rootless Podman, toolbox-based dev env) but applies to any Silverblue-style host.

All deployment artifacts referenced here live in [`deploy/cloudflare/`](../deploy/cloudflare/). The full design rationale is in [`docs/design/cloudflare-tunnel.md`](design/cloudflare-tunnel.md); this page is the reproducible operator runbook.

> **Follow the sections in order.** Section 2 (edge TLS) and Section 3 (host Node) are the two most likely failure points and must be settled **before** you touch any of the plumbing.

---

## 1. Overview & architecture

```
 Browser ──HTTPS──▶ Cloudflare edge ──▶ Access (Zero Trust login) ──▶ Tunnel
                                                                        │ (outbound QUIC/7844)
                                                                        ▼
                                                cloudflared (rootless Podman, Network=host)
                                                                        │ http://127.0.0.1:3001
                                                                        ▼
                                                Bobbit (systemd --user, localhost mode, no token)
```

**Auth model — state it plainly:** **Cloudflare Access is the SOLE auth gate. Bobbit runs token-less in localhost mode.** Bobbit binds the host loopback (`--host 127.0.0.1`), which keeps it in *localhost mode* — it skips its own bearer-token check entirely and trusts that only local processes (here, `cloudflared`) can reach it. The public authentication boundary is therefore Cloudflare Access; once Access lets a request through the tunnel to `127.0.0.1:3001`, Bobbit serves it without a second login.

**Why this works (and why the binding matters):** Bobbit decides localhost mode from `config.host`. In `src/server/server.ts` the check is:

```js
const isLocalhostMode = !config.forceAuth &&
  (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");
```

When `isLocalhostMode` is true the auth check is skipped; Bobbit just mints a convenience cookie. If you instead bind a wildcard address (`0.0.0.0` or `::`), `config.host` is no longer a loopback literal, `isLocalhostMode` flips to **false**, and Bobbit silently starts demanding its own bearer token — which nothing in this topology supplies, so the UI becomes unreachable. Likewise, passing `--auth` sets `forceAuth` and exits localhost mode. **Never bind a wildcard address and never pass `--auth` in this deployment.**

**Why a tunnel (no inbound ports):** `cloudflared` makes only *outbound* connections to the Cloudflare edge (QUIC on 7844). Nothing on the host listens publicly; there are no inbound firewall holes and no port-forwarding. That is also why the container can safely use `Network=host` — host networking is needed so the daemon can reach Bobbit on `127.0.0.1`, and it grants no inbound exposure.

| Component | Where | Runs as |
|---|---|---|
| Bobbit gateway | host loopback `127.0.0.1:3001` | systemd `--user` unit ([`bobbit.service`](../deploy/cloudflare/bobbit.service)) |
| `cloudflared` | rootless Podman, `Network=host` | quadlet ([`cloudflared.container`](../deploy/cloudflare/cloudflared.container)) → generated `cloudflared.service` |
| Tunnel ingress | `~/.config/cloudflared/config.yml` (uncommitted) | from [`config.yml.example`](../deploy/cloudflare/config.yml.example) |

Both services start at boot and survive logout because `setup.sh` enables **linger** (`loginctl enable-linger`).

---

## 2. KEY DECISION — edge TLS coverage (do this FIRST)

The goal's literal target hostname, `bobbit.z13.maciej.dev`, is a **second-level subdomain** (`bobbit` under `z13` under the apex `maciej.dev`). This is a trap.

Per Cloudflare's [Universal SSL documentation](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/): on a **full-setup** zone (Cloudflare is authoritative for the domain — the usual case for a personal domain moved onto Cloudflare nameservers), free Universal SSL covers only the **apex** and **first-level** subdomains (e.g. `maciej.dev` and `www.maciej.dev`). A leaf certificate for a second-level name like `bobbit.z13.maciej.dev` will **not** be issued. The result: after every other piece is correct, the browser still gets a **TLS handshake error at the edge** — because Cloudflare has no cert to present for that host.

**Decide your cert path before any plumbing.** Pick exactly one:

| Option | Cert path | Cost | What to do |
|---|---|---|---|
| **A — first-level hostname** *(recommended fallback)* | Covered by free Universal SSL on a full-setup zone | **Free** | Use **`bobbit-z13.maciej.dev`** as `<HOSTNAME>` everywhere. Nothing else changes. |
| **B — Total TLS** | Auto-issues certs for all hostnames, including deeper subdomains | Paid (ACM) | Enable Total TLS on the zone; keep `bobbit.z13.maciej.dev`. |
| **C — Advanced Certificate** | Manually scope an ACM cert | Paid (ACM) | Order an advanced cert covering `*.z13.maciej.dev` (or the exact host). |
| **D — partial (CNAME) setup** | Each proxied hostname gets its own cert *regardless of depth* | Free | Only if the zone is/becomes a partial setup — not the assumed topology here. |

All artifacts use a single hostname value, so switching between options is a **one-line change**. The example config ([`config.yml.example`](../deploy/cloudflare/config.yml.example)) defaults to `bobbit.z13.maciej.dev`; throughout this runbook that value is written as **`<HOSTNAME>`**. If you choose option A, set `<HOSTNAME> = bobbit-z13.maciej.dev` in `config.yml`, in the `cloudflared tunnel route dns` command, and in the Access application — and you are done with TLS for free.

---

## 3. Prerequisites — host Node 20+ (the most likely failure point)

Bobbit needs **Node.js 20 or newer on the HOST**. On Fedora Silverblue the base image ships **no Node**, and the interactive dev environment lives inside a **toolbox** container. **The toolbox Node does NOT count** — `bobbit.service` is a systemd `--user` unit that runs on the host, outside the toolbox, so its `ExecStart` must resolve a `node` that exists on the host.

`setup.sh` probes for a host Node (it checks `$NODE_BIN_DIR/node`, then `node` on `PATH`) and **fails loudly with remediation text** if none ≥ v20 is found — it never silently falls back to the toolbox.

### Recommended: portable Node tarball under `~/.local`

No root, no reboot, fully self-contained in the user's home alongside the `--user` service:

```bash
mkdir -p "$HOME/.local"
curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz \
  | tar -xJ -C "$HOME/.local"
ln -sfn "$HOME/.local/node-v20.18.0-linux-x64" "$HOME/.local/node"
# Verify:
"$HOME/.local/node/bin/node" -v   # -> v20.x
```

`bobbit.service` prepends `$NODE_BIN_DIR` (default `%h/.local/node/bin`, i.e. `~/.local/node/bin`) to its `PATH`, so this is the path of least resistance — the stable symlink means you can upgrade the tarball later without re-editing the unit.

### Alternative: rpm-ostree layered package

Lowest maintenance and survives ostree updates, at the cost of layering a package onto the base image plus one reboot:

```bash
rpm-ostree install nodejs
systemctl reboot
```

After reboot, `node` is on the system `PATH` (`/usr/bin`), which the unit's `PATH` already includes.

### One-time build (do this before first start)

Build Bobbit **once** so the service start path is just `node dist/server/cli.js` with no `npm` at boot. The build may run **inside the toolbox** (where the full toolchain lives) or with the host Node:

```bash
cd <CHECKOUT_DIR>     # your Bobbit source checkout
npm install
npm run build
```

With a fresh `dist/` present, the `./run` launcher used by `bobbit.service` skips its bootstrap/rebuild branches and goes straight to `exec node dist/server/cli.js …` — fast and side-effect-free at boot. (If `dist/` is missing or stale, `./run` would try to `npm install`/`npm run build` itself, which is slow and noisy for a supervised service — so pre-build.)

### Other host prerequisites

- **Rootless Podman working on the host.** The cloudflared quadlet is generated and run by the host's `--user` Podman/systemd. Confirm with `podman info` on the host.
- **`cloudflared` CLI installed on the host** — needed for the interactive steps in Section 4 (`tunnel login`, `create`, `route dns`). Install per [Cloudflare's downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/). The *daemon* runs in the container; the *CLI* you run by hand is separate.

---

## 4. Manual Cloudflare steps (you run these — `setup.sh` does NOT)

These six steps touch live Cloudflare state and/or place secrets, so they are performed by hand, **on the host**. Replace `<HOSTNAME>` with the value you chose in Section 2.

1. **Authenticate to the zone** (opens a browser; pick the `maciej.dev` zone):
   ```bash
   cloudflared tunnel login
   ```
2. **Create the tunnel** (prints a `<TUNNEL_ID>` UUID and writes a credentials JSON, by default into `~/.cloudflared/<TUNNEL_ID>.json`):
   ```bash
   cloudflared tunnel create bobbit-z13
   ```
3. **Route DNS** — creates a proxied CNAME `<HOSTNAME>` → `<TUNNEL_ID>.cfargotunnel.com`:
   ```bash
   cloudflared tunnel route dns bobbit-z13 <HOSTNAME>
   ```
4. **Create the Access application** (this is the authentication layer): Zero Trust dashboard → **Access → Applications** → **Add an application** → **Self-hosted**, with the application domain set to `<HOSTNAME>`. Add an **allow policy** scoped to your identity (e.g. an *Emails* rule listing the owner email). Without this policy, anyone who can reach the hostname would reach Bobbit, which has no auth of its own.
5. **Drop the real config + credentials into `~/.config/cloudflared/`** (these are **uncommitted** — the repo `.gitignore` keeps `config.yml`/`*.json` out of git):
   ```bash
   cp deploy/cloudflare/config.yml.example ~/.config/cloudflared/config.yml
   # Edit config.yml: set tunnel + credentials-file <TUNNEL_ID>, and hostname = <HOSTNAME>.
   cp ~/.cloudflared/<TUNNEL_ID>.json ~/.config/cloudflared/<TUNNEL_ID>.json
   ```
   The `credentials-file` path inside `config.yml` is the **in-container** path (`/etc/cloudflared/<TUNNEL_ID>.json`), because the quadlet mounts `~/.config/cloudflared` at `/etc/cloudflared` read-only. Keep `service: http://127.0.0.1:3001` pinned to `127.0.0.1` (not `localhost`/`::1`) to avoid flaky IPv6 resolution between `cloudflared` and Bobbit.
6. **Run the non-interactive installer** (Section 5), which places the units and starts both services.

---

## 5. Running `setup.sh`

[`setup.sh`](../deploy/cloudflare/setup.sh) handles the non-interactive plumbing. Run it **on the host** (it is not allowed inside a toolbox):

```bash
flatpak-spawn --host deploy/cloudflare/setup.sh
# or, from a host shell already:
deploy/cloudflare/setup.sh
```

It is **idempotent** — safe to re-run at any time. What it does:

- **Toolbox guard.** If `$TOOLBOX_PATH` is set it refuses to run and prints the `flatpak-spawn --host` invocation. (The units must be installed into the *host's* config dirs, not the toolbox's.)
- **Host Node probe.** Verifies a host `node` ≥ v20 exists (see Section 3); on failure it prints the portable-tarball and rpm-ostree remediation and exits non-zero.
- **Installs the two units**, substituting placeholders into `bobbit.service` via a temp file (the repo template is never edited in place):
  - `~/.config/systemd/user/bobbit.service`
  - `~/.config/containers/systemd/cloudflared.container` (the Podman generator turns this into `cloudflared.service` on `daemon-reload`)
- **`systemctl --user daemon-reload`**, then **`loginctl enable-linger "$USER"`** so the services run at boot and survive logout.
- **Enables and starts both services**: `systemctl --user enable --now bobbit.service`, then `systemctl --user start cloudflared.service`. If `cloudflared` fails to start because the real `config.yml`/credentials aren't in place yet, it prints a warning telling you to complete the Section 4 steps and re-run the start.
- **Echoes the remaining manual Cloudflare steps** (Section 4) with exact commands and a `systemctl --user status` hint.

### Environment overrides

`setup.sh` honors three env vars (it derives sensible defaults otherwise):

| Variable | Default | Purpose |
|---|---|---|
| `CHECKOUT_DIR` | `git rev-parse --show-toplevel` | Absolute path to your Bobbit source checkout (sets `WorkingDirectory` + `ExecStart`). |
| `BOBBIT_CWD` | `$CHECKOUT_DIR` | Default agent working directory (`--cwd`); point it at a projects dir if desired. |
| `NODE_BIN_DIR` | `$HOME/.local/node/bin` | Host Node `bin` dir prepended to the unit's `PATH`. |

Example:

```bash
CHECKOUT_DIR=$HOME/src/bobbit BOBBIT_CWD=$HOME/projects \
  flatpak-spawn --host deploy/cloudflare/setup.sh
```

---

## 6. Verification

Work through these in order. They map directly onto the goal's acceptance criteria.

1. **Edge cert + Access login.** Open `https://<HOSTNAME>` in a browser. You should get a **valid edge certificate** (no TLS warning — if you get a handshake error, return to Section 2) and the **Cloudflare Access login** screen. Authenticate with an identity allowed by your policy.
2. **Bobbit UI loads, token-less.** After Access succeeds you should land on the Bobbit UI. **Bobbit must never prompt for its own token** — if it does, it is not in localhost mode (see Troubleshooting).
3. **WebSocket + session streaming.** Open a session and confirm output streams live. This proves the `/ws/*` WebSocket upgrade tunnels end-to-end.

### Request lifecycle (why the WebSocket works)

```
1. Browser → https://<HOSTNAME> → Cloudflare edge presents the leaf cert (must be covered — §2).
2. Access intercepts the unauthenticated request → Zero Trust login → on success sets the
   CF_Authorization cookie scoped to <HOSTNAME> → forwards the request through the tunnel.
3. cloudflared (host netns) proxies to http://127.0.0.1:3001 → Bobbit.
4. Bobbit is in localhost mode → no bearer-token check; mints a convenience cookie, serves UI/API.
5. UI opens wss://<HOSTNAME>/ws/... . The upgrade carries the CF_Authorization cookie (same host),
   so Access permits it; cloudflared proxies the WebSocket upgrade natively. Output streams.
```

The key detail for step 5: because the WebSocket is on the **same host** as the page, the browser sends the `CF_Authorization` cookie on the upgrade request, so Cloudflare Access lets the upgrade through. `cloudflared` proxies WebSocket upgrades natively — no extra ingress config is required.

---

## 7. Troubleshooting

**Edge TLS handshake error / "this site can't provide a secure connection".**
The edge has no certificate for `<HOSTNAME>`. This is almost always the second-level-subdomain trap — see **Section 2**. Either switch to a first-level hostname (option A) or enable Total TLS / an advanced cert (options B/C). Confirm what the edge actually serves:
```bash
echo | openssl s_client -connect <HOSTNAME>:443 -servername <HOSTNAME> 2>/dev/null \
  | openssl x509 -noout -subject -issuer
```

**WebSocket fails to connect (UI loads but sessions don't stream).**
The `/ws/*` upgrade is being blocked or stripped. Check that the Access application/policy covers the whole hostname (not a path carve-out that excludes `/ws/*`) so the `CF_Authorization` cookie is honored on the upgrade. In browser DevTools → Network, the `ws://`/`wss://` request should complete a `101 Switching Protocols`, not a `403`. If you see `403`, it is Access rejecting the upgrade — fix the policy scope.

**cloudflared can't reach the origin (502 / "connection refused" in cloudflared logs).**
- **Wrong networking.** The quadlet must use `Network=host`. Do **not** rewrite the ingress to `host.containers.internal` — that resolves to the host gateway bridge IP, not loopback, and Bobbit in localhost mode listens only on `127.0.0.1`.
- **Bobbit not running.** Check `systemctl --user status bobbit.service`.
- **Wrong port.** Ingress `service:` must be `http://127.0.0.1:3001`, matching Bobbit's `--port 3001`.

**Bobbit prompts for a token = it is NOT in localhost mode.**
This is the most important failure to recognize. Bobbit only skips its own auth when bound to a loopback literal. Check `bobbit.service`'s `ExecStart`:
- It must include `--host 127.0.0.1` (not `0.0.0.0`, not `::`).
- It must **not** include `--auth` (that sets `forceAuth` and exits localhost mode).
Confirm what is actually running and what it bound to:
```bash
systemctl --user cat bobbit.service | grep ExecStart
journalctl --user -u bobbit.service | grep -i 'listening\|host'
```
Fix the unit, `systemctl --user daemon-reload`, `systemctl --user restart bobbit.service`.

**SELinux denials on the mounted config (cloudflared can't read `config.yml`).**
The host is enforcing; the mount must be relabeled. The quadlet uses `Volume=%h/.config/cloudflared:/etc/cloudflared:ro,Z` (`Z` = private relabel). If you changed it or copied files in after the relabel, look for AVC denials and re-check:
```bash
sudo ausearch -m AVC -ts recent     # look for denials referencing .config/cloudflared
ls -lZ ~/.config/cloudflared/        # files should carry a container_file_t-style label after :Z mount
```
Restart the service to re-apply the relabel: `systemctl --user restart cloudflared.service`.

**Checking logs generally.**
```bash
systemctl --user status bobbit.service cloudflared.service
journalctl --user -u bobbit.service -e
journalctl --user -u cloudflared.service -e
podman logs systemd-cloudflared      # the quadlet-managed container
```

---

## 8. Teardown

Stop and disable both services, then remove the units and (optionally) the tunnel:

```bash
# Stop + disable the services
systemctl --user disable --now bobbit.service cloudflared.service

# Remove the installed units
rm -f ~/.config/systemd/user/bobbit.service
rm -f ~/.config/containers/systemd/cloudflared.container
systemctl --user daemon-reload

# Delete the tunnel (and its DNS route) from Cloudflare
cloudflared tunnel delete bobbit-z13

# Optional: stop services starting at boot for this user
loginctl disable-linger "$USER"
```

You may also delete the Access application from the Zero Trust dashboard and remove `~/.config/cloudflared/` (config + credentials). The repo artifacts under `deploy/cloudflare/` are templates only and can stay.

---

## See also

- [`deploy/cloudflare/`](../deploy/cloudflare/) — the artifacts (`config.yml.example`, `cloudflared.container`, `bobbit.service`, `setup.sh`).
- [`docs/design/cloudflare-tunnel.md`](design/cloudflare-tunnel.md) — design rationale, decisions, and file-by-file spec.
- [Networking](networking.md) — how Bobbit binds, TLS defaults, and other remote-access options.

# Cloudflare Tunnel deployment

This runbook exposes a single-host Bobbit instance publicly through a **Cloudflare Tunnel**, with **Cloudflare Access (Zero Trust)** as the *only* authentication gate. It is written for the reference host `maciekm-z13` (Fedora Silverblue, rootless Podman, toolbox-based dev env) but applies to any Silverblue-style host.

All deployment artifacts referenced here live in [`deploy/cloudflare/`](../deploy/cloudflare/). The full design rationale is in [`docs/design/cloudflare-tunnel.md`](design/cloudflare-tunnel.md); this page is the reproducible operator runbook.

> **Follow the sections in order.** Section 2 (edge TLS) and Section 3 (host Node) are the two most likely failure points and must be settled **before** you touch any of the plumbing.

> **Prefer a guided install?** `npm run setup-cloudflare-tunnel` (Section 5) walks you through the host-side setup interactively — dependency checks, hostname/runtime/port prompts, scaffolding `~/.config/cloudflared/config.yml`, and installing the units — then prints the manual Cloudflare-panel steps. It surfaces the two key decisions below (edge TLS in Section 2, host Node in Section 3) as prompts/warnings rather than deciding for you, so read those sections first.

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

**Recommended default: use the first-level hostname `bobbit-z13.maciej.dev`** — it is covered for free by Cloudflare Universal SSL and needs no paid add-on. The deploy artifacts ship this as their default. The rest of this section explains *why*, and what it costs if you instead need a deeper, second-level name like `bobbit.z13.maciej.dev`.

Per Cloudflare's [Universal SSL documentation](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/): on a **full-setup** zone (Cloudflare is authoritative for the domain — the usual case for a personal domain moved onto Cloudflare nameservers), free Universal SSL covers only the **apex** and **first-level** subdomains (e.g. `maciej.dev` and `www.maciej.dev`). A leaf certificate for a **second-level** name like `bobbit.z13.maciej.dev` (`bobbit` under `z13` under the apex `maciej.dev`) will **not** be issued. The result: after every other piece is correct, the browser still gets a **TLS handshake error at the edge** — because Cloudflare has no cert to present for that host. That is the trap this section exists to steer you around.

**Decide your cert path before any plumbing.** Pick exactly one:

| Option | Cert path | Cost | What to do |
|---|---|---|---|
| **A — first-level hostname** *(recommended default)* | Covered by free Universal SSL on a full-setup zone | **Free** | Use **`bobbit-z13.maciej.dev`** as `<HOSTNAME>` everywhere. This is the artifacts' default — nothing else changes. |
| **B — Total TLS** | Auto-issues certs for all hostnames, including deeper subdomains | Paid (ACM) | Enable Total TLS on the zone; keep `bobbit.z13.maciej.dev`. |
| **C — Advanced Certificate** | Manually scope an ACM cert | Paid (ACM) | Order an advanced cert covering `*.z13.maciej.dev` (or the exact host). |
| **D — partial (CNAME) setup** | Each proxied hostname gets its own cert *regardless of depth* | Free | Only if the zone is/becomes a partial setup — not the assumed topology here. |

All artifacts use a single hostname value, so switching between options is a **one-line change**. The example config ([`config.yml.example`](../deploy/cloudflare/config.yml.example)) defaults to the first-level **`bobbit-z13.maciej.dev`** (option A), and `npm run setup-cloudflare-tunnel` proposes the same default; throughout this runbook that value is written as **`<HOSTNAME>`**. Keeping option A means you are done with TLS for free. If you must use a second-level name like `bobbit.z13.maciej.dev`, first enable Total TLS (option B) or order an Advanced Certificate (option C), then set `<HOSTNAME>` to it in `config.yml`, in the `cloudflared tunnel route dns` command, and in the Access application.

---

## 3. Prerequisites — Node 20+ (the most likely failure point)

Bobbit needs **Node.js 20 or newer**. On Fedora Silverblue the base image ships **no Node**, and the interactive dev environment lives inside a **toolbox** container. `bobbit.service` is a systemd `--user` unit that runs on the host. By default it resolves Node **on the host**, so a host Node is required — **the toolbox Node does NOT count for the default runtime**. You can opt into a toolbox-provided Node instead (see *Runtime selection* below), but the host runtime is the more robust default.

For the default host runtime, `setup.sh` probes for a host Node (it checks `$NODE_BIN_DIR/node`, then `node` on `PATH`) and **fails loudly with remediation text** if none ≥ v20 is found — it never silently falls back to the toolbox. For `RUNTIME=toolbox` it instead probes for `node` ≥ v20 *inside* the named container and fails the same way if it is missing.

### Runtime selection: `RUNTIME=host` (default) vs `RUNTIME=toolbox`

Both `setup.sh` and the interactive `npm run setup-cloudflare-tunnel` accept a `RUNTIME` option that decides where the service finds Node:

- **`RUNTIME=host` (default, recommended).** Node is resolved on the host from `$NODE_BIN_DIR` (default `~/.local/node/bin`) or `PATH`. The unit's `ExecStart` runs `./run` directly (the `<EXEC_PREFIX>` placeholder is empty). Install a host Node by either method below.
- **`RUNTIME=toolbox` (opt-in).** Set `TOOLBOX_CONTAINER=<name>`; `setup.sh` validates Node ≥ 20 *inside* that container and wraps the unit's `ExecStart` in a `toolbox run -c <container> ` prefix (rendered into the `<EXEC_PREFIX>` placeholder), so the service launches `./run` through the toolbox. No host Node install is needed.

  **Why host is the default:** the toolbox runtime couples a long-lived, boot-started `--user` service to the toolbox/Podman container lifecycle and to `XDG_RUNTIME_DIR`, which is fragile at boot (start ordering, runtime-dir availability). It is convenient when you already keep Node only in a toolbox, but the host runtime decouples the service from toolbox and Podman and is the more robust choice for an always-on deployment. The design doc records this trade-off in full ([`docs/design/cloudflare-tunnel.md`](design/cloudflare-tunnel.md)).

The two host-Node install methods below apply to `RUNTIME=host`.

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

> `npm run setup-cloudflare-tunnel` prints these same steps at the end of its run, and — only when the `cloudflared` CLI is installed — offers a strictly opt-in (default **No**) shortcut to run steps 1–3 (`tunnel login` / `create` / `route dns`) for you. Step 4 (the Access application) is **dashboard-only** and is never scripted.

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

## 5. Running the installer

There are two entry points, both **host-only** (they refuse to run inside a toolbox):

- **`npm run setup-cloudflare-tunnel`** — the **recommended** interactive installer ([`setup-tunnel.sh`](../deploy/cloudflare/setup-tunnel.sh)). It guides you through the host-side setup, scaffolds `~/.config/cloudflared/config.yml`, installs the units (by delegating to `setup.sh`), and prints the remaining manual Cloudflare-panel steps.
- **`setup.sh`** — the lower-level, non-interactive engine ([`setup.sh`](../deploy/cloudflare/setup.sh)) that actually renders and installs the units. The interactive command calls it under the hood; you can also run it directly if you would rather hand-manage `config.yml`.

Both are **idempotent** — safe to re-run at any time.

### Quick start: `npm run setup-cloudflare-tunnel` (recommended)

Run it **on the host** (not inside a toolbox):

```bash
flatpak-spawn --host npm run setup-cloudflare-tunnel
# or, from a host shell already:
npm run setup-cloudflare-tunnel
# or invoke the script directly:
bash deploy/cloudflare/setup-tunnel.sh
```

What it does, in order:

1. **Host guard + dependency checks.** Refuses to run inside a toolbox (`$TOOLBOX_PATH` set). Verifies the required host tools — **`podman`**, **`systemctl --user`**, and **`loginctl`** — and aborts if any is missing. `cloudflared` is checked too but only **warns** if absent (it is needed only for the manual steps).
2. **Prompts for configuration** (press Enter to accept each `[default]`):

   | Prompt | Env pre-seed | Default |
   |---|---|---|
   | Public hostname | `CF_HOSTNAME` | `bobbit-z13.maciej.dev` |
   | Cloudflare tunnel name | `TUNNEL_NAME` | `bobbit-z13` |
   | Bobbit loopback port | `PORT` | `3001` |
   | Bobbit source checkout dir | `CHECKOUT_DIR` | git toplevel |
   | Bobbit project cwd | `BOBBIT_CWD` | `CHECKOUT_DIR` |
   | Node runtime (`host`/`toolbox`) | `RUNTIME` | `host` |
   | Toolbox container (only if `RUNTIME=toolbox`) | `TOOLBOX_CONTAINER` | first listed container |
   | Host Node bin dir (only if `RUNTIME=host`) | `NODE_BIN_DIR` | `$HOME/.local/node/bin` |

   Any prompt whose env var is already set is **skipped** (the value is echoed as "from env"). Pass **`--yes`** / **`-y`** (or `ASSUME_DEFAULTS=1`) to accept every default without prompting, and **`--help`** / **`-h`** to print usage and exit with no side effects.
3. **Warns on a 2nd-level subdomain.** If the hostname looks like a 2nd-level (or deeper) name — the free Universal SSL caveat from Section 2 — it prints the warning and asks you to confirm before continuing (declining aborts). Non-interactively the warning is advisory only.
4. **Scaffolds `~/.config/cloudflared/config.yml`** from [`config.yml.example`](../deploy/cloudflare/config.yml.example) with your chosen hostname and port substituted, leaving `<TUNNEL_ID>` as a placeholder (the tunnel does not exist yet). If a `config.yml` already exists it prompts before overwriting.
5. **Installs the units by delegating to `setup.sh`**, passing your answers through as `CHECKOUT_DIR`, `BOBBIT_CWD`, `NODE_BIN_DIR`, `RUNTIME`, `TOOLBOX_CONTAINER`, and `PORT`. `setup.sh` performs the authoritative Node ≥ 20 probe (host or toolbox — see Section 3), renders the units, reloads systemd, enables linger, and starts both services.
6. **Prints the remaining manual Cloudflare-panel steps** (Section 4) — `tunnel login`, `create`, `route dns`, the **Access application** (panel-only), and wiring the credentials JSON + `<TUNNEL_ID>` into `config.yml`.
7. **Optional, strictly opt-in:** if the `cloudflared` CLI is installed, it offers (default **No**) to run `cloudflared tunnel login` / `create` / `route dns` for you right then. It **never** runs the Access-application step — that is dashboard-only and cannot be scripted.

### `setup.sh` — the non-interactive engine

[`setup.sh`](../deploy/cloudflare/setup.sh) does the non-interactive plumbing and is the single source of truth for rendering and installing the units. The interactive command above calls it; run it directly when you prefer to manage `config.yml` yourself. Run it **on the host** (it is not allowed inside a toolbox):

```bash
flatpak-spawn --host deploy/cloudflare/setup.sh
# or, from a host shell already:
deploy/cloudflare/setup.sh
```

It is **idempotent** — safe to re-run at any time. What it does:

- **Toolbox guard.** If `$TOOLBOX_PATH` is set it refuses to run and prints the `flatpak-spawn --host` invocation. (The units must be installed into the *host's* config dirs, not the toolbox's.)
- **Node probe (host or toolbox).** For `RUNTIME=host` (default) it verifies a host `node` ≥ v20 (checks `$NODE_BIN_DIR/node`, then `node` on `PATH`); for `RUNTIME=toolbox` it verifies `node` ≥ v20 *inside* `$TOOLBOX_CONTAINER`. On failure it prints the matching remediation and exits non-zero — see Section 3.
- **Installs the two units**, substituting placeholders into `bobbit.service` via a temp file (the repo template is never edited in place) — including `<PORT>` and `<EXEC_PREFIX>` (empty for the host runtime, `toolbox run -c <container> ` for the toolbox runtime):
  - `~/.config/systemd/user/bobbit.service`
  - `~/.config/containers/systemd/cloudflared.container` (the Podman generator turns this into `cloudflared.service` on `daemon-reload`)
- **`systemctl --user daemon-reload`**, then **`loginctl enable-linger "$USER"`** so the services run at boot and survive logout.
- **Enables and starts both services**: `systemctl --user enable --now bobbit.service`, then `systemctl --user start cloudflared.service`. If `cloudflared` fails to start because the real `config.yml`/credentials aren't in place yet, it prints a warning telling you to complete the Section 4 steps and re-run the start.
- **Echoes the remaining manual Cloudflare steps** (Section 4) with exact commands and a `systemctl --user status` hint.

#### Environment overrides

`setup.sh` honors these env vars (it derives sensible defaults otherwise); `npm run setup-cloudflare-tunnel` collects the same values interactively and exports them before calling `setup.sh`:

| Variable | Default | Purpose |
|---|---|---|
| `CHECKOUT_DIR` | `git rev-parse --show-toplevel` | Absolute path to your Bobbit source checkout (sets `WorkingDirectory` + `ExecStart`). |
| `BOBBIT_CWD` | `$CHECKOUT_DIR` | Default agent working directory (`--cwd`); point it at a projects dir if desired. |
| `NODE_BIN_DIR` | `$HOME/.local/node/bin` | Host Node `bin` dir prepended to the unit's `PATH` (host runtime). |
| `PORT` | `3001` | Loopback port Bobbit binds (`--port`) and the ingress `service:` targets. |
| `RUNTIME` | `host` | `host` (default) or `toolbox` — where the service finds Node (see Section 3). |
| `TOOLBOX_CONTAINER` | _(unset)_ | Required when `RUNTIME=toolbox`; the container whose Node runs the service. |
| `EXEC_PREFIX` | _(empty)_ | Prefix prepended to `ExecStart`; set automatically to `toolbox run -c <container> ` for the toolbox runtime (rarely set by hand). |

Example (non-interactive, toolbox runtime, custom port):

```bash
RUNTIME=toolbox TOOLBOX_CONTAINER=fedora-toolbox-39 PORT=3002 \
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
- **Wrong port.** Ingress `service:` must point at the port Bobbit binds — `http://127.0.0.1:3001` by default, or `http://127.0.0.1:<PORT>` if you chose a different `PORT` in the installer (it must match `bobbit.service`'s `--port`).

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

**Re-running the installer.** `setup.sh` and `npm run setup-cloudflare-tunnel` are both idempotent. If a unit drifted or you changed a value (hostname, port, runtime, checkout dir), re-run the installer to re-render and reinstall the units — e.g. `flatpak-spawn --host npm run setup-cloudflare-tunnel` (it will not overwrite an existing `~/.config/cloudflared/config.yml` without asking). Then `systemctl --user daemon-reload` and restart the affected service.

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

- [`deploy/cloudflare/`](../deploy/cloudflare/) — the artifacts (`config.yml.example`, `cloudflared.container`, `bobbit.service`, `setup.sh`, and the interactive `setup-tunnel.sh` behind `npm run setup-cloudflare-tunnel`).
- [`docs/design/cloudflare-tunnel.md`](design/cloudflare-tunnel.md) — design rationale, decisions, and file-by-file spec.
- [Networking](networking.md) — how Bobbit binds, TLS defaults, and other remote-access options.

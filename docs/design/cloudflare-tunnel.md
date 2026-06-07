# Design — Cloudflare Tunnel deploy (`bobbit.z13.maciej.dev`)

Status: design • Goal branch: `goal/cloudflare-tun-7e4d784d` • Host: `maciekm-z13` (Fedora Silverblue, rootless Podman, toolbox-based dev env)

## 1. Problem & objective

Expose this machine's Bobbit instance publicly at **`bobbit.z13.maciej.dev`** through a **Cloudflare Tunnel**, with **Cloudflare Access (Zero Trust)** as the *sole* authentication gate. Deliver reproducible **repo artifacts** (config templates, service units, setup script, runbook). No Bobbit application code changes; the agent does not run interactive Cloudflare login or create live Cloudflare resources.

## 2. Chosen architecture (decided — do not re-litigate)

```
 Browser ──HTTPS──▶ Cloudflare edge ──▶ Access (Zero Trust login) ──▶ Tunnel
                                                                        │ (outbound QUIC/7844)
                                                                        ▼
                                                cloudflared (rootless Podman, Network=host)
                                                                        │ http://127.0.0.1:3001
                                                                        ▼
                                                Bobbit (systemd --user, localhost mode, no token)
```

- **Auth = Cloudflare Access only.** Bobbit runs in **localhost mode** (no Bobbit token); Cloudflare gates everything.
  - Verified in `src/server/server.ts:1039`:
    `const isLocalhostMode = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");`
    When true, the auth check at `server.ts:1087` is skipped (`else if (!isPublicEndpoint && isLocalhostMode)` at `:1121` just mints the convenience cookie).
  - Bobbit MUST launch as `--host 127.0.0.1 --no-tls --port 3001`. Binding to `0.0.0.0`/`::` makes `config.host` non-loopback → `isLocalhostMode` false → Bobbit demands its own bearer token. **Never bind to a wildcard address.**
  - `--no-tls` is technically redundant for a loopback host (`cli.ts` auto-disables TLS for `127.0.0.1` unless `--tls` is explicit) but we pass it explicitly so the intent survives any future default change. Do **not** pass `--auth` (that sets `forceAuth` → exits localhost mode).
- **cloudflared = rootless Podman quadlet** at `~/.config/containers/systemd/cloudflared.container` (image `docker.io/cloudflare/cloudflared`). cloudflared makes only **outbound** connections, so it runs with **`Network=host`** — required so it reaches Bobbit on host **loopback** (`http://127.0.0.1:3001`). Do **not** use `host.containers.internal` (that resolves to the host gateway bridge IP, not loopback; with localhost mode Bobbit only listens on `127.0.0.1`).
- **Bobbit = systemd `--user` service** at `~/.config/systemd/user/bobbit.service`, `Restart=on-failure`, launched via the source-checkout `./run`.
- **`loginctl enable-linger <user>`** so both services start at boot and survive logout.
- **Tunnel config = locally-managed** (`config.yml` + credentials JSON), so ingress lives in-repo as a template.

## 3. KEY RISK 1 — Edge TLS coverage for a second-level subdomain (verify first)

`bobbit.z13.maciej.dev` is a **second-level** subdomain (`bobbit` under `z13` under the apex `maciej.dev`).

**Authoritative source** — Cloudflare Universal SSL docs (https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/, fetched 2026-06-07):
> *"On a **full setup**, Universal SSL certificates cover your root domain (for example, `example.com`) and **first-level subdomains** (for example, `www.example.com`). On a **partial (CNAME) setup**, each proxied subdomain receives its own certificate **regardless of depth**. For full setup zones that need coverage beyond first-level subdomains, use **Total TLS** or **advanced certificates**."*

Implication: if `maciej.dev` is a **full setup** zone (Cloudflare is authoritative for the zone — the usual case for a deSEC-style/personal domain moved onto Cloudflare nameservers), free Universal SSL will **NOT** issue a leaf cert for `bobbit.z13.maciej.dev`. The browser will get a TLS handshake error at the edge even after all plumbing is correct.

**Decision matrix (user picks ONE before any plumbing):**

| Option | Cert path | Cost | Action |
|---|---|---|---|
| **A. First-level hostname** (recommended default) | Use **`bobbit-z13.maciej.dev`** — covered by free Universal SSL on a full setup | Free | Change the hostname everywhere below; nothing else differs |
| **B. Total TLS** | Auto-issues certs for all hostnames incl. deeper subdomains | Paid (ACM) | Enable Total TLS on the zone, keep `bobbit.z13.maciej.dev` |
| **C. Advanced Certificate** | Manually scope an ACM cert to `*.z13.maciej.dev` or the exact host | Paid (ACM) | Order an advanced cert covering the host |
| **D. Partial (CNAME) setup** | Each proxied hostname gets its own cert regardless of depth | Free | Only if the zone is/becomes a partial setup — not the assumed topology |

The runbook documents the hostname as a single **`<HOSTNAME>` placeholder** so switching between A and B/C is a one-line change. The artifacts default the example to `bobbit.z13.maciej.dev` (the goal's literal target) but **the doc leads with this decision and flags option A as the zero-cost fallback.**

## 4. KEY RISK 2 — Node runtime on Silverblue (most likely failure point)

Bobbit needs **Node 20+**. On Fedora Silverblue the interactive dev env lives in a **toolbox** container; the host base image has no Node. The `bobbit.service` runs as a systemd **`--user`** unit *on the host*, so its `ExecStart` must resolve a `node` that exists on the host and is reachable from the unit's minimal environment.

`./run` (read: `run` at repo root) requires `node` on `PATH`; it bootstraps/builds via `npm` if `dist/` is missing or stale, then `exec node dist/server/cli.js`.

**Options considered:**

| Option | How | Verdict |
|---|---|---|
| **Toolbox `node` via `toolbox run` in ExecStart** | `ExecStart=toolbox run --container <name> ./run …` | **Rejected for ExecStart.** Couples the service to toolbox/podman container lifecycle + `XDG_RUNTIME_DIR`; brittle ordering at boot; nested rootless podman (cloudflared quadlet already uses podman). Fine for the *one-time build*, not for a long-lived supervised service. |
| **rpm-ostree layered `nodejs`** | `rpm-ostree install nodejs` → reboot; `node` on system `PATH` | Works, lowest maintenance, survives ostree updates. Cost: layers a package onto the base image + one reboot. Documented as the low-maintenance alternative. |
| **Portable Node tarball under `~/.local`** (recommended default) | Extract official `node-v20.x-linux-x64` to `~/.local/node`; reference it via the unit's `Environment=PATH=%h/.local/node/bin:/usr/bin:/bin` | **Recommended.** No root, no reboot, fully self-contained, lives in the user's home alongside the `--user` service. Decouples the deploy from toolbox and from ostree. |

**Resolution:** `bobbit.service` sets an explicit `Environment=PATH=` that prepends a host Node bin dir (placeholder `<NODE_BIN_DIR>`, default `%h/.local/node/bin`). `setup.sh` probes for a host Node (checks `<NODE_BIN_DIR>/node`, then `command -v node` on the host) and **fails loudly with remediation text** if none ≥ v20 is found — it never silently falls back to toolbox. The runbook documents the portable-Node install (default) and the rpm-ostree alternative.

**Build vs run separation:** The deployment should be **pre-built once** (`npm run build`, which may be done inside the toolbox where the full toolchain lives, or with the host Node). With `dist/` present and fresh, `./run`'s ExecStart path is effectively just `node dist/server/cli.js …` and does not invoke `npm` at boot. The runbook makes the one-time build an explicit manual step so the service start path stays fast and side-effect-free.

## 5. Deliverables — file-by-file spec

All deploy artifacts live under **`deploy/cloudflare/`**. The coder creates exactly these files. No file outside `deploy/cloudflare/`, `docs/`, `README.md`, and `.gitignore` is touched.

### 5.1 `deploy/cloudflare/config.yml.example`

Locally-managed tunnel ingress template. Placeholders in `<ANGLE_BRACKETS>`.

```yaml
# Cloudflare Tunnel — locally-managed config.
# Copy to the host config dir as `config.yml` (NOT committed) and fill placeholders.
#   cp deploy/cloudflare/config.yml.example ~/.config/cloudflared/config.yml
# Obtain <TUNNEL_ID> + credentials JSON via `cloudflared tunnel create` (see runbook).
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json   # path INSIDE the container (see volume mount)

# Bobbit runs in localhost mode on host loopback. Pin to 127.0.0.1 (NOT localhost/::1)
# to avoid flaky IPv6 resolution between cloudflared and Bobbit.
ingress:
  - hostname: bobbit.z13.maciej.dev      # <HOSTNAME> — see TLS decision in the runbook
    service: http://127.0.0.1:3001
    # WebSocket (/ws/*) is upgraded transparently by cloudflared; no extra config needed.
  - service: http_status:404             # catch-all (required last entry)
```

- `credentials-file` is the **in-container** path; the host file is mounted to `/etc/cloudflared/` (§5.2).
- Comment explicitly notes WS support and the `127.0.0.1` (not `localhost`) pin.

### 5.2 `deploy/cloudflare/cloudflared.container`

Rootless Podman **quadlet**. Installed to `~/.config/containers/systemd/cloudflared.container`; the podman systemd generator turns it into `cloudflared.service`.

```ini
[Unit]
Description=Cloudflare Tunnel (cloudflared) for Bobbit
# Best-effort ordering — cloudflared retries the origin, so this is not strictly required.
Wants=bobbit.service
After=bobbit.service network-online.target

[Container]
Image=docker.io/cloudflare/cloudflared:latest
# Outbound-only: host networking lets cloudflared reach Bobbit on 127.0.0.1 loopback.
Network=host
# Host config dir (config.yml + <TUNNEL_ID>.json) mounted read-only with SELinux relabel.
Volume=%h/.config/cloudflared:/etc/cloudflared:ro,Z
Exec=tunnel --no-autoupdate --config /etc/cloudflared/config.yml run
# Keep the image current via `podman auto-update` if the user opts in.
AutoUpdate=registry

[Service]
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Notes for the coder:
- `bobbit.service` here refers to the **user** Bobbit unit; quadlet-generated units and the bobbit user unit share the same `--user` systemd manager, so `Wants=`/`After=bobbit.service` resolve.
- `:ro,Z` — read-only mount + **private** SELinux relabel (enforcing mode). Use `Z` (private), not `z` (shared), since only this container consumes the dir.
- Pin `Image=` tag is `:latest`; runbook notes pinning a digest for reproducibility is optional.
- `Exec=` overrides nothing in the image entrypoint except args — the cloudflare image's entrypoint is `cloudflared`, so `Exec=tunnel … run` becomes `cloudflared tunnel … run`.

### 5.3 `deploy/cloudflare/bobbit.service`

systemd **`--user`** unit. Installed to `~/.config/systemd/user/bobbit.service`.

```ini
[Unit]
Description=Bobbit gateway (localhost mode, fronted by Cloudflare Tunnel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Host Node 20+ on PATH. Default = portable Node under ~/.local/node (see runbook §Node).
# If using rpm-ostree layered nodejs, /usr/bin is already on PATH below.
Environment=PATH=%h/.local/node/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=<CHECKOUT_DIR>
# Localhost mode flags are mandatory — see design §2. Do NOT add --auth or bind to 0.0.0.0.
# ./run prepends `--cwd "$(pwd)"`; the explicit --cwd below wins (later arg) and documents intent.
ExecStart=<CHECKOUT_DIR>/run --host 127.0.0.1 --no-tls --port 3001 --cwd <BOBBIT_CWD>
Environment=BOBBIT_NO_OPEN=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- `<CHECKOUT_DIR>` = absolute path to this Bobbit source checkout. `<BOBBIT_CWD>` = default agent working directory (defaults to `<CHECKOUT_DIR>`; user may point at a projects dir).
- `BOBBIT_NO_OPEN=1` suppresses the auto-`xdg-open` browser launch (`cli.ts` honours this) — pointless and noisy on a headless service.
- `WantedBy=default.target` (not `multi-user.target`) — correct for `--user` units.

### 5.4 `deploy/cloudflare/setup.sh`

Idempotent helper for the **non-interactive** steps. Must run **on the host** (not inside the toolbox). Behaviour:

1. **Guard:** if `$TOOLBOX_PATH` is set, print "run me on the host (e.g. `flatpak-spawn --host deploy/cloudflare/setup.sh`)" and exit 1.
2. **Node probe:** check `<NODE_BIN_DIR>/node` then `command -v node`; require `node -v` ≥ 20. On failure, print the portable-Node and rpm-ostree remediation and exit 1.
3. **Install units (idempotent):**
   - `mkdir -p ~/.config/systemd/user ~/.config/containers/systemd ~/.config/cloudflared`
   - `install -m 0644 deploy/cloudflare/bobbit.service ~/.config/systemd/user/bobbit.service`
   - `install -m 0644 deploy/cloudflare/cloudflared.container ~/.config/containers/systemd/cloudflared.container`
   - Token-substitute `<CHECKOUT_DIR>`/`<BOBBIT_CWD>`/`<NODE_BIN_DIR>` in the installed `bobbit.service` from env vars or sensible defaults (`CHECKOUT_DIR=$(git rev-parse --show-toplevel)`), using a temp file + `mv` (never edit in place destructively).
4. `systemctl --user daemon-reload`
5. `loginctl enable-linger "$USER"` (idempotent; needs no sudo for self).
6. **Enable + start:** `systemctl --user enable --now bobbit.service` and `systemctl --user start cloudflared.service` (quadlet unit is generated on daemon-reload; it has no static `enable` — `WantedBy=default.target` handles boot).
7. **Echo remaining MANUAL Cloudflare steps** (login, create, route dns, Access app, drop real `config.yml` + creds) with the exact commands, and a final `systemctl --user status` hint.

`setup.sh` must be safe to re-run: `install` overwrites, `daemon-reload`/`enable --now` are idempotent, `enable-linger` is a no-op if already enabled. It does **not** run `cloudflared tunnel login/create` or touch live Cloudflare state.

### 5.5 `docs/cloudflare-tunnel.md` (runbook — produced in the documentation gate)

Full runbook. Sections: overview/architecture diagram, **TLS decision (§3) first**, prerequisites (host Node — §4), the six manual Cloudflare steps, `setup.sh` usage, verification (Access login → UI loads → WS session streams), troubleshooting (TLS edge error, WS upgrade blocked, cloudflared can't reach origin, Bobbit asking for a token = not in localhost mode, SELinux denials), and teardown. Linked from `docs/networking.md` and the README docs table.

> The runbook is authored in the **documentation** gate by a docs-writer, not in this design step. This section pins its required structure.

### 5.6 `.gitignore` additions

Append entries so real secrets are never committed (templates stay tracked):

```gitignore
# Cloudflare Tunnel — never commit real tunnel config or credentials.
deploy/cloudflare/config.yml
deploy/cloudflare/*.json
deploy/cloudflare/cert.pem
deploy/cloudflare/*.pem
```

`config.yml.example` is **not** matched (only the exact `config.yml`), so the template stays tracked. Verify with `git status` after adding a dummy `config.yml`.

## 6. Data flow & request lifecycle (for verification)

1. Browser → `https://<HOSTNAME>` → Cloudflare edge presents the leaf cert (must be covered per §3).
2. Cloudflare Access intercepts unauthenticated requests → Zero Trust login → on success sets the `CF_Authorization` cookie scoped to `<HOSTNAME>` → forwards request through the tunnel.
3. cloudflared (host net ns) proxies to `http://127.0.0.1:3001` → Bobbit.
4. Bobbit is in localhost mode → no bearer-token check (`server.ts:1121`); mints its own convenience session cookie and serves the UI/API.
5. UI opens `wss://<HOSTNAME>/ws/...`. The WS handshake carries the `CF_Authorization` cookie (same host) so Access permits the upgrade; cloudflared proxies the upgrade to Bobbit natively. Session output streams.

## 7. Acceptance criteria mapping

| Criterion | How satisfied |
|---|---|
| `https://<HOSTNAME>` shows Access login, then Bobbit UI with valid edge cert | §3 TLS decision + Access app + tunnel ingress |
| Bobbit never prompts for its own token; WS streams | §2 localhost flags + §6 step 4/5 |
| Both services auto-start at boot + recover on failure | `enable-linger` + `WantedBy=default.target` + `Restart=on-failure` on both units |
| No committed secret; templates only | §5.6 `.gitignore`, `git grep` clean, `config.yml.example` placeholders only |
| Runbook reproduces deployment from scratch | `docs/cloudflare-tunnel.md` (§5.5) |

## 8. Task partition (for the implementation gate)

Single coherent artifact set, low conflict surface — one coder task is appropriate:

- **Task IMPL** (coder): create `deploy/cloudflare/{config.yml.example,cloudflared.container,bobbit.service,setup.sh}` exactly per §5.1–5.4, make `setup.sh` executable (`chmod +x`), and append the §5.6 `.gitignore` block. Do **not** write `docs/cloudflare-tunnel.md` (that is the documentation gate) and do **not** modify Bobbit source. Validate `setup.sh` with `bash -n` (syntax) and a dry `--help`/no-op guard path; validate YAML with `yq` if available. Push the branch; team lead merges + signals.
- **Task DOCS** (docs-writer, documentation gate): author `docs/cloudflare-tunnel.md` per §5.5, link from `docs/networking.md` + README docs table.

## 9. Constraints honored

- No Bobbit application code changes (deploy artifacts + docs only).
- Agent does not run interactive Cloudflare login or create live resources — all such steps are documented as manual.
- IPv6: ingress pinned to `127.0.0.1`, never `localhost`/`::1`.
- SELinux enforcing: mounted volumes use `:ro,Z`.
- Secrets hygiene: credentials/`config.yml` git-ignored; templates use placeholders only.
- Runs on the HOST: quadlet → `~/.config/containers/systemd/`; user unit → `~/.config/systemd/user/`; `setup.sh` guards against toolbox execution.

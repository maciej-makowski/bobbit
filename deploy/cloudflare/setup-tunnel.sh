#!/usr/bin/env bash
#
# setup-tunnel.sh — INTERACTIVE, HOST-ONLY entry point for the Bobbit
# Cloudflare Tunnel deployment. This is what `npm run setup-cloudflare-tunnel`
# invokes. It gathers your answers, scaffolds the LOCAL machine config
# (~/.cloudflared/config.yml + the systemd/quadlet units, via setup.sh),
# and prints the remaining manual Cloudflare-panel steps. It does NOT create
# any live Cloudflare resources unless you explicitly opt in at the end.
#
# Idempotent and safe to re-run. Run on the HOST (not inside a toolbox):
#     flatpak-spawn --host npm run setup-cloudflare-tunnel
# or, from a host shell already:
#     npm run setup-cloudflare-tunnel
#     # or directly: bash deploy/cloudflare/setup-tunnel.sh
#
# All prompts accept env-var pre-seeds for non-interactive use:
#     CF_HOSTNAME TUNNEL_NAME PORT CHECKOUT_DIR BOBBIT_CWD
#     RUNTIME(host|toolbox) TOOLBOX_CONTAINER NODE_BIN_DIR
# Pass --yes/-y (or ASSUME_DEFAULTS=1) to accept all defaults without prompting.
#
set -euo pipefail

print_help() {
  cat <<'EOF'
Usage: setup-tunnel.sh [--yes|-y] [--help|-h]

Interactive, host-only installer for the Bobbit Cloudflare Tunnel deployment.
Scaffolds ~/.cloudflared/config.yml and installs the systemd --user +
Podman quadlet units (delegating to setup.sh), then prints the remaining
manual Cloudflare-panel steps. Never creates live Cloudflare resources unless
you explicitly opt in at the end.

Options:
  -y, --yes    Accept all defaults without prompting (same as ASSUME_DEFAULTS=1).
  -h, --help   Print this help and exit (no side effects).

Environment pre-seeds (skip the matching prompt when set):
  CF_HOSTNAME         public hostname            (default bobbit-z13.maciej.dev)
  TUNNEL_NAME         cloudflared tunnel name    (default bobbit-z13)
  PORT                loopback port for Bobbit   (default 3001)
  CHECKOUT_DIR        Bobbit source checkout     (default: git toplevel)
  BOBBIT_CWD          Bobbit project cwd         (default: CHECKOUT_DIR)
  RUNTIME             host | toolbox             (default host)
  TOOLBOX_CONTAINER   toolbox container name     (required when RUNTIME=toolbox)
  NODE_BIN_DIR        host Node bin dir          (default $HOME/.local/node/bin)
EOF
}

# --- Arg parsing (must not have side effects before --help) ----------------
ASSUME_DEFAULTS="${ASSUME_DEFAULTS:-0}"
for arg in "$@"; do
  case "$arg" in
    -h|--help) print_help; exit 0 ;;
    -y|--yes)  ASSUME_DEFAULTS=1 ;;
    *) echo "ERROR: unknown argument: $arg" >&2; print_help >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# cloudflared's DEFAULT dir: `tunnel login` writes cert.pem here and
# `tunnel create` writes <UUID>.json here, and the quadlet mounts it — so the
# credentials are already in the mounted dir with nothing to copy.
CLOUDFLARED_DIR="$HOME/.cloudflared"

# --- Helpers ---------------------------------------------------------------
# ask VARNAME "Prompt text" "default" — leaves VARNAME alone if pre-seeded via
# env; otherwise uses the default (ASSUME_DEFAULTS / no tty) or prompts.
ask() {
  local __name="$1" __prompt="$2" __default="$3" __ans
  if [ -n "${!__name:-}" ]; then
    printf '==> %s = %s (from env)\n' "$__name" "${!__name}"
    return
  fi
  if [ "$ASSUME_DEFAULTS" = "1" ] || [ ! -t 0 ]; then
    printf -v "$__name" '%s' "$__default"
    printf '==> %s = %s (default)\n' "$__name" "$__default"
    return
  fi
  read -rp "$__prompt [$__default]: " __ans || true
  printf -v "$__name" '%s' "${__ans:-$__default}"
}

# confirm "Prompt" "y|n" — returns 0 for yes. Non-interactive uses the default.
confirm() {
  local __prompt="$1" __default="${2:-n}" __ans __hint
  if [ "$__default" = "y" ]; then __hint="[Y/n]"; else __hint="[y/N]"; fi
  if [ "$ASSUME_DEFAULTS" = "1" ] || [ ! -t 0 ]; then
    [ "$__default" = "y" ]
    return
  fi
  read -rp "$__prompt $__hint: " __ans || true
  case "${__ans:-$__default}" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# --- 0. Must run on the host, not inside a toolbox -------------------------
if [ -n "${TOOLBOX_PATH:-}" ]; then
  echo "ERROR: this script must run on the HOST, not inside a toolbox." >&2
  echo "       run on the host: flatpak-spawn --host npm run setup-cloudflare-tunnel" >&2
  exit 1
fi

echo "============================================================================"
echo " Bobbit Cloudflare Tunnel — interactive setup"
echo "============================================================================"

# --- 1. Dependency checks --------------------------------------------------
echo
echo "Checking host dependencies ..."
dep_fail=0

if command -v podman >/dev/null 2>&1; then
  echo "  [OK]      podman ($(command -v podman))"
else
  echo "  [MISSING] podman — required for the rootless cloudflared quadlet." >&2
  dep_fail=1
fi

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  echo "  [OK]      systemctl --user"
else
  echo "  [MISSING] systemctl --user — required to install/run the services." >&2
  dep_fail=1
fi

if command -v loginctl >/dev/null 2>&1; then
  echo "  [OK]      loginctl ($(command -v loginctl))"
else
  echo "  [MISSING] loginctl — required to enable linger (boot persistence)." >&2
  dep_fail=1
fi

HAVE_CLOUDFLARED=0
if command -v cloudflared >/dev/null 2>&1; then
  echo "  [OK]      cloudflared ($(command -v cloudflared))"
  HAVE_CLOUDFLARED=1
else
  echo "  [WARN]    cloudflared CLI not found — only needed for the manual steps."
  echo "            Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
fi

if [ "$dep_fail" -ne 0 ]; then
  echo >&2
  echo "ERROR: one or more required dependencies are missing (see above)." >&2
  exit 1
fi

# --- 2. Gather answers -----------------------------------------------------
echo
echo "Configuration (press Enter to accept the [default]):"

ask CF_HOSTNAME "Public hostname" "bobbit-z13.maciej.dev"
ask TUNNEL_NAME "Cloudflare tunnel name" "bobbit-z13"
ask PORT        "Bobbit loopback port" "3001"

DEFAULT_CHECKOUT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || pwd)"
ask CHECKOUT_DIR "Bobbit source checkout dir" "$DEFAULT_CHECKOUT"
ask BOBBIT_CWD   "Bobbit project cwd"          "$CHECKOUT_DIR"

ask RUNTIME "Node runtime (host|toolbox)" "host"
TOOLBOX_CONTAINER="${TOOLBOX_CONTAINER:-}"
NODE_BIN_DIR="${NODE_BIN_DIR:-}"

if [ "$RUNTIME" = "toolbox" ]; then
  # Suggest the first listed toolbox container as the default, best-effort.
  default_box=""
  if command -v toolbox >/dev/null 2>&1; then
    default_box="$(toolbox list --containers 2>/dev/null | awk 'NR==2 {print $2}')"
  fi
  ask TOOLBOX_CONTAINER "Toolbox container name" "$default_box"
  if [ -z "$TOOLBOX_CONTAINER" ]; then
    echo "ERROR: RUNTIME=toolbox requires a container name (none given/suggested)." >&2
    exit 1
  fi
  # NODE_BIN_DIR is irrelevant for the toolbox runtime (setup.sh forces
  # /usr/bin and prefixes ExecStart with `toolbox run -c <container> `).
  NODE_BIN_DIR="/usr/bin"
else
  RUNTIME="host"
  ask NODE_BIN_DIR "Host Node bin dir" "$HOME/.local/node/bin"
  # Advisory: warn now if no host node is visible, but continue — setup.sh
  # performs the authoritative >=20 probe and hard-fails if still missing.
  if [ ! -x "$NODE_BIN_DIR/node" ] && ! command -v node >/dev/null 2>&1; then
    cat <<EOF
  NOTE: no host 'node' found yet (looked in $NODE_BIN_DIR/node and on PATH).
        Install a Node >= 20 on the HOST before starting the service:

          * Portable tarball (recommended, no root, no reboot):
              mkdir -p "\$HOME/.local"
              curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz \\
                | tar -xJ -C "\$HOME/.local"
              ln -sfn "\$HOME/.local/node-v20.18.0-linux-x64" "\$HOME/.local/node"

          * rpm-ostree layered package (needs a reboot):
              rpm-ostree install nodejs && systemctl reboot

        Continuing — setup.sh will hard-fail later if Node is still missing.
EOF
  fi
fi

# --- 3. Advisory: 2nd-level subdomain TLS caveat ---------------------------
# Heuristic (advisory only): assume a two-label apex (e.g. example.com). A
# first-level subdomain therefore has exactly 2 dots (host.example.com); 3+
# dots means a deeper (2nd-level+) name that free Universal SSL does NOT cover
# on a full-setup zone. Simple and intentionally not a full PSL lookup.
dots="$(printf '%s' "$CF_HOSTNAME" | tr -cd '.' | wc -c)"
if [ "$dots" -ge 3 ]; then
  echo
  echo "  WARNING: '$CF_HOSTNAME' looks like a 2nd-level (or deeper) subdomain."
  echo "           Free Universal SSL on a full-setup zone covers only the apex +"
  echo "           first-level subdomains. This name will need Total TLS or an"
  echo "           Advanced Certificate (paid ACM), or the edge TLS handshake will"
  echo "           fail. A first-level name like bobbit-z13.maciej.dev is free."
  if [ "$ASSUME_DEFAULTS" = "1" ] || [ ! -t 0 ]; then
    echo "           (advisory only; continuing non-interactively)"
  elif ! confirm "Continue with this 2nd-level hostname anyway?" "n"; then
    echo "Aborted. Re-run with a first-level hostname (e.g. bobbit-z13.maciej.dev)." >&2
    exit 1
  fi
fi

echo
echo "Summary:"
echo "  hostname        = $CF_HOSTNAME"
echo "  tunnel name     = $TUNNEL_NAME"
echo "  port            = $PORT"
echo "  checkout dir    = $CHECKOUT_DIR"
echo "  bobbit cwd      = $BOBBIT_CWD"
echo "  runtime         = $RUNTIME${TOOLBOX_CONTAINER:+ (container: $TOOLBOX_CONTAINER)}"
echo "  node bin dir    = $NODE_BIN_DIR"

# --- 4. Scaffold ~/.cloudflared/config.yml ---------------------------------
mkdir -p "$CLOUDFLARED_DIR"
CFG="$CLOUDFLARED_DIR/config.yml"
write_cfg=1
if [ -e "$CFG" ]; then
  if confirm "config.yml already exists at $CFG — overwrite?" "n"; then
    write_cfg=1
  else
    write_cfg=0
    echo "==> keeping existing $CFG (not overwritten)"
  fi
fi

if [ "$write_cfg" = "1" ]; then
  # Substitute the chosen hostname + service port; leave <TUNNEL_ID> as a
  # placeholder (the tunnel is not created yet). Anchored patterns avoid
  # touching the catch-all `service: http_status:404` line.
  sed \
    -e "s|^\( *- hostname: \).*|\1${CF_HOSTNAME}|" \
    -e "s|^\( *service: http://127\.0\.0\.1:\)[0-9][0-9]*|\1${PORT}|" \
    "$SCRIPT_DIR/config.yml.example" > "$CFG"
  echo "==> wrote $CFG (hostname=$CF_HOSTNAME, port=$PORT; <TUNNEL_ID> left as a placeholder)"
fi

# --- 5. Install units via the existing engine (single source of truth) -----
echo
echo "==> installing local units via setup.sh ..."
export CHECKOUT_DIR BOBBIT_CWD NODE_BIN_DIR RUNTIME TOOLBOX_CONTAINER PORT
bash "$SCRIPT_DIR/setup.sh"

# --- 6. Remaining MANUAL Cloudflare steps ----------------------------------
cat <<EOF

============================================================================
 Local setup done. REMAINING MANUAL Cloudflare steps (run on the host):
============================================================================
 1. Authenticate to your zone (opens a browser):
        cloudflared tunnel login
 2. Create the tunnel (prints a <TUNNEL_ID> and writes a credentials JSON):
        cloudflared tunnel create $TUNNEL_NAME
 3. Route DNS (proxied CNAME -> <id>.cfargotunnel.com):
        cloudflared tunnel route dns $TUNNEL_NAME $CF_HOSTNAME
 4. Zero Trust dashboard -> Access -> Applications: add a self-hosted app for
    $CF_HOSTNAME with an allow policy (e.g. your owner email).
    This is the ONLY authentication layer (panel-only; cannot be scripted here).
 5. Set the tunnel ID in the config (the credentials JSON is already in
    $CLOUDFLARED_DIR from step 2 — nothing to copy):
        # set the <TUNNEL_ID> printed by step 2 in:
        \$EDITOR $CFG
 6. (Re)start the tunnel and check status:
        systemctl --user start cloudflared.service
        systemctl --user status bobbit.service cloudflared.service
============================================================================
EOF

# --- 7. Optional opt-in: run the cloudflared CLI steps now -----------------
# Strictly opt-in (default No). Never runs the Access-dashboard step (panel
# only). Only offered when the cloudflared CLI is installed.
if [ "$HAVE_CLOUDFLARED" = "1" ]; then
  echo
  if confirm "Run 'cloudflared tunnel login / create / route dns' now?" "n"; then
    echo "==> cloudflared tunnel login"
    cloudflared tunnel login
    echo "==> cloudflared tunnel create $TUNNEL_NAME"
    cloudflared tunnel create "$TUNNEL_NAME" || true
    echo "==> cloudflared tunnel route dns $TUNNEL_NAME $CF_HOSTNAME"
    cloudflared tunnel route dns "$TUNNEL_NAME" "$CF_HOSTNAME" || true
    echo
    echo "==> Done. Still TODO manually: the Access application (step 4),"
    echo "    setting <TUNNEL_ID> in $CFG (step 5; creds already in"
    echo "    $CLOUDFLARED_DIR), then: systemctl --user start cloudflared.service"
  else
    echo "==> skipped automated cloudflared steps (complete steps 1-6 manually)."
  fi
fi

#!/usr/bin/env bash
#
# setup.sh — idempotent, HOST-ONLY installer for the Bobbit Cloudflare Tunnel
# deployment. Places the systemd --user + Podman quadlet units, enables linger,
# and starts both services. It does the NON-INTERACTIVE bits only; the manual
# Cloudflare steps (login / create / route / Access app) are printed at the end
# and must be performed by you. Safe to re-run.
#
# Run on the HOST (not inside a toolbox):
#     flatpak-spawn --host deploy/cloudflare/setup.sh
# or, from a host shell already:
#     deploy/cloudflare/setup.sh
#
set -euo pipefail

# --- 0. Must run on the host, not inside a toolbox -------------------------
if [ -n "${TOOLBOX_PATH:-}" ]; then
  echo "ERROR: this script must run on the HOST, not inside a toolbox." >&2
  echo "       run on the host: flatpak-spawn --host deploy/cloudflare/setup.sh" >&2
  exit 1
fi

# --- 1. Resolve paths ------------------------------------------------------
CHECKOUT_DIR="${CHECKOUT_DIR:-$(git rev-parse --show-toplevel)}"
BOBBIT_CWD="${BOBBIT_CWD:-$CHECKOUT_DIR}"
NODE_BIN_DIR="${NODE_BIN_DIR:-$HOME/.local/node/bin}"

# Runtime selection: 'host' (default, host-resolved Node) or 'toolbox' (Node
# from a named toolbox container, reached via a `toolbox run -c <c> ` prefix).
RUNTIME="${RUNTIME:-host}"
TOOLBOX_CONTAINER="${TOOLBOX_CONTAINER:-}"
PORT="${PORT:-3001}"
EXEC_PREFIX="${EXEC_PREFIX:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
QUADLET_DIR="$HOME/.config/containers/systemd"
# cloudflared's DEFAULT dir (where `tunnel login`/`create` write cert.pem +
# <UUID>.json). The quadlet mounts this dir, so no credential copying needed.
CLOUDFLARED_DIR="$HOME/.cloudflared"

echo "==> RUNTIME      = $RUNTIME"
echo "==> CHECKOUT_DIR = $CHECKOUT_DIR"
echo "==> BOBBIT_CWD   = $BOBBIT_CWD"
echo "==> PORT         = $PORT"

# --- 2. Validate Node >= 20 for the chosen runtime (fail loudly) -----------
if [ "$RUNTIME" = "toolbox" ]; then
  # Node comes from the toolbox container; ExecStart is prefixed with
  # `toolbox run -c <container> `. PATH still needs a valid dir, so use
  # /usr/bin (the prefix re-enters the container for the actual node).
  if [ -z "$TOOLBOX_CONTAINER" ]; then
    echo "ERROR: RUNTIME=toolbox requires TOOLBOX_CONTAINER to be set." >&2
    exit 1
  fi
  echo "==> TOOLBOX_CONTAINER = $TOOLBOX_CONTAINER"
  TBNODE_MAJOR="$(toolbox run -c "$TOOLBOX_CONTAINER" node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$TBNODE_MAJOR" -lt 20 ]; then
    cat >&2 <<EOF
ERROR: toolbox container '$TOOLBOX_CONTAINER' has no usable Node >= 20
(got major '$TBNODE_MAJOR'). Make sure the container exists and Node is
installed inside it:

  * Create the container (if missing):
      toolbox create $TOOLBOX_CONTAINER
  * Enter it and install Node 20+:
      toolbox enter $TOOLBOX_CONTAINER
      sudo dnf install -y nodejs   # or use nvm / a portable tarball

Then re-run this script.
EOF
    exit 1
  fi
  EXEC_PREFIX="toolbox run -c $TOOLBOX_CONTAINER "
  NODE_BIN_DIR="/usr/bin"
  echo "==> toolbox node OK: container '$TOOLBOX_CONTAINER' (major $TBNODE_MAJOR)"
else
  # host runtime (default): probe a host Node >= 20.
  NODE_BIN=""
  if [ -x "$NODE_BIN_DIR/node" ]; then
    NODE_BIN="$NODE_BIN_DIR/node"
  elif command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  fi

  if [ -z "$NODE_BIN" ]; then
  cat >&2 <<EOF
ERROR: no host 'node' found (looked in $NODE_BIN_DIR/node and on PATH).
Bobbit requires Node.js >= 20 on the HOST (the toolbox Node does not count —
the --user service runs on the host). Install one of:

  * Portable tarball (recommended, no root, no reboot):
      mkdir -p "\$HOME/.local"
      curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz \\
        | tar -xJ -C "\$HOME/.local"
      ln -sfn "\$HOME/.local/node-v20.18.0-linux-x64" "\$HOME/.local/node"
    Then re-run this script (it looks in \$NODE_BIN_DIR = $NODE_BIN_DIR).

  * rpm-ostree layered package (needs a reboot):
      rpm-ostree install nodejs
      systemctl reboot
EOF
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  cat >&2 <<EOF
ERROR: host node at '$NODE_BIN' is major version $NODE_MAJOR; Bobbit needs >= 20.
Install a newer Node (portable tarball into \$HOME/.local/node, or
'rpm-ostree install nodejs' + reboot) and re-run.
EOF
  exit 1
fi
echo "==> host node OK: $NODE_BIN (major $NODE_MAJOR)"
fi

# --- 3. Create target directories ------------------------------------------
mkdir -p "$SYSTEMD_USER_DIR" "$QUADLET_DIR" "$CLOUDFLARED_DIR"

# --- 4. Render & install bobbit.service ------------------------------------
# Substitute placeholders into a temp file, then install. The repo template is
# never edited in place. Use '|' as the sed delimiter (paths contain '/').
TMP_UNIT="$(mktemp)"
trap 'rm -f "$TMP_UNIT"' EXIT
sed \
  -e "s|<EXEC_PREFIX>|$EXEC_PREFIX|g" \
  -e "s|<CHECKOUT_DIR>|$CHECKOUT_DIR|g" \
  -e "s|<BOBBIT_CWD>|$BOBBIT_CWD|g" \
  -e "s|<NODE_BIN_DIR>|$NODE_BIN_DIR|g" \
  -e "s|<PORT>|$PORT|g" \
  "$SCRIPT_DIR/bobbit.service" > "$TMP_UNIT"
install -m 0644 "$TMP_UNIT" "$SYSTEMD_USER_DIR/bobbit.service"
echo "==> installed $SYSTEMD_USER_DIR/bobbit.service"

# --- 5. Install cloudflared quadlet ----------------------------------------
install -m 0644 "$SCRIPT_DIR/cloudflared.container" "$QUADLET_DIR/cloudflared.container"
echo "==> installed $QUADLET_DIR/cloudflared.container"

# --- 6. Reload, enable linger, start services -----------------------------
systemctl --user daemon-reload
loginctl enable-linger "$USER"

systemctl --user enable --now bobbit.service
# cloudflared has no [Install] section reachable via systemctl enable (it is a
# generated unit); start it directly. It will be (re)started at boot via the
# quadlet's WantedBy=default.target once daemon-reload regenerates it.
systemctl --user start cloudflared.service || {
  echo "WARN: cloudflared.service did not start — most likely because" >&2
  echo "      ~/.cloudflared/config.yml + credentials JSON are not in place" >&2
  echo "      yet. Complete the manual Cloudflare steps below, then:" >&2
  echo "        systemctl --user start cloudflared.service" >&2
}

# --- 7. Remaining MANUAL Cloudflare steps ----------------------------------
cat <<EOF

============================================================================
 Non-interactive setup done. REMAINING MANUAL Cloudflare steps (run on host):
============================================================================
 1. Authenticate to the maciej.dev zone (opens a browser):
        cloudflared tunnel login
 2. Create the tunnel (prints a <TUNNEL_ID> and writes a credentials JSON):
        cloudflared tunnel create bobbit-z13
 3. Route DNS (proxied CNAME -> <id>.cfargotunnel.com):
        cloudflared tunnel route dns bobbit-z13 bobbit-z13.maciej.dev
 4. Zero Trust dashboard -> Access -> Applications: add a self-hosted app for
    bobbit-z13.maciej.dev with an allow policy (e.g. your owner email).
    This is the ONLY authentication layer.
 5. Put the config in $CLOUDFLARED_DIR (the credentials JSON is already there
    from step 2 — nothing to copy):
        cp deploy/cloudflare/config.yml.example $CLOUDFLARED_DIR/config.yml
        # edit it: set <TUNNEL_ID> to the UUID from step 2.
 6. (Re)start the tunnel and check status:
        systemctl --user start cloudflared.service
        systemctl --user status bobbit.service cloudflared.service

 NOTE: bobbit-z13.maciej.dev is a FIRST-level subdomain, covered for free by
 Universal SSL. A 2nd-level name like bobbit.z13.maciej.dev is NOT covered on a
 full-setup zone (needs Total TLS / Advanced Cert). See docs/cloudflare-tunnel.md.
============================================================================
EOF

# Bobbit Agent Sandbox Image

Minimal Docker image for running Bobbit agent sessions in a sandboxed environment. When sandbox mode is enabled in Bobbit, agent processes run inside this container with restricted filesystem, network, and credential access.

## Build

Bobbit ships two npm scripts that build this image and tag it `bobbit-agent` (the default `sandbox_image`), one per container runtime:

```bash
npm run sandbox:build:docker   # build with docker
npm run sandbox:build:podman   # build with podman
```

Or build directly:

```bash
docker build -t bobbit-agent docker/
podman build -t bobbit-agent docker/
```

The default image name `bobbit-agent` matches Bobbit's default `sandbox_image` config. Set `SANDBOX_IMAGE=<tag>` to build under a different tag (then point `sandbox_image` in your project settings at it).

**`PI_AGENT_VERSION` build-arg**: the agent CLI version baked into the image. The npm scripts pass `--build-arg PI_AGENT_VERSION=<host-version>` so the container's `pi-coding-agent` matches the gateway's. A direct `docker`/`podman build` without the arg uses the Dockerfile's `ARG PI_AGENT_VERSION` default (a pinned fallback, not necessarily your host version).

**Auto-build vs. manual**: in `sandbox: "docker"` mode the gateway auto-builds the image on startup when it's missing (and rebuilds when the baked agent version drifts from the host's). Under `sandbox: "podman"`, building the image — and installing/configuring rootless Podman — is **your responsibility**, since rootless/SELinux setup is host-specific: run `npm run sandbox:build:podman`. Either way you can trigger a build from Settings → Container Sandbox → "Build Image" button, or via `POST /api/sandbox-image/build` (which uses the project's selected runtime). Restart the server after a manual build so the sandbox pool reloads the image.

## What's Included

- **Node.js 20** (slim base) — runtime for the agent process
- **git** — version control operations
- **curl** — HTTP requests
- **gh CLI** — GitHub CLI for PR creation, issue management, etc.
- **build-essential** — gcc, g++, make for native Node.js module compilation
- **python3** — required by some native module build systems (e.g. node-gyp)
- **ripgrep** — fast file search (used by grep tool)

## Cross-Platform node_modules

When the Bobbit server runs on Windows or macOS but agents run inside Linux containers, the host's `node_modules` contain native addons (esbuild, playwright, etc.) compiled for the wrong platform. The image includes an entrypoint script (`bobbit-entrypoint.sh`) that handles this automatically:

1. **Detection**: On container start, the entrypoint checks if `node_modules` are platform-compatible by testing a known native binary (esbuild).
2. **Install**: If incompatible, runs `npm ci` inside the container to produce Linux-native modules.
3. **Cache**: The result is cached in a Docker named volume (`bobbit-nm-cache-<hash>`) indexed by the `package-lock.json` SHA-256 hash. Only the first container pays the install cost — subsequent containers reuse the cache instantly.
4. **Symlink**: The cached `node_modules` are symlinked into `/workspace/node_modules`, replacing the host's incompatible copy within the container.

This means tests run at full speed in the container regardless of the host OS.

### Cache volumes

Two named Docker volumes are created per project:

| Volume | Purpose |
|---|---|
| `bobbit-nm-cache-<hash>` | Cached Linux-native `node_modules` indexed by lockfile hash |
| `bobbit-npm-cache-<hash>` | npm download cache (speeds up `npm ci`) |

These persist across container restarts and are shared by all pool containers for the same project. To clear the cache:

```bash
docker volume rm bobbit-nm-cache-<hash> bobbit-npm-cache-<hash>
```

## Design

The agent CLI (`@earendil-works/pi-coding-agent`) is installed **inside** the image — bind-mounting `node_modules` from a Windows/macOS host into a Linux container is ~20× slower than a native layer. The version is pinned to a build-arg and stamped onto the image as a `bobbit.pi-agent-version` label:

```dockerfile
ARG PI_AGENT_VERSION=0.74.0
RUN npm install -g @earendil-works/pi-coding-agent@${PI_AGENT_VERSION} ...
LABEL bobbit.pi-agent-version=${PI_AGENT_VERSION}
```

At startup the gateway reads its own `pi-coding-agent` version from `node_modules`, compares it to the image's `bobbit.pi-agent-version` label, and rebuilds automatically when they drift — passing `--build-arg PI_AGENT_VERSION=<host-version>` so the image always matches the gateway. See `src/server/agent/sandbox-status.ts::ensureImageAgentVersion`.

This ensures:
- The container always uses the **same agent version** as the gateway
- Fast filesystem access for the agent runtime (no cross-OS bridge)
- No version drift between sandboxed and non-sandboxed sessions

Project `node_modules` (the project's own dependencies used for builds and tests) are handled separately by the entrypoint's cross-platform cache.

Bobbit handles all mount and environment configuration automatically when launching sandboxed sessions.

## Security

- **Non-root execution**: Runs as the `node` user (uid=1000), not root. Files created in the bind-mounted workspace are owned by uid=1000 on the host, matching typical developer user IDs. A container escape does not grant host root access.
- **No Docker socket**: The Docker socket (`/var/run/docker.sock`) is never mounted. The container cannot control Docker or escape to the host.
- **Network control**: Containers run on a dedicated Docker bridge network (`bobbit-sandbox-net`) with direct outbound internet access. Inter-container communication is disabled (`enable_icc=false`). Cloud metadata endpoints (`metadata.google.internal`, `metadata.internal`) are blackholed via `--add-host` entries. The gateway is reachable via `host.docker.internal`. `web_search` and `web_fetch` use direct `curl` from inside the container.
- **Filesystem isolation**: The container only sees the project directory (`/workspace`), the agent modules (`/node_modules`, read-only), and tool extensions (`/tools`, read-only). Host directories like `~/.ssh`, `~/.aws`, and `~/.config` are not accessible.
- **Credential isolation**: Only explicitly configured `sandbox_credentials` environment variables are passed into the container.

## Customization

To add additional packages, extend the Dockerfile:

```dockerfile
FROM bobbit-agent

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    your-package-here \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
USER node
```

To use a different base image (e.g. for a different Node.js version):

```dockerfile
FROM node:22-slim

# Copy the same setup from the original Dockerfile...
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential python3 ripgrep \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && apt-get clean

# Cross-platform entrypoint
COPY entrypoint.sh /usr/local/bin/bobbit-entrypoint.sh
RUN chmod +x /usr/local/bin/bobbit-entrypoint.sh

USER node
RUN git config --global core.autocrlf true
RUN mkdir -p /home/node/.npm-cache /home/node/.node_modules_cache
ENV npm_config_cache=/home/node/.npm-cache
WORKDIR /workspace

ENTRYPOINT ["bobbit-entrypoint.sh"]
CMD ["sleep", "infinity"]
```

After building a custom image, update `sandbox_image` in your Bobbit project settings to point to it.

## Usage

This image is used automatically by Bobbit when sandbox mode is enabled. You do not need to run `docker run` manually. Configure sandbox mode in your project settings:

1. Set **Sandbox Mode** (the single `sandbox` config key) to `docker` or `podman` (`none` disables sandboxing). The same key both enables sandboxing and selects the runtime — there is no separate runtime setting.
2. Make sure the image exists: in `docker` mode it is auto-built on the next server startup if missing; in `podman` mode build it yourself with `npm run sandbox:build:podman`. You can always build manually with `npm run sandbox:build:docker` / `npm run sandbox:build:podman` or the Settings → Container Sandbox → "Build Image" button.
3. Enable the "Sandbox" checkbox when creating a new session

See the main Bobbit documentation for full sandbox configuration options including credentials and additional mounts.

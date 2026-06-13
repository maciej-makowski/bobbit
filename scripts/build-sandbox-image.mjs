#!/usr/bin/env node
/**
 * Build the sandbox container image (`bobbit-agent` by default) via Docker or
 * Podman. Mirrors the server's auto-build behaviour in
 * src/server/agent/sandbox-status.ts (buildSandboxImage / ensureImageAgentVersion /
 * getHostAgentVersion): it bakes the host's pi-coding-agent version into the
 * image via the PI_AGENT_VERSION build-arg, building from docker/Dockerfile.
 *
 * Usage:
 *   node scripts/build-sandbox-image.mjs [docker|podman]
 *
 * Env:
 *   SANDBOX_IMAGE  override image name (default "bobbit-agent")
 *   DRY_RUN        print the command and exit 0 without building
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_RUNTIMES = ["docker", "podman"];

// Repo root: this script lives in <repo>/scripts/.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function fail(message) {
	console.error(`[sandbox-build] ${message}`);
	process.exit(1);
}

const runtime = (process.argv[2] || "docker").toLowerCase();
if (!SUPPORTED_RUNTIMES.includes(runtime)) {
	fail(
		`Unsupported runtime "${runtime}". Use one of: ${SUPPORTED_RUNTIMES.join(", ")}.\n` +
			`  npm run sandbox:build:docker   # build via Docker\n` +
			`  npm run sandbox:build:podman   # build via Podman`,
	);
}

const imageName = process.env.SANDBOX_IMAGE || "bobbit-agent";

/** Resolve the host's installed pi-coding-agent version (same as getHostAgentVersion). */
function getHostAgentVersion() {
	try {
		const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const mainPath = fileURLToPath(mainUrl);
		const pkgPath = path.resolve(path.dirname(mainPath), "..", "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		return pkg.version || null;
	} catch {
		return null;
	}
}

const version = getHostAgentVersion();
if (!version) {
	console.warn(
		"[sandbox-build] Could not resolve @earendil-works/pi-coding-agent version; " +
			"building without PI_AGENT_VERSION build-arg (Dockerfile default).",
	);
}

const buildArgs = [
	"build",
	"-t",
	imageName,
	...(version ? ["--build-arg", `PI_AGENT_VERSION=${version}`] : []),
	"docker/",
];

const printable = `${runtime} ${buildArgs.join(" ")}`;

if (process.env.DRY_RUN) {
	console.log(printable);
	process.exit(0);
}

// Preflight: ensure the runtime binary is on PATH.
const probe = spawnSync(runtime, ["--version"], { stdio: "ignore" });
if (probe.error) {
	if (probe.error.code === "ENOENT") {
		const alt = runtime === "podman" ? "docker" : "podman";
		fail(
			`${runtime} not found on PATH — install ${runtime[0].toUpperCase()}${runtime.slice(1)}, ` +
				`or use \`npm run sandbox:build:${alt}\`.`,
		);
	}
	fail(`Failed to probe ${runtime}: ${probe.error.message}`);
}

console.log(`[sandbox-build] Building ${runtime} image "${imageName}" from docker/Dockerfile...`);
console.log(`[sandbox-build] ${printable}`);

const child = spawn(runtime, buildArgs, { stdio: "inherit", cwd: repoRoot });
child.on("error", (err) => fail(`Failed to run ${runtime}: ${err.message}`));
child.on("exit", (code) => {
	if (code === 0) {
		console.log(
			`[sandbox-build] Image "${imageName}" built successfully. ` +
				`A server restart may be required for the sandbox pool to pick it up.`,
		);
	}
	process.exit(code ?? 1);
});

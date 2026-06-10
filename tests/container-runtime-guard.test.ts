/**
 * Guard test: no spawned-binary "docker" literal anywhere under src/server.
 *
 * Every container CLI invocation must go through a ContainerRuntime instance
 * (whose `bin` lives only in docker-runtime.ts / podman-runtime.ts). A literal
 * like `spawn("docker", …)` / `execFileAsync("docker", …)` bypasses the
 * runtime and breaks podman projects. This scans the source for those call
 * patterns and fails if any reappear.
 *
 * Allowlisted (NOT spawned-binary literals): the `sandbox` enable-value
 * comparisons (`=== "docker"`), the `docker/Dockerfile` build-context path,
 * RuntimeId unions, config defaults, comments, and log/label strings.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..", "src", "server");

/** Recursively collect all .ts files under a directory. */
function collectTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...collectTsFiles(full));
		else if (entry.isFile() && full.endsWith(".ts")) out.push(full);
	}
	return out;
}

// Matches a spawned-binary literal: spawn/spawnSync/spawnTracked/execFile*(
// immediately followed by the string "docker" (single or double quoted).
const SPAWN_DOCKER = /(spawn|spawnSync|spawnTracked|execFile|execFileSync|execFileAsync)\s*\(\s*["']docker["']/;

describe("guard: no spawned-binary \"docker\" literal in src/server", () => {
	it("every container CLI invocation routes through a ContainerRuntime", () => {
		const files = collectTsFiles(SERVER_DIR);
		const offenders: string[] = [];
		for (const file of files) {
			const text = fs.readFileSync(file, "utf-8");
			const lines = text.split("\n");
			lines.forEach((line, i) => {
				if (SPAWN_DOCKER.test(line)) offenders.push(`${path.relative(SERVER_DIR, file)}:${i + 1}: ${line.trim()}`);
			});
		}
		assert.deepEqual(offenders, [], `Found spawned-binary "docker" literals:\n${offenders.join("\n")}`);
	});

	it("verification-harness container exec still routes through spawnTracked (kill-tree)", () => {
		const file = path.join(SERVER_DIR, "agent", "verification-harness.ts");
		const text = fs.readFileSync(file, "utf-8");
		// The container command step must use spawnTracked on the runtime's argv,
		// never `spawn(..., { timeout })` (which can't kill the process tree).
		assert.ok(
			text.includes("spawnTracked(execCmd.file"),
			"verification-harness must spawnTracked the runtime exec command for container steps",
		);
		assert.ok(!SPAWN_DOCKER.test(text), "verification-harness must not spawn a literal \"docker\" binary");
	});
});

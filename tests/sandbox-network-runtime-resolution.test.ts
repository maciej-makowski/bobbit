/**
 * Behavioral regression test for the "sandbox: podman still spawns docker" bug.
 *
 * `SessionManager.ensureSandboxNetwork(projectId)` and `cleanupSandboxNetwork()`
 * MUST resolve the container runtime from the SESSION'S PROJECT config — NOT
 * the global default project config store. Before the fix, both called
 * `containerRuntimeFor()` with no `projectId`, falling back to the global
 * default (sandbox=none/docker) and resolving DockerRuntime even for a podman
 * project — hence `spawn docker ENOENT` on `docker network create …`.
 *
 * This pins the resolution by spying on `BaseCliRuntime.prototype.run` (which
 * every CLI call funnels through) and asserting `this.bin` is the project's
 * runtime (`podman` for a podman project, `docker` for a docker project). The
 * static guard test cannot catch wrong-runtime-resolution — only behavior can.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-net-runtime-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { BaseCliRuntime } = await import("../src/server/agent/container-runtime/index.ts");

// Capture each runtime CLI invocation's binary + argv without spawning.
const calls: { bin: string; args: string[] }[] = [];
const originalRun = (BaseCliRuntime.prototype as any).run;

beforeEach(() => {
	calls.length = 0;
	(BaseCliRuntime.prototype as any).run = async function (this: any, args: string[]) {
		calls.push({ bin: this.bin, args });
		return { stdout: "", stderr: "" };
	};
});

afterEach(() => {
	(BaseCliRuntime.prototype as any).run = originalRun;
});

/** Build a SessionManager whose PCM resolves `projectId` → a store with `mode`. */
function makeManager(projects: Record<string, "none" | "docker" | "podman">): any {
	const manager: any = new SessionManager();
	const fakePcm = {
		getOrCreate(projectId: string) {
			const mode = projects[projectId];
			if (mode === undefined) return null;
			return {
				projectConfigStore: {
					// Mirrors ProjectConfigStore.getSandboxRuntime(): podman → podman, else docker.
					getSandboxRuntime: () => (mode === "podman" ? "podman" : "docker"),
				},
			};
		},
		getRegistry() {
			return { list: () => Object.keys(projects).map((id) => ({ id })) };
		},
	};
	manager.projectContextManager = fakePcm;
	return manager;
}

describe("ensureSandboxNetwork resolves runtime from the project config", () => {
	it("creates the network via PODMAN for a podman project", async () => {
		const manager = makeManager({ "proj-podman": "podman" });
		const name = await manager.ensureSandboxNetwork("proj-podman");
		assert.equal(name, "bobbit-sandbox-net");
		const create = calls.find((c) => c.args[0] === "network" && c.args[1] === "create");
		assert.ok(create, "expected a `network create` call");
		assert.equal(create!.bin, "podman", "podman project must use the podman binary");
	});

	it("creates the network via DOCKER for a docker project", async () => {
		const manager = makeManager({ "proj-docker": "docker" });
		await manager.ensureSandboxNetwork("proj-docker");
		const create = calls.find((c) => c.args[0] === "network" && c.args[1] === "create");
		assert.ok(create, "expected a `network create` call");
		assert.equal(create!.bin, "docker", "docker project must use the docker binary");
	});

	it("cleanupSandboxNetwork removes the network across every distinct project runtime", async () => {
		const manager = makeManager({ "proj-podman": "podman", "proj-docker": "docker" });
		await manager.cleanupSandboxNetwork();
		const removals = calls.filter((c) => c.args[0] === "network" && c.args[1] === "rm");
		const bins = new Set(removals.map((c) => c.bin));
		assert.ok(bins.has("podman"), "podman network must be removed via podman");
		assert.ok(bins.has("docker"), "docker network must be removed via docker");
	});
});

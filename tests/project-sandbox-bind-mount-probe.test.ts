/**
 * Regression test for the rootless-podman bind-mount permission fix.
 *
 * A container created WITHOUT `--userns=keep-id` maps the container's `node`
 * user to a host SUBUID that does not own the writable HOST bind mounts
 * (`/home/node/.bobbit/agent/sessions`, `/bobbit-state/*`, …). The agent then
 * dies on `mkdir '/home/node/.bobbit/agent/sessions/…'` (EACCES).
 *
 * `_initContainer()` now write-probes a bind mount as the default (`node`)
 * user on every reconnect/restart path. If the probe throws (EACCES — stale
 * pre-fix container), the container is removed and recreated so the
 * fresh-create path applies `--userns=keep-id`. If the probe succeeds the
 * container is reused as-is.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { ProjectSandbox } = await import("../src/server/agent/project-sandbox.ts");

/** Fake runtime: existing running, non-stale container. `probeWritable`
 * decides whether the bind-mount write-probe (`sh -c "touch … && rm …"`)
 * succeeds. */
function makeFakeRuntime(opts: { probeWritable: boolean }) {
	const runtime: any = {
		bin: "podman",
		async findContainerByLabel() { return "existing-container-id"; },
		async isRunning() { return true; },
		async getContainerImageId() { return "img-sha"; },
		async getImageId() { return "img-sha"; },
		async startContainer() {},
		async removeContainer() {},
		async createContainer() { return "fresh-container-id"; },
		async getResourceLimits() { return null; },
		async exec(_id: string, argv: string[]) {
			// The bind-mount write-probe.
			if (argv[0] === "sh" && (argv[2] ?? "").includes(".bobbit-perm-probe")) {
				if (!opts.probeWritable) throw new Error("EACCES: permission denied");
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		},
	};
	return runtime;
}

/** Install spies on the private lifecycle methods so we can assert recreate
 * vs reuse without triggering fs side effects from the real `_createContainer`. */
function spyLifecycle(sandbox: any) {
	const calls = { remove: 0, create: 0, init: 0 };
	sandbox._removeContainer = async (_id: string) => { calls.remove++; };
	sandbox._createContainer = async () => { calls.create++; sandbox.containerId = "fresh-container-id"; };
	sandbox._ensureWritableSandboxVolumes = async () => {};
	sandbox._runInitSequence = async () => { calls.init++; };
	return calls;
}

describe("ProjectSandbox._initContainer bind-mount write-probe (rootless-podman userns fix)", () => {
	it("RECREATES the container when the bind-mount write-probe throws (EACCES)", async () => {
		const runtime = makeFakeRuntime({ probeWritable: false });
		const sandbox = new ProjectSandbox({
			runtime,
			sandboxMode: "podman",
			projectId: "proj-probe-fail",
			projectDir: "/tmp/does-not-matter",
			repoUrl: "https://example.com/repo.git",
			image: "bobbit-agent",
		});
		const calls = spyLifecycle(sandbox as any);

		await (sandbox as any)._initContainer();

		assert.equal(calls.remove, 1, "stale container must be removed");
		assert.equal(calls.create, 1, "a fresh container (with keep-id) must be created");
		assert.equal(calls.init, 1, "init sequence runs on the fresh container");
		assert.equal(await sandbox.getContainerId(), "fresh-container-id", "must use the recreated container");
	});

	it("REUSES the container when the bind-mount write-probe succeeds", async () => {
		const runtime = makeFakeRuntime({ probeWritable: true });
		const sandbox = new ProjectSandbox({
			runtime,
			sandboxMode: "podman",
			projectId: "proj-probe-ok",
			projectDir: "/tmp/does-not-matter",
			repoUrl: "https://example.com/repo.git",
			image: "bobbit-agent",
		});
		const calls = spyLifecycle(sandbox as any);

		await (sandbox as any)._initContainer();

		assert.equal(calls.remove, 0, "writable container must NOT be removed");
		assert.equal(calls.create, 0, "writable container must NOT be recreated");
		assert.equal(calls.init, 1, "init sequence still runs (idempotent) on reconnect");
		assert.equal(await sandbox.getContainerId(), "existing-container-id", "must reuse the existing container");
	});
});

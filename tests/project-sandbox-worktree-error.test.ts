/**
 * Regression test: `createWorktree` must not swallow the first-attempt error.
 *
 * The first `git worktree add <path> -b <branch> <startPoint>` is wrapped in a
 * fallback that retries without `-b`. When BOTH attempts fail, the visible
 * no-`-b` error ("fatal: invalid reference: <branch>") masks the real
 * first-attempt cause (e.g. EPERM / cannot-write-refs from an incompatible
 * userns volume). The thrown error must INCLUDE the first-attempt stderr so the
 * failure is diagnosable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { ProjectSandbox } = await import("../src/server/agent/project-sandbox.ts");

const FIRST_STDERR = "fatal: could not create leading directories of '/workspace-wt/x/.git': Permission denied";
const SECOND_STDERR = "fatal: invalid reference: staff-xyz";

function makeRuntime() {
	const runtime: any = {
		bin: "podman",
		async exec(_id: string, argv: string[]) {
			// worktree-add invocations: first carries `-b`, fallback does not.
			if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "add") {
				if (argv.includes("-b")) {
					const e: any = new Error("worktree add failed");
					e.stderr = FIRST_STDERR;
					throw e;
				}
				const e: any = new Error("worktree add fallback failed");
				e.stderr = SECOND_STDERR;
				throw e;
			}
			// Everything else (mkdir/test/fetch/safe.directory/base-ref) succeeds.
			return { stdout: "", stderr: "" };
		},
	};
	return runtime;
}

describe("ProjectSandbox.createWorktree error surfacing", () => {
	it("throws an error containing the FIRST-attempt stderr when both attempts fail", async () => {
		const runtime = makeRuntime();
		const sandbox: any = new ProjectSandbox({
			runtime,
			sandboxMode: "podman",
			projectId: "wt-err-proj",
			projectDir: "/tmp/does-not-matter",
			repoUrl: "https://example.com/repo.git",
			image: "bobbit-agent",
		});
		// Short-circuit container readiness — no real init.
		sandbox.containerId = "fake-container";
		sandbox.getContainerId = async () => "fake-container";

		await assert.rejects(
			() => sandbox.createWorktree("session/staff-xyz", "staff-xyz", "origin/master"),
			(err: any) => {
				assert.match(err.message, /Permission denied/, "must include the first-attempt stderr");
				assert.match(err.message, /could not create leading directories/, "must include the real first-attempt cause");
				assert.match(err.message, /invalid reference/, "should also include the fallback error for completeness");
				return true;
			},
		);
	});
});

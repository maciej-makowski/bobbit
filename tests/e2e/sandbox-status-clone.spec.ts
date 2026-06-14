/**
 * E2E tests for the `clone` field of GET /api/sandbox-status.
 *
 * When sandboxing is enabled, the status endpoint also resolves HOW the
 * project's git remote is used to clone the repo INSIDE the container
 * (src/server/agent/sandbox-clone-source.ts). The HOST repo's remote is never
 * modified — only the in-container clone URL is derived:
 *   - SSH/scp/git origin → rewritten to https:// (rewritten:true)
 *   - https origin       → cloned as-is (rewritten:false)
 *   - no origin          → bind-mounted + file:// (kind:"mounted")
 *
 * The endpoint resolves against config.defaultCwd (the gateway project dir),
 * so we git-init the harness bobbitDir and set its origin per case. The .git is
 * removed in a finally so we don't leak a repo into sibling specs sharing the
 * worker gateway.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

let _tok: string;
function TOKEN() { if (!_tok) _tok = readE2EToken(); return _tok; }

async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${base()}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

function git(repo: string, ...args: string[]): void {
	execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function initRepo(repo: string): void {
	git(repo, "init");
	git(repo, "config", "user.email", "e2e@bobbit.test");
	git(repo, "config", "user.name", "E2E");
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repo, stdio: "pipe" });
}

function setOrigin(repo: string, url: string | null): void {
	// Drop any existing origin first.
	try { git(repo, "remote", "remove", "origin"); } catch { /* none */ }
	if (url) git(repo, "remote", "add", "origin", url);
}

async function getClone(): Promise<any> {
	const res = await apiFetch("/api/sandbox-status?sandbox=docker");
	expect(res.status).toBe(200);
	const data = await res.json();
	expect(data.configured).toBe(true);
	return data.clone;
}

test.describe("GET /api/sandbox-status clone-source", () => {
	test("surfaces container clone-source for ssh / https / no-origin", async ({ gateway }) => {
		const repo = gateway.bobbitDir;
		try {
			initRepo(repo);

			// 1. SSH (scp-style) origin → rewritten to https for the container.
			setOrigin(repo, "git@github.com:o/r.git");
			let clone = await getClone();
			expect(clone).toBeTruthy();
			expect(clone.kind).toBe("remote");
			expect(clone.rewritten).toBe(true);
			expect(clone.containerCloneUrl).toBe("https://github.com/o/r.git");
			expect(clone.origin).toBe("git@github.com:o/r.git");

			// 2. HTTPS origin → cloned as-is, not rewritten.
			setOrigin(repo, "https://github.com/o/r.git");
			clone = await getClone();
			expect(clone.kind).toBe("remote");
			expect(clone.rewritten).toBe(false);
			expect(clone.containerCloneUrl).toBe("https://github.com/o/r.git");
			expect(clone.origin).toBe("https://github.com/o/r.git");

			// 3. No origin → bind-mounted + file:// clone source.
			setOrigin(repo, null);
			clone = await getClone();
			expect(clone.kind).toBe("mounted");
			expect(clone.rewritten).toBe(false);
			expect(clone.origin).toBeNull();
			expect(String(clone.containerCloneUrl)).toMatch(/^file:\/\//);
		} finally {
			rmSync(join(repo, ".git"), { recursive: true, force: true });
		}
	});

	test("omits clone when sandbox is disabled", async () => {
		const res = await apiFetch("/api/sandbox-status?sandbox=none");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.configured).toBe(false);
		expect(data.clone).toBeUndefined();
	});
});

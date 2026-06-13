/**
 * Contract test for the Docker sandbox clone-source resolver.
 *
 * `resolveSandboxCloneSource()` decides what `git clone` uses *inside* the
 * Linux sandbox container. It must NEVER emit a raw host path as the clone URL
 * (a Windows drive-letter path like `C:/Users/...` is misparsed by git as
 * scp/SSH syntax → `cannot run ssh` / `unable to fork`; any host path is
 * unreachable from inside the container).
 *
 * Invariants this test pins:
 *
 *  - Classification mirrors git's heuristic: a URL scheme OR scp-style
 *    `[user@]host:path` (host not a single drive letter) is a network remote;
 *    everything else is local.
 *  - The bind-mount source is ALWAYS the caller-supplied `mountSourcePath`, never
 *    a path derived from `origin`. This removes the local-origin→mount attack
 *    surface (no in-root symlink can escape, because no `origin`-derived path is
 *    ever mounted).
 *  - A non-empty LOCAL origin THROWS with an actionable `/local path/` message —
 *    a drive-letter origin must be treated as local, never as an scp remote.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveSandboxCloneSource,
	toHttpsCloneUrl,
} from "../src/server/agent/sandbox-clone-source.js";

// A POSIX-style canonical mount source (what the caller's resolveSandboxMountRoot
// returns). Pure resolver — never touches the filesystem, so this need not exist.
const MOUNT_SRC = "/main/repo";

describe("resolveSandboxCloneSource — network remotes", () => {
	it("classifies an https:// origin as a remote (token stripped)", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "https://github.com/foo/bar.git",
			mountSourcePath: MOUNT_SRC,
		});
		assert.deepEqual(result, { kind: "remote", cloneUrl: "https://github.com/foo/bar.git" });
	});

	it("normalizes an scp-style origin with user (git@host:path) to HTTPS", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "git@github.com:foo/bar.git",
			mountSourcePath: MOUNT_SRC,
		});
		assert.equal(result.kind, "remote");
		// ssh is unavailable in the container → scp remotes are rewritten to HTTPS
		// so the in-container credential helper can authenticate.
		assert.equal(result.cloneUrl, "https://github.com/foo/bar.git");
	});

	it("normalizes an scp-style origin WITHOUT user (host:path) to HTTPS", () => {
		// A host-without-user scp remote must not be misclassified as local.
		const result = resolveSandboxCloneSource({
			originUrl: "github.example.com:team/repo.git",
			mountSourcePath: MOUNT_SRC,
		});
		assert.equal(result.kind, "remote");
		assert.equal(result.cloneUrl, "https://github.example.com/team/repo.git");
	});

	it("normalizes an ssh:// origin to HTTPS", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "ssh://git@host/foo.git",
			mountSourcePath: MOUNT_SRC,
		});
		assert.equal(result.kind, "remote");
		assert.equal(result.cloneUrl, "https://host/foo.git");
	});
});

describe("toHttpsCloneUrl — SSH/scp/git remotes are normalized to HTTPS", () => {
	for (const [input, expected] of [
		["git@github.com:o/r.git", "https://github.com/o/r.git"],
		["ssh://git@github.com/o/r.git", "https://github.com/o/r.git"],
		["ssh://git@host:2222/o/r.git", "https://host/o/r.git"],
		["git+ssh://git@github.com/o/r.git", "https://github.com/o/r.git"],
		["git://github.com/o/r.git", "https://github.com/o/r.git"],
		["https://github.com/o/r.git", "https://github.com/o/r.git"],
		["http://github.com/o/r.git", "http://github.com/o/r.git"],
	] as const) {
		it(`${input} → ${expected}`, () => {
			assert.equal(toHttpsCloneUrl(input), expected);
		});
	}
});

describe("resolveSandboxCloneSource — absent origin (mount the supplied source)", () => {
	for (const [label, originUrl] of [
		["undefined", undefined],
		["null", null],
		["empty string", ""],
	] as const) {
		it(`mounts mountSourcePath when origin is ${label}`, () => {
			const result = resolveSandboxCloneSource({ originUrl, mountSourcePath: MOUNT_SRC });
			assert.equal(result.kind, "mounted");
			assert.equal((result as { hostPath: string }).hostPath, MOUNT_SRC);
			assert.equal((result as { mountPath: string }).mountPath, "/workspace-src");
			assert.equal(result.cloneUrl, "file:///workspace-src");
		});
	}

	it("NEVER emits a raw host path or drive-letter as the clone URL", () => {
		const mountSourcePath = process.platform === "win32" ? "C:/Users/jsubr/proj" : "/home/dev/proj";
		const result = resolveSandboxCloneSource({ originUrl: undefined, mountSourcePath });
		assert.notEqual(result.cloneUrl, mountSourcePath);
		assert.ok(
			!/^[A-Za-z]:/.test(result.cloneUrl),
			`cloneUrl must not be a Windows drive-letter path, got: ${result.cloneUrl}`,
		);
		assert.equal(result.cloneUrl, "file:///workspace-src");
	});

	it("honours a custom mountPath for multi-repo callers", () => {
		const result = resolveSandboxCloneSource({
			originUrl: undefined,
			mountSourcePath: MOUNT_SRC,
			mountPath: "/workspace-src/web",
		});
		assert.equal(result.kind, "mounted");
		assert.equal((result as { mountPath: string }).mountPath, "/workspace-src/web");
		assert.equal(result.cloneUrl, "file:///workspace-src/web");
		assert.equal((result as { hostPath: string }).hostPath, MOUNT_SRC);
	});
});

describe("resolveSandboxCloneSource — local origins throw (never mounted, never remote)", () => {
	for (const [label, origin] of [
		["file:// URL", "file:///tmp/x.git"],
		["POSIX absolute path", "/abs/x.git"],
		["relative path", "./rel"],
		["Windows drive-letter path", "C:/Users/x.git"],
	] as const) {
		it(`throws with a /local path/ message for a ${label}`, () => {
			assert.throws(
				() => resolveSandboxCloneSource({ originUrl: origin, mountSourcePath: MOUNT_SRC }),
				/local path/,
			);
		});
	}

	it("does NOT classify a drive-letter origin as an scp remote", () => {
		// A bare drive-letter path must be treated as a local path (→ throw),
		// never as an scp `host:path` remote (single-letter host).
		let result: unknown;
		assert.throws(
			() => {
				result = resolveSandboxCloneSource({
					originUrl: "C:/Users/jsubr/foo.git",
					mountSourcePath: MOUNT_SRC,
				});
			},
			/local path/,
		);
		assert.equal(result, undefined);
	});
});

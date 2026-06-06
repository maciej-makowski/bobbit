/**
 * Shared git-fixture helper for E2E / unit tests.
 *
 * `createGitFixtureRepo` scaffolds a throwaway git repo (init → identity →
 * one commit on `master`), optionally creating lightweight tags and fake
 * `origin/<ref>` remote-tracking refs.
 *
 * IMPORTANT — current (pre-fix) behaviour:
 * This is a FAITHFUL COPY of the non-hermetic fixture sequence currently
 * duplicated in `tests/e2e/ui/base-ref-settings.spec.ts` (`gitInit`) and
 * `tests/e2e/base-ref-api.spec.ts`. It runs every `git` invocation with only
 * `{ cwd }` — NO `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` / `GIT_EDITOR` /
 * `GIT_TERMINAL_PROMPT` isolation and NO `-c tag.gpgsign=false`.
 *
 * On a host whose global git config sets `tag.gpgsign = true` and points
 * `GIT_EDITOR` at an interactive editor, `git tag <name>` becomes a
 * signed/annotated tag that needs a message → git launches the editor →
 * blocks forever, keeping the parent (Playwright worker) event loop alive
 * after teardown. That is the E2E exit-hang root cause this helper is meant
 * to reproduce. The implementation gate will make this helper hermetic; do
 * NOT add isolation here.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitFixtureOptions {
	/** Tag names to create (lightweight on a clean host; the hang trigger). */
	tags?: string[];
	/** Fake `origin/<ref>` remote-tracking refs to write under `.git`. */
	remoteRefs?: string[];
}

/**
 * Create a throwaway git repo at `dir`, mirroring the current E2E fixtures.
 *
 * Deliberately non-hermetic: each `git` call inherits the ambient environment
 * (global/system git config, `GIT_EDITOR`, …). See the file header.
 */
export function createGitFixtureRepo(dir: string, opts?: GitFixtureOptions): void {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
	execFileSync("git", ["checkout", "--quiet", "-b", "master"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "x\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: dir });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
	for (const t of opts?.tags ?? []) {
		execFileSync("git", ["tag", t], { cwd: dir });
	}
	for (const r of opts?.remoteRefs ?? []) {
		const refPath = join(dir, ".git", "refs", "remotes", "origin", r);
		mkdirSync(join(refPath, ".."), { recursive: true });
		writeFileSync(refPath, head + "\n");
	}
}

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "**/*.spec.ts",
	// `lsp/**` are node:test runner specs (see docs/design/lsp-code-intelligence.md §9.1)
	// — they don't register Playwright tests and one of them mutates process.cwd via
	// node:test `before()` hooks, which leaks into other workers' top-level `path.resolve`
	// calls (e.g. tests/abort-and-focus.spec.ts) when Playwright auto-loads them.
	testIgnore: ["e2e/**", "fullstack/**", "manual-integration/**", "lsp/**", "compaction.spec.ts"],
	timeout: 15_000,
	fullyParallel: true,
	// CI runners are noisier than dev machines; a couple of retries absorb the
	// occasional FS-contention / cold-start flake without masking real failures.
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 2 : "50%",
});

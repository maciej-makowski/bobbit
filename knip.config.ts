import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'src/server/cli.ts',
    'src/server/harness.ts',
    'src/server/harness-signal.ts',
    'src/server/watchdog.ts',
    'src/ui/index.ts',
    'scripts/*.mjs',
    // .ts scripts (e.g. scripts/get-cert.ts → acme-client) aren't matched by *.mjs.
    'scripts/*.ts',
    // Vite configs pull in build-only deps (rollup-plugin-visualizer in the profile config).
    'vite.config.ts',
    'vite.profile.config.ts',
    'tests/**/*.spec.ts',
    'tests/**/*.test.ts',
    // Playwright config files for the real/workflow tiers — knip can't infer these as roots.
    'tests/**/*.config.ts',
    // Root Playwright e2e config + its global hooks. The config lives at repo
    // root (not under tests/) and wires globalSetup/globalTeardown via string
    // paths knip can't statically follow, so list the hook files as explicit
    // roots. (Upstream's e2e restructure removed the variant configs that
    // previously kept these reachable.)
    'playwright-e2e.config.ts',
    'tests/e2e/e2e-global-setup.ts',
    'tests/e2e/e2e-teardown.ts',
    // Standalone tsx harness invoked directly, not from a spec.
    'tests/code-review-e2e.ts',
    // Playwright component-test HTML entrypoints (knip can't see the .html that loads them).
    'tests/fixtures/**/*.ts',
    'tests/ui-fixtures/**/*.ts',
  ],
  project: [
    'src/**/*.ts',
    'scripts/*.mjs',
    'scripts/*.ts',
    'tests/**/*.ts',
  ],
  ignore: [
    '.bobbit/config/**',
    'src/ui/speech-recognition.d.ts',
    'src/app/qrcode.d.ts',
    // pre-existing unreferenced barrels; tracked for separate dead-code cleanup.
    'src/shared/pr-walkthrough/draft.ts',
    'src/shared/pr-walkthrough/index.ts',
    'src/ui/components/pr-walkthrough/index.ts',
    // Upstream-provided e2e helpers not currently wired into the fork after
    // upstream's e2e restructure removed the coverage config; dom-stub is a
    // side-effect DOM shim kept for future UI-in-node tests. Kept identical to
    // upstream (no source drift); revisit wiring on a future sync.
    'tests/e2e/e2e-coverage-teardown.ts',
    'tests/helpers/dom-stub.ts',
  ],
  ignoreDependencies: [
    'playwright', // runtime is pulled in transitively via @playwright/test
    'typebox', // aliased re-export of @sinclair/typebox (vite alias)
    'highlight.js', // transitive; imported directly by the highlight core shim
    'esbuild', // transitive (via vite); imported directly in a spec
  ],
  ignoreBinaries: ['tsx', 'report'],
  ignoreExportsUsedInFile: true,
  ignoreIssues: {
    'src/ui/components/GitStatusWidget.ts': ['exports'],
    'src/ui/components/ToolGroup.ts': ['exports'],
    'src/ui/tools/renderers/GateVerificationLive.ts': ['exports'],
  },
  // Unused exports/types are advisory only (pre-existing surface incl. perf-flag
  // toggles, CPU/profiling diagnostics, STORY_* registry constants and E2E
  // spec-framework helpers). Tighten to 'error' in a dedicated dead-code cleanup.
  // Dead files / unused & unlisted deps / unresolved imports / binaries stay at
  // the default 'error' severity and remain blocking.
  rules: {
    exports: 'warn',
    types: 'warn',
    nsExports: 'warn',
    nsTypes: 'warn',
    enumMembers: 'warn',
    duplicates: 'warn',
  },
};

export default config;

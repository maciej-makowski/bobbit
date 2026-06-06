# Goal-proposal spec lost after navigate-away/back (rehydrate regression)

**Status:** OPEN — quarantined E2E test, tracked for a dedicated follow-up goal.

> **Re-quarantine authorization (audit trail).** This test was re-quarantined
> (`test(...)` → `test.fixme`) as part of the *E2E exit-hang* goal, which has a
> hard constraint: *"Do NOT remove or disable any test without explicit user
> permission."* On **2026-06-06** the human owner was explicitly asked how to
> handle this pre-existing, unrelated failure and **chose to re-quarantine it
> and file a separate goal** for the underlying fix (rather than fix the
> unrelated rehydrate bug inside the exit-hang goal, or leave the suite red).
> The quarantine is therefore covered by explicit user permission; this design
> note is the durable record, and a dedicated follow-up goal carries the fix.
**Quarantined test:** `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts`
(`test.fixme` — the `@repro` "spec body persists after sidebar nav + return").

## Symptom

In a goal-assistant session that has streamed a `propose_goal`, navigating away
to another session and back (the `connectToSession` fast-path — *not* a full
reload) leaves the goal-proposal panel visible but with an **empty spec body**
(`commentable-markdown` renders `_No spec content yet_`). If the user had added
an inline comment, an "orphaned annotations" UI also appears because the
in-memory annotation cache survives but its anchored text does not.

## History

- The bug was originally found, tracked in this design note, and the E2E
  reproducer was quarantined as `test.fixme` (commit `2fdc1420`).
- PR #602 ("Fix goal-proposal spec rehydrate after navigate-away/back")
  re-activated the test and removed this note, treating the bug as fixed.
- The bug has **regressed** (or the #602 fix is incomplete / environment
  sensitive): with #602 present on `master`, the reproducer fails again,
  deterministically, showing the empty placeholder (not a timing flake).

It was invisible for a long time because the full E2E suite hung at worker
teardown and never ran to completion (see the E2E exit-hang fix —
`tests/test-utils/git-fixture.ts` hermetic git fixtures). Once the suite began
exiting cleanly, this pre-existing failure surfaced. Re-quarantining it (rather
than fixing an unrelated UI-state bug inside the exit-hang goal) keeps the two
concerns separate.

## Candidate causes (from the reproducer's own diagnostics — isolate A/B/C)

- **A.** `connectToSession` fast-path (`src/app/.../session-manager.ts`)
  unconditionally `delete state.activeProposals.goal` on switch-back, then the
  WS rehydrate `proposal_update {source:"rehydrate"}` event arrives but its
  fields omit the spec.
- **B.** `syncProposalFormState`'s identity-key guard (`src/app/render.ts`,
  `_proposalInitializedFrom`) keeps `_proposalSpec` stale at `""` because the
  key matches a degenerate empty value.
- **C.** The on-disk proposal draft (`proposal-drafts/<sid>/goal.md`) never
  received the spec written by `propose_goal`, so the rehydrate restores
  `spec=""`.

The quarantined E2E test, when re-activated, prints the rehydrate payload, the
live `state.activeProposals.goal.fields`, and the `_proposalSpec` form-mirror on
failure to pinpoint which of A/B/C applies.

## How to resume

1. Pick up the dedicated follow-up goal for this regression.
2. Re-activate the reproducer: flip `test.fixme(...)` back to `test(...)` in
   `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts`.
3. Use its diagnostics to isolate A/B/C, fix the client-side rehydrate path,
   and confirm the test is green (and stays green across the fast-path, full
   reload, and the inline-comment variant).
4. Server-side rehydrate shape is already pinned by
   `tests/proposal-rehydrate.test.ts`; keep that green too.

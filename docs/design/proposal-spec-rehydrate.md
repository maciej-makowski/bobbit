# Goal-proposal spec body lost after navigate-away/back

Status: **FIXED** (goal `fix-proposal-s-5e10a046`). This doc is the settled
record: symptom, root cause, the fix, and the tests that pin it.

## Symptom (user-visible)

In a goal-assistant session that had streamed a `propose_goal`, navigating to
another session and back — or a full page reload — left the goal-proposal panel
**visible but with an empty spec body**, rendering the placeholder
`_No spec content yet_`. If the user had added an inline comment first, an
"orphaned annotations" UI (`.review-detached` / "… orphaned" re-anchor banner)
also appeared: the in-memory annotation cache survived the round-trip but the
body text it anchored to was gone.

This was a regression. PR #602 fixed it once; it returned on `master` and stayed
hidden for a long time because the full E2E suite hung at worker teardown and
never reached the reproducer. Once the *E2E exit-hang* goal fixed that hang, the
pre-existing failure surfaced and was re-quarantined (`test.fixme`) pending this
goal.

## Root cause — the rehydrate path repopulated the slot but never the form-mirror

A goal-assistant session has **two** server-side stores read back by **two**
client restore paths:

| Store | Written by | Read back by | Restores |
|---|---|---|---|
| Proposal **FILE** (`proposal-drafts/<sid>/goal.md`) | the `propose_goal` tool (server) | `GET /api/sessions/<sid>/proposals` → unified `onProposal` | `state.activeProposals.goal.fields` |
| Goal **DRAFT** (`GET/PUT /api/sessions/<sid>/draft?type=goal`) | client, debounced 300 ms | `restoreGoalDraft` | `state.previewSpec` (+ `previewTitle`, …) |

The goal-**assistant** panel binds its rendered body to **`state.previewSpec`**,
*not* to the slot — `goalPreviewPanel()` → `renderGoalForm({ spec:
state.previewSpec, … })` in `src/app/proposal-panels.ts`, which renders
`<commentable-markdown .markdown=${config.spec || "_No spec content yet_"}>`. So
the on-screen body is exactly `state.previewSpec`, and the placeholder appears
the instant `state.previewSpec === ""`.

Both rehydrate entry points — the `connectToSession` fast-path
(`rehydrateProposalsForSession`) and the full-reload WS
`proposal_update {source:"rehydrate"}` handler — funnel **only** through the
unified `remote.onProposal` callback, which writes
`state.activeProposals.goal.fields` but historically **never touched
`state.previewSpec`** (only the legacy `onGoalProposal`, which runs on the live
streaming path, did). After any rehydrate the slot was correct but the
form-mirror was `""`, so the assistant body showed the placeholder.

The only safety net that could have re-seeded `state.previewSpec` —
`restoreGoalDraft` — was racy: the goal draft is saved on a 300 ms debounce, so
on switch-back/reload the draft PUT often had not landed (`404`), and a stale
debounce timer could even persist a half-populated draft
(`previewSpec:""` over a populated `activeGoalProposal.fields.spec`). The
full-reload variant reproduced with **no draft at all**, proving the
rehydrate→form-mirror gap was independently sufficient.

The candidate causes B (`syncProposalFormState` / `_proposalInitializedFrom`)
and C-as-stated ("proposal file empty") were investigated and ruled out: B
belongs to the non-assistant `goalProposalPanel()` the assistant never renders,
and every diagnostic showed the proposal FILE intact (full spec returned by
`GET …/proposals`).

## The fix

All in `src/app/session-manager.ts` (UI-only; no server change):

1. **Unified `onProposal` form-mirror (primary; covers fast-path + full-reload).**
   The unified callback now mirrors a rehydrated/updated goal proposal's
   `fields.{title,spec,cwd,workflow}` into the goal-assistant form-mirror
   (`state.previewTitle` / `previewSpec` / `previewCwd` / selected workflow),
   gated on `state.assistantType === "goal"` and on the user not having
   hand-edited the field (`!state.previewSpecEdited`, etc.). The spec is
   right-trimmed (`.replace(/\s+$/u, "")`) so the restored body matches the
   pre-nav value byte-for-byte despite the server appending a trailing newline
   when it persists the file. See `src/app/session-manager.ts:1647`. The legacy
   `onGoalProposal` (`src/app/session-manager.ts:1455`) still runs second on the
   live stream and is now idempotent with this.

2. **Goal-draft `serialize()` hardening (defence in depth).** The debounced
   serialize prefers the still-populated `activeProposals.goal.fields` value
   over an empty form-mirror, so a save scheduled before a switch-back can no
   longer persist a corrupt `previewSpec:""` over a live slot. See
   `src/app/session-manager.ts:398`.

3. **Slow-path `!restored` mirror.** When `restoreGoalDraft` misses (404 draft
   on reload), the draft-restore-miss branch mirrors the live goal slot
   (scoped to this session, restored by the WS `proposal_update` broadcast) into
   the form-mirror instead of blanking it. See `src/app/session-manager.ts:2073`.

## Tests (pinning)

- **Browser E2E reproducer** — `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts`,
  re-activated from `test.fixme` to `test`, three `@repro` variants, all green:
  1. `spec body persists after sidebar nav + return` (`connectToSession` fast-path)
  2. `spec body persists after full page reload` (slow-path + WS-auth rehydrate)
  3. `inline comment re-anchors after nav + no orphaned-annotations UI`
     (asserts `.review-detached` never appears)

  These assert only the user-visible contract (rendered `<commentable-markdown>`
  body + absence of orphaned-annotations UI), so they survive future refactors
  of the internal restore path.

- **Client-side unit pins** — `tests/proposal-rehydrate-client.test.ts` (the
  client-restore contract) and `tests/proposal-rehydrate-mirror.test.ts` (the
  two new production paths: the `onProposal` form-mirror and the
  `serialize()` no-empty-over-populated guard).

- **Server-side pin** — `tests/proposal-rehydrate.test.ts` (the rehydrate REST
  payload shape) stays green; the fix is client-only.

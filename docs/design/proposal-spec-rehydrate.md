# Goal-proposal spec body lost after navigate-away/back

Status: **investigation complete — fix pending** (this goal: `fix-proposal-s-5e10a046`)

## Symptom (user-visible)

In a goal-assistant session that has streamed a `propose_goal`, navigating to
another session and back (or a full page reload) leaves the goal-proposal panel
**visible but with an empty spec body** — it renders the placeholder
`_No spec content yet_`. If the user had added an inline comment first, an
"orphaned annotations" UI (`.review-detached` / "… orphaned" re-anchor banner)
also appears because the in-memory annotation cache survives the round-trip but
the text it anchored to is gone.

This is a regression: PR #602 ("Fix goal-proposal spec rehydrate after
navigate-away/back") fixed it once; it is present again on `master`. It was
masked for a long time because the full E2E suite hung at worker teardown and
never reached this spec; once the *E2E exit-hang* goal fixed that hang, the
pre-existing failure surfaced.

## Reproducer

`tests/e2e/ui/proposal-spec-survives-navigate.spec.ts` (browser E2E), three
`@repro` variants, **all red on current `master`**:

1. `spec body persists after sidebar nav + return` — `connectToSession`
   fast-path (cached chatPanel reuse).
2. `spec body persists after full page reload` — slow-path fresh connect +
   WS-auth `proposal_update {source:"rehydrate"}` broadcast.
3. `inline comment re-anchors after nav + no orphaned-annotations UI` —
   fast-path with an inline comment; additionally asserts `.review-detached`
   never appears.

Run:

```
npm run test:e2e:run -- tests/e2e/ui/proposal-spec-survives-navigate.spec.ts --project=browser --reporter=line --retries=0
```

Assertion failure (not infra) matches:

```
rendered markdown after nav-back
```

Each variant dumps a `[DIAG …]` block on failure (rehydrate REST payload, the
on-disk goal draft, the live `state.activeProposals.goal.fields`, and the live
`state.previewSpec` form-mirror) so A/B/C can be isolated from CI logs alone.

## Two independent persistence stores (important background)

A goal-assistant session has **two** server-side stores, read back by **two**
different client restore paths:

| Store | Written by | Read back by | Restores |
|---|---|---|---|
| Proposal **FILE** (`proposal-drafts/<sid>/goal.md`) | the `propose_goal` tool (server) | `GET /api/sessions/<sid>/proposals` → unified `onProposal` | `state.activeProposals.goal.fields` |
| Goal **DRAFT** (`GET/PUT /api/sessions/<sid>/draft?type=goal`) | client, debounced 300 ms | `restoreGoalDraft` | `state.previewSpec` (+ `previewTitle`, slot copy, …) |

The goal-**assistant** panel binds its rendered body to **`state.previewSpec`**,
*not* to the slot:

- `src/app/proposal-panels.ts:746` `goalPreviewPanel()` →
  `renderGoalForm({ spec: state.previewSpec, … })` (`:809`, `:883`)
- `src/app/proposal-panels.ts:704`
  `<commentable-markdown .markdown=${config.spec || "_No spec content yet_"}>`

So the on-screen spec body is exactly `state.previewSpec`, and the placeholder
appears the instant `state.previewSpec === ""`.

## Root cause — verdict: **A** (with a contributing draft-persistence race; **B and C-as-stated are false**)

### Evidence (from the reproducer's `[DIAG]` dumps)

Pre-nav (still on the assistant session, body correct):

```
liveSlotSpec        len 86
statePreviewSpec    len 86      ← correct
renderedMarkdown    len 86
onDiskGoalDraft     __status 404 ← debounced draft PUT has NOT landed yet
```

After fast-path switch-back (body broken):

```
rehydratePayload .fields.spec  = full spec (proposal FILE intact)
liveSlotSpec        len 87       ← slot rehydrated OK
statePreviewSpec    len 0        ← BUG: form-mirror never repopulated
renderedMarkdown    "_No spec content yet_"
onDiskGoalDraft     __status 404 → later becomes { previewSpec:"", activeGoalProposal.fields.spec:87 }
```

After full reload (body broken):

```
rehydratePayload .fields.spec  = full spec (proposal FILE intact)
liveSlotSpec        len 87       ← slot rehydrated OK via WS-auth rehydrate
statePreviewSpec    len 0        ← BUG
onDiskGoalDraft     __status 404 ← draft never persisted before reload
```

### Cause A — the rehydrate path repopulates the slot but never the form-mirror (PRIMARY)

The rendered body is `state.previewSpec`, but **only the legacy
`onGoalProposal` callback ever writes `state.previewSpec`**
(`src/app/session-manager.ts:1436` `if (!state.previewSpecEdited)
state.previewSpec = proposal.spec`). The rehydrate paths do **not** invoke it:

- Fast-path: `connectToSession` resets `state.previewSpec = ""`
  (`src/app/session-manager.ts:1030`), then fire-and-forgets
  `rehydrateProposalsForSession(sessionId)` (`:1110`). That helper
  (`:2629`) dispatches **only** through the unified `remote.onProposal(type,
  fields, …)`, which updates `state.activeProposals[type].fields`
  (`:1568`) and **never touches `state.previewSpec`**.
- Full reload: the WS `proposal_update` handler
  (`src/app/remote-agent.ts:1701-1716`) likewise calls **only**
  `this._onProposal(...)` (`:1710`) — never the legacy `onGoalProposal`.

Net: after any rehydrate, `state.activeProposals.goal.fields.spec` is correct
but `state.previewSpec` is `""`, so the assistant body shows the placeholder.

### Contributing draft-persistence race (a "flavor of C", but NOT "proposal file empty")

The only safety net that *could* restore `state.previewSpec` is
`restoreGoalDraft` (fast-path `src/app/session-manager.ts:1120`; slow-path
`:2023`), which sets `state.previewSpec = draft.previewSpec ?? ""` (`:440`).
It is defeated two ways:

1. **The draft often isn't there yet.** The goal draft is saved on a 300 ms
   debounce (`src/app/session-manager.ts:340-346`, default `:337`); the DIAG
   shows the draft PUT had not landed (`__status 404`) at switch-back/reload
   time, so `restoreGoalDraft` returns `false` and restores nothing.
2. **A stale debounce timer persists a half-populated draft.** The debounce
   `timer` is module-scoped and its `serialize()` reads *current global state*
   at fire time, not the state captured when `save()` was scheduled. When the
   pending save (scheduled while the body was correct on the assistant session)
   finally fires *after* the rehydrate-only switch-back, it serializes
   `activeProposals.goal.fields.spec` = full but `state.previewSpec` = `""` —
   writing the corrupt draft the final DIAG shows
   (`previewSpec:""`, `activeGoalProposal.fields.spec:87`). Even a later restore
   then yields `previewSpec = ""`.

This is a real secondary bug, but it is downstream of A: the full-reload variant
reproduces with **no draft at all** (404), proving the rehydrate→form-mirror gap
(A) is independently sufficient.

### Cause B — FALSE

`syncProposalFormState` / `_proposalInitializedFrom` / `_proposalSpec`
(`src/app/proposal-panels.ts:2075-2099`) belong to the **non-assistant**
goal-proposal panel (`goalProposalPanel()`), which is *not* used for a
goal-assistant session — that path renders `goalPreviewPanel()`
(`src/app/proposal-panels.ts:1981`). The assistant body never reads
`_proposalSpec`, so the identity-key guard is irrelevant to this regression.

### Cause C-as-stated — FALSE

"The on-disk proposal *file* never received the spec" is wrong: every DIAG
shows `GET /api/sessions/<sid>/proposals` returning the full 87-char spec. The
proposal FILE is intact; the gap is the *goal DRAFT*'s `previewSpec` and the
form-mirror, per A above.

## Fix direction (for the implementation task — OUT OF SCOPE here)

Make the rehydrate path repopulate the goal-assistant form-mirror, mirroring
what `onGoalProposal` does, so the rendered body no longer depends on the racy
draft:

- When a goal slot is (re)hydrated for the **active goal-assistant session** and
  the user has not hand-edited (`!state.previewSpecEdited` /
  `!state.previewTitleEdited` / `!state.previewCwdEdited`), mirror
  `fields.spec/title/cwd/workflow` into `state.previewSpec` / `previewTitle` /
  `previewCwd` / selected workflow. Natural homes: the unified `onProposal`
  (`src/app/session-manager.ts:1568`) gated on `state.assistantType === "goal"`,
  or `rehydrateProposalsForSession` (`:2629`) routing goal rehydrates through
  `onGoalProposal` as well as `onProposal`.

Recommended hardening (defence in depth, optional):

- Don't let a debounced goal-draft `serialize()` persist an empty
  `previewSpec` over a populated `activeGoalProposal.fields.spec` (or flush /
  cancel the goal-draft debounce on navigate-away), to stop the corrupt-draft
  write.

Server-side rehydrate shape is already pinned by `tests/proposal-rehydrate.test.ts`
and the client-restore contract by `tests/proposal-rehydrate-client.test.ts`
(both green — keep them green).

## Test plan

- **Reproducing-test gate:** the three `@repro` variants above must be red
  before the fix and green after.
  - `test_command`:
    `npm run test:e2e:run -- tests/e2e/ui/proposal-spec-survives-navigate.spec.ts --project=browser --reporter=line --retries=0`
  - `error_pattern` (assertion, not infra): `rendered markdown after nav-back`
- **Regression pins (must stay green):** `tests/proposal-rehydrate.test.ts`,
  `tests/proposal-rehydrate-client.test.ts`.
- **No new pins on internal state** — the reproducer asserts only the
  user-visible contract (rendered `<commentable-markdown>` body + absence of the
  orphaned-annotations UI), so it survives whichever code path the fix chooses.

## Acceptance criteria (this goal)

1. The three reproducer variants pass across fast-path, full reload, and the
   inline-comment case.
2. The client rehydrate path restores the proposal spec body (and annotations
   re-anchor) after navigate-away/back.
3. `tests/proposal-rehydrate.test.ts` stays green.
4. Once fixed, retire/trim this doc to a short "fixed in <PR>" note.

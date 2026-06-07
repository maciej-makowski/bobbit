# Manual custom providers: per-model metadata (incl. llama-swap)

This documents the per-model metadata capability for **manual** custom providers,
and uses the user's [`llama-swap`](https://github.com/mostlygeek/llama-swap)
instance (13 local models) as the worked example.

## Manual custom-provider model metadata (general)

Bobbit custom providers come in two families:

- **Auto-discovery** (`ollama`, `lmstudio`, `llama.cpp`, `vllm`) — Bobbit fetches
  the model list (and whatever metadata the server exposes) on demand.
- **Manual** (`openai-completions`, `openai-responses`, `anthropic-messages`, and
  the legacy `manual` alias) — the model list is stored on the provider config
  itself, in `models[]`.

Each entry in a manual provider's `models[]` accepts **optional per-model
metadata** so models surface with accurate capabilities in the model selector:

| field | type | default when absent |
|---|---|---|
| `id` | string (required) | — |
| `name` | string | falls back to `id` |
| `contextWindow` | number | `8192` |
| `maxTokens` | number | `4096` |
| `reasoning` | boolean | `false` |
| `input` | `("text" \| "image")[]` | `["text"]` |

Metadata is applied by `mapManualModels()` in
`src/server/agent/model-registry.ts`; invalid numbers fall back to the defaults
and `input` is filtered to the `text`/`image` whitelist. The model's API is
derived from the provider `type` (`openai-responses` → `openai-responses`,
`anthropic-messages` → `anthropic-messages`, otherwise `openai-completions`), and
the registry appends `/v1` to the provider `baseUrl` for the per-model URL.

> **Backward compatibility:** existing manual providers whose models are just
> `{ id, name }` keep working unchanged — the defaults above are applied.

### Discovery-branch fix (`openai-completions`)

The UI saves manual text providers with `type: "openai-completions"` (or
`openai-responses` / `anthropic-messages`). Previously the server registry only
handled the legacy `type: "manual"`, so providers created through the UI fell
through to an empty list and **surfaced zero models**. All four manual text
types now route through the same `mapManualModels()` path. Pinned by
`tests/custom-provider-manual-metadata.test.ts`.

### Setting metadata

The Settings → Providers dialog's model textarea uses the `model-id | Display
name` line format and does not expose the numeric/boolean metadata fields
directly; editing a provider **preserves** any metadata already attached to a
model (matched by `id`), so seeded metadata is not wiped on edit. To seed full
metadata, POST the provider config (with metadata-bearing `models[]`) to
`POST /api/custom-providers` — see the re-seedable snippet below.

---

## Making custom models bindable: the agent `models.json` sync

Registering a custom provider makes its models *appear* in the picker. A
separate mechanism is what makes them *work*: Bobbit syncs each custom provider
into the interactive agent's `~/.bobbit/agent/models.json`. Without this sync,
selecting a custom model silently did nothing — the session kept running on its
previously-bound model (usually Claude). This section explains why, and how the
sync closes the gap.

### Why custom models weren't usable before (the silent-fallback bug)

The interactive agent is a separate `pi-coding-agent` subprocess. It resolves a
model's provider from **two** sources:

1. pi-ai's **built-in provider registry** — cloud providers only (anthropic,
   openai, google, bedrock, groq, …). There is **no** built-in `ollama`,
   `llama.cpp`, `vllm`, or generic `openai-compatible` provider.
2. **`~/.bobbit/agent/models.json`** — the file Bobbit writes to register
   *dynamic* providers the built-ins don't cover.

The WebSocket `set_model` handler forwards only the `(provider, modelId)` pair
to the agent (`src/server/ws/handler.ts`), so the agent must *already know* the
provider. Historically the only writer of a dynamic provider was
`writeAigwModelsJson()` (the AI Gateway). **Nothing wrote custom providers into
`models.json`** — `customProviders` prefs were read for `GET /api/models`,
completion, and image generation, but never handed to the agent.

The agent's RPC `set_model` does a *strict* lookup and returns an error for an
unknown `(provider, modelId)` — it does not fuzzy-match. So every custom local
model was unbindable: the agent couldn't resolve it, and (see the hard-fail
section below) the failure was being swallowed, leaving the session on its old
model. The fix is to **register custom providers in `models.json`** so the
agent's lookup can succeed.

### How the sync works

`src/server/agent/custom-provider-agent-sync.ts` mirrors the AI Gateway pattern.
For each text-capable custom provider it writes a
`providers[<key>]` block into `models.json`:

| field | value | why |
|---|---|---|
| **provider key** | `config.name \|\| config.id` | **Load-bearing invariant** — must equal the `set_model` provider string the WS handler forwards, *and* the `provider` the registry stamps on each `/api/models` entry. If these drift, the agent can't resolve the model. |
| `baseUrl` | the discovered model's `baseUrl` (the `<baseUrl>/v1` form), falling back to `${config.baseUrl}/v1` | Hit the **exact** endpoint `/api/models` advertises, so picker and agent agree. |
| `apiKey` | `config.apiKey?.trim() \|\| "none"` | Local servers need no key; the `"none"` sentinel (same as aigw) still passes the agent's "auth configured" check. |
| `api` | `openai-responses` / `anthropic-messages` / else `openai-completions` | Derived from `config.type`. ollama/lmstudio/llama.cpp/vllm/manual all expose an OpenAI-compatible `/v1` surface → `openai-completions`. |
| `models[]` | from `discoverModelsForConfig(config)` — each `{ id, name, contextWindow, maxTokens, reasoning, input, cost }` | Reuses the **same source `/api/models` uses**, so the agent sees identical metadata (including `input` for vision). |
| `compat` | conservative flags on `openai-completions` models (`maxTokensField: "max_tokens"`, `supportsStore: false`, `supportsReasoningEffort: false`, …) | Local OpenAI-compatible servers rarely implement the full OpenAI surface; these flags stop pi-ai sending fields that commonly `400`. |

Every managed provider object is stamped with `__bobbitManaged:
"custom-provider"`. This marker is what lets the sync clean up after itself
(renames, deletes) **without ever clobbering** the `aigw` entry or the
`amazon-bedrock` / `anthropic` `modelOverrides` that other writers own.

Reads and writes go through `src/server/agent/models-json-store.ts`
(`readModelsJson` / `writeModelsJson` / `getModelsJsonPath`), shared with
`aigw-manager.ts`. All writers use one atomic write-to-temp-then-`rename`
implementation, so concurrent writers (aigw, context-window overrides, OpenAI
additions, custom providers) can never corrupt the file with a partial write.

Image-only providers are skipped — only text-capable provider types produce
agent-bindable models.

### Lifecycle: when the sync runs

| Trigger | Action | Resilience |
|---|---|---|
| `POST /api/custom-providers` (add/update) | Sync that provider, then prune stale managed keys (handles a rename leaving an orphaned old key). | A sync failure logs and continues — it must **never** 500 the save. |
| `DELETE /api/custom-providers/:id` | Remove that provider's managed entry (marker-scoped), then prune. | aigw/bedrock entries are untouched; never 500s the delete. |
| **Startup** (next to `startupAigwCheck`) | Sync all configured custom providers, then prune. Runs **before** session restore so `models.json` is ready before any agent subprocess spawns. | Wrapped in try/catch — never blocks boot. |

**Auto-discovery providers (ollama/lmstudio/llama.cpp/vllm) that are
unreachable:** discovery returns an empty list on fetch failure. When the list
is empty *and* a prior managed entry exists, the sync **keeps the prior entry**
rather than wiping a working configuration, and logs a warning. Manual providers
never fetch, so they sync deterministically regardless of host reachability —
which is why a seeded llama-swap provider binds even when the LAN host is
offline (a live host is only needed to *run* completions).

Pinned by `tests/custom-provider-agent-sync.test.ts` (unit, no network) and
`tests/e2e/custom-provider-bind.spec.ts` (API E2E).

### No silent fallback: hard-fail on an unresolvable model

The original bug had two halves. The first (no registration) is fixed by the
sync above. The second is that the failure was **invisible**: the agent's RPC
`set_model` *resolves* (it does not reject) with `{ success: false, error }`
when a model can't be found. The WS handler used to ignore that response,
persist the new model name, and let subsequent prompts route to the
previously-bound model — the user saw the new model in the UI while Claude
actually answered.

`src/server/ws/handler.ts` now **inspects the response**: a `success === false`
result is thrown as a hard error. The catch block then:

- sends `SET_MODEL_FAILED` to the UI so the failure is visible, and
- does **not** call `persistSessionModel` / `updateModelNameFile`, so the
  session is never left bound to a model the user didn't actually get.

The guarantee: a bind to an unknown/unresolvable `(provider, modelId)` fails
loudly and dispatches **no** prompt to a different model. Pinned by
`tests/e2e/set-model-hardfail.spec.ts`.

### Vision: image-input dispatch for custom providers

Vision-capable custom models (e.g. the `gemma-vision-*` models, whose `input`
includes `image`) work end-to-end once two things hold:

1. **Their `input: ["text", "image"]` capability round-trips** config →
   `/api/models` → picker (so the vision indicator shows and the model is
   selectable) → the synced `models.json` entry (preserved verbatim by the
   sync). The agent reads this `input` to decide, per model, whether to forward
   image parts to the upstream API.
2. **Image dispatch is unconditional.** `SessionManager.enqueuePrompt` →
   `rpc-bridge.prompt()` forwards attached `images` verbatim to the agent
   **regardless** of which provider/model the session is bound to. There is no
   provider-conditional gate that drops images for custom local providers — so
   an attached image actually reaches the local model.

No code change was needed for the dispatch path; the work was verifying it and
pinning it against regression. Covered by
`tests/custom-provider-vision-image-dispatch.test.ts` (dispatch) and
`tests/e2e/custom-provider-vision.spec.ts` (picker visibility + selection).

---

## Example: llama-swap (z13) local models

The rest of this document registers the 13 local models served by the user's
`llama-swap` instance as one manual custom provider, **with accurate per-model
metadata** (context window, reasoning, vision).

## Why a seed snippet instead of auto-discovery

`llama-swap`'s OpenAI-compatible `/v1/models` endpoint returns **bare ids only**
(`id`/`object`/`created`/`owned_by`) — no `context_length`, no capabilities. So
Bobbit's auto-discovery types (`llama.cpp`/`vllm`) would register all 13 models
but with a wrong default 8192 context window, `reasoning: false`, and
`input: ["text"]`. The models are actually 256K/128K context, some are reasoning
models, and the Gemma models accept images.

Instead we register a **manual** provider (`type: "openai-completions"`) whose
`models[]` carry explicit metadata. Bobbit's manual-model discovery branch
(`mapManualModels` in `src/server/agent/model-registry.ts`) uses that metadata
directly, falling back to `8192 / 4096 / false / ["text"]` only when a field is
absent.

> **Do NOT hand-edit the llama-swap config.**
> `~/.local/var/llama-swap/config/llama-swap-z13.yaml` is generated (source of
> truth: `scripts/generate-llama-swap-config.py` in an external dotfiles repo)
> and is out of scope. This Bobbit-side metadata is maintained here.

## Model mapping

| id | name | context | reasoning | vision |
|---|---|---|---|---|
| qwen-coder-medium | Qwen3-Coder 30B MoE | 262144 | no | no |
| qwen-coder-large | Qwen3.6 35B MoE +MTP | 262144 | no | no |
| qwen-coder-xl | Qwen3-Coder-Next 80B hybrid | 262144 | no | no |
| qwen-coder-small | Qwen3.5 9B +MTP | 262144 | no | no |
| qwen-coder-alt | Qwen3.5 35B MoE | 262144 | no | no |
| qwen-thinker-small | Qwen3 1.7B | 262144 | yes | no |
| qwen-thinker-medium | Qwen3 30B MoE | 262144 | yes | no |
| qwen-thinker-xl | Qwen3-Next 80B hybrid | 262144 | yes | no |
| gpt-plan | GPT-OSS 20B MoE | 131072 | yes | no |
| gpt-research | GPT-OSS 120B MoE | 131072 | yes | no |
| gemma-vision-small | Gemma4 E2B | 262144 | no | yes |
| gemma-vision-medium | Gemma4 E4B | 262144 | no | yes |
| gemma-vision-large | Gemma4 26B MoE | 262144 | no | yes |

`vision: yes` ⇒ `input: ["text", "image"]`; otherwise `input: ["text"]`.

## Re-seedable snippet

The snippet below is **idempotent**: `POST /api/custom-providers` upserts by
`id`, so re-running it overwrites the existing `llama-swap-z13` provider with the
canonical metadata. Run it from any directory that contains a `.bobbit/state`
(your gateway working tree). The gateway uses a self-signed cert, so `curl -sk`.

```bash
#!/usr/bin/env bash
set -euo pipefail

TOKEN=$(cat .bobbit/state/token)
GW=$(cat .bobbit/state/gateway-url)

curl -sk "$GW/api/custom-providers" \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "llama-swap-z13",
    "name": "llama-swap (z13)",
    "type": "openai-completions",
    "baseUrl": "http://maciekm-z13.local:9292",
    "models": [
      { "id": "qwen-coder-medium",   "name": "Qwen3-Coder 30B MoE",          "contextWindow": 262144, "reasoning": false, "input": ["text"] },
      { "id": "qwen-coder-large",    "name": "Qwen3.6 35B MoE +MTP",         "contextWindow": 262144, "reasoning": false, "input": ["text"] },
      { "id": "qwen-coder-xl",       "name": "Qwen3-Coder-Next 80B hybrid",  "contextWindow": 262144, "reasoning": false, "input": ["text"] },
      { "id": "qwen-coder-small",    "name": "Qwen3.5 9B +MTP",              "contextWindow": 262144, "reasoning": false, "input": ["text"] },
      { "id": "qwen-coder-alt",      "name": "Qwen3.5 35B MoE",              "contextWindow": 262144, "reasoning": false, "input": ["text"] },
      { "id": "qwen-thinker-small",  "name": "Qwen3 1.7B",                   "contextWindow": 262144, "reasoning": true,  "input": ["text"] },
      { "id": "qwen-thinker-medium", "name": "Qwen3 30B MoE",                "contextWindow": 262144, "reasoning": true,  "input": ["text"] },
      { "id": "qwen-thinker-xl",     "name": "Qwen3-Next 80B hybrid",        "contextWindow": 262144, "reasoning": true,  "input": ["text"] },
      { "id": "gpt-plan",            "name": "GPT-OSS 20B MoE",              "contextWindow": 131072, "reasoning": true,  "input": ["text"] },
      { "id": "gpt-research",        "name": "GPT-OSS 120B MoE",             "contextWindow": 131072, "reasoning": true,  "input": ["text"] },
      { "id": "gemma-vision-small",  "name": "Gemma4 E2B",                   "contextWindow": 262144, "reasoning": false, "input": ["text", "image"] },
      { "id": "gemma-vision-medium", "name": "Gemma4 E4B",                   "contextWindow": 262144, "reasoning": false, "input": ["text", "image"] },
      { "id": "gemma-vision-large",  "name": "Gemma4 26B MoE",               "contextWindow": 262144, "reasoning": false, "input": ["text", "image"] }
    ]
  }'
```

### Notes

- `baseUrl` is `http://maciekm-z13.local:9292` with **no** trailing `/v1`. The
  model registry appends `/v1` when constructing each model's `baseUrl`.
- `maxTokens` is omitted, so it defaults to 4096. Override per model if needed.
- The host (`maciekm-z13.local`) is on the user's LAN and may be offline; the
  provider registers regardless because manual models are never fetched from the
  host. A live host is only needed to actually run completions.
- After seeding, the 13 models appear in the model selector under
  **llama-swap (z13)** with their correct context window and capabilities.

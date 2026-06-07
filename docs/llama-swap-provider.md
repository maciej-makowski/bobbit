# Custom providers: per-model metadata + agent binding (incl. llama-swap)

This documents two related capabilities for custom providers, using the user's
[`llama-swap`](https://github.com/mostlygeek/llama-swap) instance (13 local
models) as the worked example:

1. **Per-model metadata** for **manual** providers, so models surface in the
   picker with accurate capabilities (context window, reasoning, vision).
2. **Binding to the interactive agent**, so selecting a custom model actually
   routes prompts to it instead of silently falling back to Claude.

Metadata controls how a model *appears*; binding controls whether it can actually
*run*. Both are needed for a custom/local model to be usable end-to-end. See
[Binding custom-provider models to the interactive agent](#binding-custom-provider-models-to-the-interactive-agent)
for the binding mechanics.

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

## Binding custom-provider models to the interactive agent

Metadata makes a custom model *appear* correctly in the picker. Binding makes it
actually *run*. Before this fix, selecting a custom/local model (e.g. a
llama-swap `gpt-research`) **silently fell back to the previously-bound model
(Claude)** — the model showed in the picker and you could select it, but every
prompt still went to Claude with no error. This applies to **all** custom
provider types (`ollama` / `lmstudio` / `llama.cpp` / `vllm` and the manual
`openai-completions` / `openai-responses` / `anthropic-messages` families), not
just llama-swap.

### Why custom providers couldn't bind

The model picker and the agent runtime are two different systems:

- The **picker** is fed by `GET /api/models`, which the gateway builds from
  pi-ai's built-in providers **plus** the configured custom providers, so custom
  models appear here fine.
- The **interactive agent** is a separate `pi-coding-agent` subprocess. It
  resolves a model's provider from pi-ai's **built-in provider registry** plus
  `~/.bobbit/agent/models.json`. pi-ai ships **only cloud providers** — there is
  no `ollama` / `lmstudio` / `llama.cpp` / `vllm` / `openai-compatible`
  built-in.

So the picker could offer a custom model the agent had no way to resolve. The
only code that wrote a *dynamic* provider into the agent's `models.json` was the
AI-Gateway writer (`writeAigwModelsJson` in `src/server/agent/aigw-manager.ts`);
**nothing wrote custom providers there.** When the WS `set_model` handler asked
the agent to bind `(provider=<custom>, modelId=…)`, the agent couldn't find the
provider, silently kept its previous model, and — because the gateway didn't
verify the result — the failure was swallowed. The next prompt went to Claude.

### The fix: sync custom providers into the agent `models.json`

`syncCustomProvidersToAgent(prefs)` in
`src/server/agent/custom-provider-agent-sync.ts` writes each configured custom
provider into `~/.bobbit/agent/models.json`, mirroring the aigw pattern so the
agent can resolve it. Each managed block looks like:

```jsonc
data.providers[<config.name || config.id>] = {
  __bobbitManaged: "custom-provider",      // ownership marker (see below)
  baseUrl: `${config.baseUrl}/v1`,         // SAME endpoint /api/models reports
  apiKey: config.apiKey?.trim() || "none", // aigw "none" sentinel
  api: "openai-completions",               // derived from provider type
  models: [ { id, name, contextWindow, maxTokens, reasoning, input, cost, /* compat */ } ],
}
```

The *why* behind each piece:

- **Provider key = `config.name || config.id`.** It must equal the `provider`
  string the picker sends to `set_model`, because that value is passed to the
  agent verbatim — the key is how the agent looks the provider up. A mismatch
  here is exactly the old silent-fallback bug.
- **`baseUrl` gets `/v1` appended** — the same per-model `baseUrl` that
  `discoverModelsForConfig()` already puts on each `/api/models` entry — so the
  agent hits the *exact* endpoint the picker advertised.
- **`apiKey` falls back to the `"none"` sentinel** (matching aigw) when the
  config has no key, since local servers usually don't require one.
- **`api` is derived from the provider `type`:** `openai-responses` →
  `openai-responses`, `anthropic-messages` → `anthropic-messages`, everything
  else (`ollama` / `lmstudio` / `llama.cpp` / `vllm` / `manual` /
  `openai-completions`) → `openai-completions`, since they all speak the
  OpenAI-compatible `/v1` surface. For `openai-completions` blocks a
  conservative `compat` block is attached (store, developer-role,
  usage-in-streaming, reasoning-effort and strict-mode all disabled;
  `maxTokensField: "max_tokens"`) so local servers that don't implement the full
  OpenAI surface don't choke. This mirrors the aigw compat block and is
  duplicated intentionally rather than importing a private symbol.
- **`models[]` comes from `discoverModelsForConfig(config)`** — the same call
  that feeds `/api/models` (manual providers map synchronously; auto-discovery
  types fetch live). Reusing it guarantees the agent sees the *same* metadata
  the picker does, including `input` (see [Vision](#vision-capable-custom-models)).

### Lifecycle and preservation

`syncCustomProvidersToAgent` re-syncs **all** custom providers and runs:

- **On boot**, right after the OpenAI model-additions writer, before sessions
  are restored — so restored agents already see custom providers. Mirrors the
  aigw `startupAigwCheck`.
- **On `POST /api/custom-providers`** (add/update) and **`DELETE
  /api/custom-providers/:id`**, each followed by `invalidateModelCache()` so the
  picker and the agent stay in lock-step.

To avoid clobbering entries it doesn't own, the sync uses the
`__bobbitManaged: "custom-provider"` marker:

- **Non-managed entries are preserved** — the aigw block, `amazon-bedrock` /
  `anthropic` `modelOverrides`, and OpenAI additions are never touched.
- **Stale managed blocks are removed** on rename or delete — any block carrying
  the marker whose key is no longer in the current config set is dropped (a
  rename changes the key, so the old key is cleaned and the new one written).
- **Unreachable auto-discovery host?** If discovery throws or returns no models
  *and* a prior managed block exists, the prior block is **kept** (and a warning
  logged) rather than wiped — a transiently-offline ollama/vllm host must not
  cost you the ability to bind its models. Boot is never blocked: the function
  never throws; callers treat failures as non-fatal.
- **Image-only provider types** (`openai-images` / `gemini-images` /
  `google-imagen`) are skipped — they're handled by image generation, not the
  interactive agent.

Shape, preservation, rename/delete and unreachable-keep-prior behaviour are
pinned by `tests/custom-provider-agent-sync.test.ts`.

### Hard-fail on an unresolvable model (no silent fallback)

Writing the provider block fixes resolution, but the gateway also stopped
swallowing bind failures. The WS `set_model` handler now routes through
`bindModelWithReadback(rpc, provider, modelId, opts)` (extracted into
`src/server/agent/review-model-override.ts`; `applyModelString` delegates to it).
The contract:

1. Call the agent's `setModel(provider, modelId)` (with retries).
2. **Read back** the bound model via `getState()` and assert it matches the
   exact `(provider, modelId)` requested.
3. **Throw** on `setModel` failure or read-back mismatch.

This is the single chokepoint that prevents silent fallback: if the agent can't
resolve the model and stays on its previous one, the read-back mismatches and the
bind throws. Crucially, persistence (`persistSessionModel`) and the model-name
file update happen **only after** read-back passes — a failed bind never leaves
the session pointing at a model the user didn't choose, and no prompt is
dispatched to the wrong model. The thrown error is surfaced to the UI as a
`SET_MODEL_FAILED` WS error. (`modelId` may legitimately contain `/` — e.g.
lmstudio model paths — which is why `provider` and `modelId` arrive pre-split
rather than as one `<provider>/<modelId>` string.) Pinned by
`tests/set-model-hard-fail.test.ts`.

### Vision-capable custom models

Vision models (Bobbit config `input: ["text", "image"]`, e.g. the llama-swap
`gemma-vision-*` models) must be both **visible** and **usable**:

- **Visible:** `input` round-trips config → `mapManualModels` → `/api/models` →
  picker. The model selector (`src/ui/dialogs/ModelSelector.ts`) renders custom
  providers as their own group and shows the vision indicator keyed off
  `model.input.includes("image")`; it applies no hard capability filter, so
  vision models are selectable. No UI change was needed — this is pinned by E2E.
- **Usable:** the synced `models.json` block **preserves `input`**, so a
  bound vision model carries `["text", "image"]` into the agent. That's what
  makes pi-ai's openai-completions client emit image content blocks for the
  local model. The gateway already forwards image parts for *every* provider
  (there is no provider-specific image gate), so once `input` carries `"image"`
  the image-input path works for custom providers too.

The browser flow — seed a provider, select a custom model (it binds as the
session model, not Claude), see the vision indicator, and persist across reload
— is pinned by `tests/e2e/ui/custom-provider-bind.spec.ts`.

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

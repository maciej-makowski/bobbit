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

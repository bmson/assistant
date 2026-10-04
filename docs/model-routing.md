# Model routing

Seed defaults use OpenRouter; owner connections can mix providers as described below. Defaults are declared in
`packages/db/src/model-config.ts` and reconciled when the database is seeded.

| Work | Primary | Budget/provider fallback |
| --- | --- | --- |
| Main agent and tool execution | MiniMax M2.7 | GPT-OSS-120B |
| Conversational replies | Gemini 3.8 Flash | GPT-OSS-120B |
| Planning | DeepSeek V4 Pro 0813 | GPT-OSS-120B |
| Classification, extraction, rewriting, background synthesis | DeepSeek V4 Flash 0731 | GPT-OSS-120B |
| Memory embeddings | Text Embedding 3 Small | Same embedding model |

Kimi K2.5, K2.6, and K3 are available in the conversation model picker. Select
K3 explicitly for hard problems; it is never an automatic budget fallback.
The selection applies to conversational replies and the conversation's agent
tool loop. Internal planning and background roles retain their own defaults.
All choices remain subject to the existing task/daily/monthly budget checks.

GPT-6.1 Sol and GPT-6 Luna are also explicit catalog choices as of the October 2
review. No automatic role defaults changed. Source reconciliation/seed is distinct
from changing a deployed installation. Sol uses supported reasoning effort and
requires reasoning; Luna can disable it for lightweight work. See the
[model research and evaluation guide](model-evaluation.md) for current catalog
rates, capability/transport limits, and `pnpm eval:models` synthetic screening.

Anthropic models and the old Qwen/DeepSeek Chat defaults are disabled. Their
historical usage records remain intact, and saved conversation overrides using
those models are cleared. Normal seed reconciliation upgrades retired routing
without overwriting later owner choices. It leaves the embedding model intact.

To explicitly apply this installation's routing to an existing database:

```sh
pnpm exec tsx scripts/configure-models.ts        # local DATABASE_URL
pnpm exec tsx scripts/configure-models.ts --prod # PROD_DATABASE_URL
```

The update is transactional. Capture the existing configuration first with
`pnpm eval:questions:config .workspace/model-config-before.json` for production.

Capabilities and prices were checked against OpenRouter's model and provider
endpoint catalogs on 2026-09-08. Reservation rates use conservative regular
provider rates (including DeepSeek Pro's peak rate), rather than temporary
discounts or the cheapest advertised endpoint. Actual billing uses OpenRouter's
reported `usage.cost`; stored rates are estimates, not fixed-price guarantees.

Reasoning support does not imply that reasoning can be disabled. Gemini 3.8
Flash, MiniMax M2.7, and GPT-OSS 120B require it. The router keeps reasoning
enabled, with output and cost headroom, for required and unrecognized models.
Lightweight calls disable reasoning only for the exact OpenRouter models in
the provider's verified optional-reasoning list (existing entries checked 2026-09-19;
GPT-6 Luna checked 2026-10-02).
New models or variants must be checked against the catalog's
`reasoning.mandatory` field before being added to that list. Tool-calling and
deliberating roles continue to request reasoning even when it is optional.

`pnpm exec tsx scripts/smoke-models.ts [model-id ...]` runs synthetic live
checks through the router, including streamed replies. It requires the existing
OpenRouter key and a local seeded database, where usage is metered.

## Provider connections

Models can come from more than one provider at once. Each model ID names the
connection that serves it:

| Model ID | Served by |
| --- | --- |
| `minimax/minimax-m2.7` (no prefix) | OpenRouter |
| `openai:gpt-5.1` | OpenAI, with a platform.openai.com API key |
| `vertex:gemini-2.5-flash` | Google Vertex, through the service's own credentials |
| `gw:<connection>:<model>` | An OpenAI-compatible gateway the owner added (Groq, Together, LiteLLM, Ollama) |

Connections are stored in `model_connections` (Firestore `modelConnections`),
with API keys sealed by `MCP_ENC_KEY` and opened only when the adapter is
built. The router re-reads the list every 30 seconds, so a connection saved
in the app takes effect without a redeploy. A connection that is turned off
refuses its models outright; calls already in flight are still metered.

Until the owner saves a connection of a kind, the environment stands in for it:
`OPENROUTER_API_KEY` for OpenRouter (not when `LLM_PROVIDER=vertex`) and
`VERTEX_PROJECT`/`VERTEX_LOCATION` for Vertex. Existing installations need no
migration. Roles may mix providers, and a fallback may be on a different
provider than its primary, because both are set explicitly per role. The
embedding role stays on the installation's embedding space; moving it to a
different provider means re-embedding stored memories.

# Model choice, OpenRouter costs, and evaluation

Research checked October 2, 2026. Published availability and capability metadata were refreshed from OpenRouter's public catalog and primary model documentation. **No live model comparison was run in this checkout:** an existing `OPENROUTER_API_KEY` was not available. Provider benchmark numbers are not app measurements. The evaluation command below creates a reproducible comparison when a configured credential is available.

## Recommendation

Use role-specific evaluation instead of selecting one expensive model for every operation. Screen GPT-6 Luna for frequent classification/extraction and conversational drafting; compare it with the existing defaults and low-cost open models. Use GPT-6.1 Sol as a candidate for difficult planning/tool work and explicit owner choice. Keep current automatic roles until task-level evidence supports a change. These are testing priorities, not a measured ranking.

The source catalog now includes **GPT-6.1 Sol** and **GPT-6 Luna** as explicit conversation choices; seeding/reconciliation makes them available in installations using that catalog. This work does not run configuration changes against a deployed installation. GPT-6.1 Sol requires reasoning, while Luna allows it to be disabled. The provider adapter sends supported effort for these exact model identities and retains billed output headroom. [GPT-6.1 Sol documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-6 Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna), [OpenRouter reasoning contract](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## Price screening

The following are the public catalog's **base advertised** USD token rates in the snapshot used for this review. The example is one request with **10,000 uncached input tokens and 1,000 total billed output tokens**, excluding tools, cache writes, provider fees, tier overrides and retries. Hidden reasoning contributes to billed output; 1,000 visible words does not imply 1,000 billed output tokens. Catalog rates can differ from eligible provider rates, time-of-day prices, long-context tiers, and the app's conservative reservation table. [Public model catalog](https://openrouter.ai/api/v1/models), [catalog API contract](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

| Exact model identity | Input / million | Output / million | Example request | Catalog context |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-6.1-sol` | $2 | $10 | $0.030000 | 1,050,000 |
| `openai/gpt-6-luna` | $0.10 | $0.50 | $0.001500 | 1,050,000 |
| `minimax/minimax-m2.7` | $0.21 | $0.84 | $0.002940 | 204,800 |
| `minimax/minimax-m3` | $0.30 | $1.20 | $0.004200 | 1,048,576 |
| `deepseek/deepseek-v4-flash-0731` | $0.0139 | $1.28 | $0.001419 | 1,048,576 |
| `deepseek/deepseek-v4-flash` | $0.028 | $0.056 | $0.000336 | 1,048,576 |
| `deepseek/deepseek-v4-pro` | $0.2088 | $0.4176 | $0.002506 | 1,048,576 |
| `google/gemini-3.8-flash` | $0.75 | $3.75 | $0.011250 | 1,048,576 |
| `qwen/qwen3.6-flash` | $0.1875 | $1.125 | $0.003000 | 1,000,000 |
| `qwen/qwen3.6-plus` | $0.325 | $1.95 | $0.005200 | 1,000,000 |
| `openai/gpt-oss-120b` | $0.037 | $0.17 | $0.000540 | 131,072 |

Do not silently replace a dated DeepSeek model with an undated alias because their names look similar: the snapshot shows different prices and contracts. The app currently uses `deepseek/deepseek-v4-flash-0731` and `deepseek/deepseek-v4-pro-0813`. Its estimates were checked on an earlier date and deliberately use conservative provider rates. This review does not overwrite existing price/routing choices with the cheapest advertised endpoint.

GPT-6.1 Sol's example costs 20 times Luna's at this exact token shape. A more capable model can still be economical if it completes a job with fewer failed steps and less repeated context. The useful measure is **cost per successfully completed outcome**, including retries, verification, tool latency, and owner correction. Per-token price alone cannot establish that measure.

For Sol, official pricing adds a long-input tier above 272,000 input tokens; the app's new catalog choice records short-input rates. Bounded chat context is still important. For broad document/long-context use, the reservation policy must incorporate applicable tiers rather than treating the base rate as an invoice ceiling. The isolated evaluation takes the maximum published override/cache-write rates into its local reservation and upstream price ceiling. [GPT-6.1 Sol rates and long-context terms](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

## Which ability to compare

| Job | Candidate priority | What must be measured |
| --- | --- | --- |
| Triage and extraction | Luna, dated DeepSeek Flash, GPT-OSS, Qwen Flash | Correct/no-op rate, schema failures, timezone dates, hidden reasoning cost, latency |
| Owner replies | Luna, existing Gemini Flash, MiniMax, selected Sol | Grounded claims, concise useful writing, first text, interruption recovery, token cost |
| Tool execution | Existing MiniMax, M3, Luna, Sol | Correct tool and exact arguments, clarification, approval boundaries, tool-history replay |
| Planning | Existing DeepSeek Pro, Sol, Luna, Qwen Plus | Complete checklist, dependencies, stopping conditions, bounded failure/replanning |
| Background synthesis | Cheapest candidate that passes its job contract | Fact correction, provenance, forgetting exclusion, deduplication, total job cost |
| Repair coding | Current configured repair backend plus tested alternatives | Reproduction, minimal patch, tests, exact-commit CI, no private-data transfer |
| Embeddings | Existing installation embedding space | Retrieval quality and migration effort; incompatible spaces require re-embedding |
| Speech/voice | Separate on-device Talk and outgoing-call voice paths | Real audio latency, turn-taking, interruption/echo, permissions, phone execution quality |

MiniMax M3 and Qwen Flash deserve inclusion as alternative candidates based on current catalog availability and tool/structured-output metadata. That metadata does not prove their reliability on Assistant tasks. A large context window also does not establish better memory retrieval. [MiniMax M3](https://openrouter.ai/minimax/minimax-m3), [Qwen3.6 Flash](https://openrouter.ai/qwen/qwen3.6-flash).

## Repeatable implementation

`pnpm eval:models` prepares a comparison without inference. It accepts exact IDs, cases, repeats, an optional captured public catalog, and an output directory. It saves the exact hashed catalog/corpus, relevant source files, commit and dirty state, SDK versions, settings and timestamps in a new private run directory, and refuses to overwrite prior evidence. Reading an existing catalog does not claim its prices were freshly fetched.

```sh
pnpm eval:models
pnpm eval:models --models openai/gpt-6-luna,openai/gpt-6.1-sol --repeats 3
# Opt-in inference, using an existing local OPENROUTER_API_KEY:
pnpm eval:models --live --budget 5 --repeats 3
```

The live path uses the actual `ModelRouter` for object, tool proposal, and stream calls. Its persistence and accounting ports exist only within the evaluation process: no owner database, configuration table, queues, memories, or real tools are involved. Tools contain schemas without execute callbacks. Primary and fallback both point at the candidate, so the report cannot benefit from an undeclared stronger model. Model responses are checked for the expected routed identity.

The initial corpus contains 14 synthetic cases: meaningful and duplicate mail, absent recall, ambiguous recipients, draft versus send, untrusted permission claims, concrete approval requirements, forgetting, local tomorrow dates, corrected preferences, calendar/draft tool selection, grounded streaming, and honest lookup failure. Deterministic grading checks narrow contracts; schema validity and a response containing a required phrase are useful screening signals, not general intelligence scores.

The run ledger reserves before each call, includes concurrent holds, and caps upstream token prices using `max_price`, with per-request fees disallowed. Calls are sequential, model order rotates across cases, schema/tool input overhead receives a separate allowance, and implicit SDK transport retries are disabled. Router-level retries retain their separate accounting. Provider-reported costs are retained where available; complete token usage uses frozen rates otherwise. A successful call with missing usage retains a conservative estimate, and failed/aborted calls retain their whole reservation rather than assuming they were free. Each result records cost evidence, calls, duration, first visible text for streaming, errors, and synthetic output. A budget/preflight block before any provider work is not-run coverage; a blocked retry after an accounted attempt remains attempted and is reported as budget interrupted. Compatibility/request failures are separate from behavior failures, including stream integrity failures and request errors on a truncation retry. A completion marker identifies partial runs. The local accounted total can exceed the final invoice when failed requests were not billed; reservation estimates are not a guarantee of final provider invoice cost. [Provider price ceilings and routing](https://openrouter.ai/docs/guides/routing/provider-selection).

Compatibility matters: direct OpenAI and OpenRouter are different transports. Sol's direct OpenAI tool path is Responses, while the existing app uses OpenRouter's chat adapter. The comparison exercises that app adapter and the router's dotted-tool-name encoding, rather than assuming a direct-API example proves compatibility. A live transport check still remains pending. [Direct Sol endpoint contract](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [OpenRouter Sol API](https://openrouter.ai/openai/gpt-6.1-sol/api).

## Evidence needed before a role change

Run multiple repetitions and investigate each critical failure. Use the [question regression harness](testing/question-regression.md) for full executor/response-contract checks, and a blind manual review of grounded conversational replies. Keep the same fixture corpus, context, reasoning setting, provider policy, output budget, and repetitions when comparing candidates.

Report cost per successful case and per successful multi-step task, first-text latency, full latency distributions, truncation/parse failures, incorrect tool arguments, and owner intervention. Record exact model IDs, catalog/provider date, router revision, corpus version, and any upstream substitution. Use enough repetitions to support percentile claims; the current screening report's mean is not p95.

Hard gates include no invented completion, no authority promoted from untrusted content, no sensitive disclosure from forbidden memory, no wrong recipient, and no skipped required approval. The executor still enforces policy even when the model passes these tests. A good model is not a replacement for deterministic safeguards.

A promotion should change one role, with the previous role configuration saved, a bounded canary, and a rollback. Owner-selected conversation models remain explicit. Model, prompt, tool policy, and memory changes should be evaluated separately where possible so the cause of a result remains understandable.

## Scope and remaining work

The offline plan completed successfully for 14 cases across seven candidates. Accounting/grading and provider compatibility tests passed in this review; repository verification is recorded in the [implementation review](architecture-review-2026-10-02.md). Live quality, latency, and outcome cost are **unmeasured**. No production role was promoted and no inference money was spent by this work.

The next expansion should add versioned full tasks for multi-step calendar/mail work, long-history correction/forgetting, provenance-grounded retrieval, and interrupted/resumed work. Add real integration dry-runs separately from provider screening. Manual review should judge warmth, tact, clarity, and relevance without showing model names or price. Catalog synchronization should require validation and retain owner choices; aliases and cheap new providers should never silently change the installation's behavior.

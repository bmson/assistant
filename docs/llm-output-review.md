# Reviewing what the models said

The cost ledger (`model_calls`) proves a call happened and what it spent. It
keeps neither the prompt nor the answer, so questions about answer *quality* —
"was last week worse than the week before", "did that routing change help",
"how often does the briefing come out malformed" — had no source at all. They
were only answerable by reading transcripts by hand, which is how the
[September 2026 audit](audits/llm-response-quality-review.md) started.

Capture closes that, and `pnpm audit:llm` reads it back.

## Turning capture on

Set it in `.env` and provision — `infra/gcp/deploy.sh` forwards both settings to
the agent and the web service. Setting them by hand in the Cloud Run console
does not stick: the deploy uses `--set-env-vars`, which replaces the whole
environment, so the next provisioning run silently wipes anything the script
does not name.

```dotenv
LLM_AUDIT_CAPTURE=redacted   # off | redacted | full
LLM_AUDIT_RETENTION_DAYS=14
```

It is `off` by default, because these rows necessarily contain the owner's
mail, calendar and conversations.

- **`redacted`** scrubs email addresses, phone numbers, long digit runs
  (booking, account and card numbers) and URL paths before writing. Dates,
  times, amounts and scores are deliberately kept — redaction that ate those
  would destroy the reason to keep the record.
- **`full`** stores the text verbatim. More useful for judging whether an answer
  was actually grounded in its evidence, and a much more sensitive table.
  Appropriate for a single-owner installation reviewing its own assistant; think
  twice where the mailbox carries anyone else's correspondence.

Redaction is pattern-based and conservative. It is not a promise of anonymity:
free text can still identify a person, and dates, times, amounts, and scores
remain visible. `full` capture stores private text verbatim.

Retention is enforced by the ordinary maintenance sweep. The local `pnpm
audit:llm` report is read-only and makes no model call. Model-assisted
investigations are a separate path: **Copy investigation request** asks the
assistant to use `audit.read` and, when needed, `audit.read_field`. Those tools
can return captured system prompts, inputs, outputs, tool arguments/results,
task messages, approvals, and bounded diagnostic state to the assistant's
configured model provider as conversation/tool context. Use them only when that
provider use is acceptable for the selected capture mode and task data. The
tools are unavailable to externally triggered tasks, return untrusted evidence,
and enforce owner-task scoping; they do not
retry work or mutate the investigated task.

Credential-like keys and runtime resume tokens are excluded by the investigation
projection, with additional pattern scrubbing of serialized and free-text
fields. This is a source-minimizing projection, not a guarantee that arbitrary
private text or third-party personal information is removed. `audit.read_field`
returns at most 12,000 characters per request; it cannot recover data truncated
when originally captured. Off mode does not provide captured prompt/answer text,
but the audit investigation may still return other stored task, tool, approval,
message, and diagnostic records.

## What gets captured

Every generative call, because they all converge on one seam. `ModelRouter`'s
`generate`, `stream`, `step` and `object` all meter through the same place, so
one insert there covers all thirty call sites — including the briefing,
watch-suggest, email triage, extraction and card surfaces that no test exercises
today. Embeddings are not captured: an embedding has no answer to judge.

Each row holds the role, model, method, system prompt, input, output, finish
reason, latency and token counts, and links to its `model_calls` row for cost.

## Reading it back

```sh
pnpm audit:llm                              # last 7 days
pnpm audit:llm --days 30
pnpm audit:llm --role draft                 # one role
pnpm audit:llm --prod                       # PROD_DATABASE_URL, read-only
pnpm audit:llm --json report.json
pnpm audit:llm --show unclosed-code-fence   # the records behind a column
```

For a Firestore deployment, there is no PostgreSQL URL or `database-url` secret
to fetch. Supply the deployed project, named database, and workspace explicitly:

```sh
GCP_PROJECT=bmson-assistant \
FIRESTORE_DATABASE_ID=assistant-production \
ASSISTANT_WORKSPACE_ID=assistant \
  pnpm audit:llm --prod --firestore --gcloud-auth --days 7
```

Use your own deployment's values for other installations. `--gcloud-auth` uses
the active `gcloud` login; omit it to use Application Default Credentials.
`PERSISTENCE_DRIVER=firestore` also selects the Firestore reader. The reader
only queries the selected installation's captured calls, makes no writes, and
rejects a production run when `FIRESTORE_EMULATOR_HOST` is set.

The report groups by `role/method` and gives call volume, p50/p95 latency,
output tokens, and a defect count per surface. It runs in a read-only
transaction on PostgreSQL and uses only reads on Firestore. It needs no model
credential or model calls; Firestore reads incur the ordinary database charges.

## What the graders check

Deterministic checks over the text alone (`packages/core/src/model-router/audit-graders.ts`):

| Defect | What it catches |
| --- | --- |
| `unclosed-code-fence` | An odd fence count, which renders the rest of the reply as code |
| `background-notice-echo` | The assistant repeating `[Background notice…]` from its own context |
| `forbidden-theme-tag` | A `[theme: …]` tag, which the cue vocabulary forbids outright |
| `excess-break-tags` | More than two `[break]` tags in one reply |
| `excess-chip-rows` | More than one `[action_chips: …]` row |
| `fabricated-interface-element` | `[Set alert] | [Check timing]` — a fake button row nothing renders |
| `empty-output` | A call that produced no text |
| `truncated-output` | The provider stopped at the token limit |
| `schema-parse-failure` | Structured output returned provider text that could not be parsed against its schema |
| `repetitive-output` | An obvious generation loop or repeated replacement-character corruption |
| `malformed-output` | A corrupted C/F temperature unit such as `12°Chare` |
| `emoji` | An emoji, which is a defect unless the owner asked for one |
| `wall-of-text` | A plain paragraph over 400 characters or four sentences — a block on a phone. Review signal only: both clients also split such paragraphs at render time (`apps/web/lib/paragraph-reflow.ts`, `ParagraphReflow.swift`) |

Tool-calling `step` rows retain the selected tool names and arguments for
diagnosis, but prose graders remove those serialized `→ tool(JSON)` lines
before checking formatting, emojis, and repetitions. A `tool-calls` finish with
no prose is a valid tool decision, not an empty answer. Failed structured
responses retain provider text when the SDK exposes it, marked as a schema
parse failure so malformed JSON is not reported as a clean structured result.
The live output guard also reads the current owner request and allows deliberate
repetition requests through. The standalone audit report does not currently
infer that intent, so an explicitly requested repeated phrase may still appear
as a review signal.

Several of these previously existed **only** inside the question-regression
harness, so the suite graded properties the runtime never enforced. They live in
a pure, exported module now specifically so the response contract can call the
same functions — see recommendation 6 in the audit.

## What this does not tell you

The graders judge the text, never whether the answer was *correct*. Deciding
that needs the evidence the answer was drawn from, which is what
`groundReadDraft` already does for calendar, email, drive and memory reads —
and what live web and weather answers still lack.

A clean report means no detectable defect. It is not a claim that the assistant
had a good week.

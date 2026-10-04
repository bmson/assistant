# Automatic issue investigation and repair PRs

The assistant captures failed tasks, explicit owner corrections in chat, manual reports in Improvements, and selected self-maintenance proposals. A scheduled investigation checks the audit, separates code defects from provider/configuration/answer problems, and produces a bounded technical brief with synthetic reproduction steps. Plausible code issues with an unknown cause can reach the private coding worker for repository investigation, even without known source paths. The worker must reproduce a defect and add a regression test before any patch can be published. A suspected bad answer also reaches the private worker when there are actionable steps and expected behavior: incorrect capability claims can originate in repository routing or prompts. Preliminary labels do not establish that the repository is correct. Established provider and configuration problems stay out of the coding worker.

The worker opens a feature branch, adds a regression test, checks the patch, and creates a PR. Improvements shows the diagnosis, progress, history, worker run and PR. Manual reports can attach a related activity to supply its owner-scoped audit. Queued reports show their position and waiting reason. The existing notification channel sends the owner the PR link and reports blocked or failed investigations in the same check. A retry can receive a new notification even if it reaches the same status again. The owner reviews and merges; this flow never merges or deploys. After the merge reaches the configured deployment, the issue enters monitoring. Confirm the behavior in Improvements to mark it resolved. A matching failure after deployment starts a new linked investigation.

## OpenAI-hosted coding (replacement for the private Actions worker)

Set `SELF_REPAIR_PROVIDER=openai_hosted` on the agent and web services after releasing this implementation. Coding then runs through the public OpenAI Agents API in an OpenAI-hosted Linux sandbox. The assistant's existing minute sweep starts and reconciles sessions, using the same owner-scoped queue, daily allowance and protected-path fence. Sol (`gpt-6.1-sol`) at medium effort remains the default; pin it with `SELF_REPAIR_CODING_MODEL` and `SELF_REPAIR_REASONING_EFFORT`.

Mount dedicated `SELF_REPAIR_OPENAI_API_KEY` and `SELF_REPAIR_GITHUB_TOKEN` secrets on **assistant-agent**. Hosted repair uses its dedicated source-repository publisher token for both repository reads and publication; it does not require the legacy `GITHUB_TOKEN`. The publisher token needs Contents and Pull requests write access on the source repository. Actions write is unnecessary for new hosted attempts. Existing GitHub attempts remain inspectable during migration using the separate `GITHUB_TOKEN`, so retain the private worker and its read access until they finish.

The coding environment receives an immutable public source checkout and a synthetic technical brief. It receives no API key, GitHub credential, production database access, owner transcript or raw audit. Outbound access is restricted to GitHub source and npm package hosts. Generated code runs only in the sandbox. The backend validates the result before writing GitHub blobs: 1–20 source files, at most 100 KiB of decoded changed-file contents, no protected/escaping paths, symlinks, non-UTF-8 files, duplicate paths, or missing regression/acceptance test. The authoritative GitHub comparison also retains the 100 KB patch limit, including deletions and replacements of large existing files. Incomplete comparisons fail before a branch or PR is created.

A validated result creates a **draft PR immediately**. Normal repository CI independently runs lint, type checking, PostgreSQL and Firestore tests, build smoke, and applicable iOS checks. The assistant tracks the exact commit and marks the draft ready, then pings the owner, only when all expected GitHub Actions checks pass. A completed model turn alone is not treated as verification. Failed CI leaves the draft available for inspection and records a failure in Improvements. No automatic merge or deployment occurs.

Session and root turn IDs are durable. If session creation succeeds but its response is lost, the next sweep recovers it by repair-attempt metadata instead of dispatching again. Coding is cancelled after 20 minutes. Finished sessions are deleted after the result is fetched; failed cleanup is recorded and retried on later sweeps even for terminal reports. Retry waits until cleanup finishes. Draft checks have a separate one-hour deadline. Model tokens and hosted sandbox time are billed separately; the existing dispatch allowance is not a dollar cap. Configure a dedicated OpenAI project budget.

For this installation, run `python3 scripts/configure-self-repair.py --hosted` **after merge and release**. It asks for the existing dedicated publisher token through a hidden prompt, reuses the ignored local coding key, and confirms these new destinations before changing anything:

- Google Secret Manager `bmson-assistant/self-repair-openai-key`
- Google Secret Manager `bmson-assistant/self-repair-publisher-token`
- Secret mounts on `assistant-agent` only; provider/model settings on both services

It never copies the broad local GitHub CLI credential into production. GitHub cannot return the publisher secret already stored in the private worker; the owner must provide its original value or create a replacement using the publisher link below. Automatic repair remains disabled during setup. After release and the hosted end-to-end check, enable it and retry a report through Improvements. Do not delete the private worker before verifying the replacement.

Official contract: [Agents API quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart), [hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted), and [session artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files).

## Activate the legacy GitHub worker

When code fixes are enabled and configured, advisory proposals in Improvements offer **Mark reviewed** and **Request code fix** on web and iPhone. Mark reviewed acknowledges advice without changing code or settings. Request code fix creates a tracked report under Code fixes and closes the proposal review queue item. Repeated requests return the same report with its actual status, including if it already failed or completed; they do not start another coding run. Conversion uses the normal automatic coding allowance and waits behind active investigations or PR reviews. Model routing proposals retain their direct apply action. See the [complete self-improvement flow](self-improvement-flow.md) for decision receipts, validation, and remaining measurement gaps.

1. Release these changes and the `self-repair.yml` workflow to the source repository's default branch. For PostgreSQL, apply migration 0081 and run the seed. For Firestore, provision the checked-in indexes, including `tasks(agentId, updatedAt DESC)`; the agent creates the 15-minute reconciliation schedule when enabled. New reports and retries make that schedule due immediately; the minute sweep commits the repair task and its durable queue wake. Waiting reports are also recovered on each sweep as soon as the rolling coding allowance is available. Existing disabled schedules remain disabled.
2. If the source repository is public, create a private worker repository (this installation uses `bmson/assistant-repair-worker`). Copy `.github/workflows/self-repair.yml` to its default branch and set its repository variables `SELF_REPAIR_SOURCE_REPO=bmson/assistant` and `SELF_REPAIR_SOURCE_REF=main`. It checks out an immutable source commit from the source default branch; only verified code is published back. Diagnostics, Actions logs and artifacts stay private. The public PR body omits the brief and private run link.
3. Create the repository label `self-maintenance`.
4. Add Actions secrets in the private worker repository:
   - `SELF_REPAIR_OPENAI_API_KEY`: a dedicated project API key for the coding worker.
   - `SELF_REPAIR_GITHUB_TOKEN`: a repository-scoped publisher token with Contents and Pull requests write access. Use a dedicated identity without permission to bypass protected-branch rules. This token is available only to the publish job, after checks pass. A separate token is used so creating the PR triggers ordinary PR checks.
5. Configure the assistant runtime and web service:

   ```dotenv
   GITHUB_REPO=bmson/assistant
   GITHUB_TOKEN=<runtime token: Actions read/write, Contents read, Pull requests read>
   SELF_REPAIR_WORKER_REPO=bmson/assistant-repair-worker
   SELF_REPAIR_ENABLED=true
   SELF_REPAIR_ALLOW_EXECUTOR=false
   SELF_REPAIR_DAILY_LIMIT=2
   SELF_REPAIR_WORKFLOW=self-repair.yml
   SELF_REPAIR_REF=main
   SELF_REPAIR_DEPLOYMENT_URL=https://<assistant-host>/api/health
   ```

   Match `SELF_REPAIR_REF` to the worker repository's actual default branch. Source commits are resolved from the source repository's default branch. Use separate dedicated fine-grained tokens. Runtime: restrict to source and worker repositories with Actions read/write, Contents read and Pull requests read. Publisher: restrict to the source repository with Contents and Pull requests read/write. Keep the runtime token in Secret Manager; do not copy an all-repositories CLI login token into the worker. The health endpoint must return the deployed commit SHA. Configure the normal assistant model provider for investigation and the existing notification delivery channel for owner pings. Use the installation's secret manager for runtime credentials; never commit them or pass them as visible command arguments.
6. Submit a small, reproducible report through Improvements. Confirm investigation, worker checks, PR notification, owner merge, deployment monitoring, and confirmation before relying on unattended runs. Check both SQL and Firestore paths for the selected installation backend.

The local coding key is stored in ignored `.env.local`; transfer it only to the private worker secret with explicit owner approval. The key has now been installed in this installation’s private worker. Runtime configuration loads `.env`; installing the coding key alone does not activate the worker.

## Limits and recovery

There is one active issue per owner and a default limit of two coding dispatches per rolling 24 hours (maximum configurable limit: five). A trusted launcher in the private worker enforces a 12-minute coding-process deadline, inside the 15-minute step and 25-minute job limits, so interrupted runs leave time to save diagnostics. If Codex writes a complete structured final result but lingers for another ten seconds, the launcher stops its process group and passes that result to the unchanged patch gate. Ordinary nonzero exits and timeouts without a complete result fail. The private investigation artifact contains the result and coding output for seven days. Coding formats changed files, runs lint and type checking, and runs focused tests; independent verification jobs repeat static checks and run the full test suites and applicable iOS tests before publication. Investigation uses the scheduled task budget. If the preliminary review exhausts retries on a rate limit or provider outage, it tries one distinct configured fallback model within that budget. These are execution limits, not a guaranteed dollar cap; set a dedicated API project budget and monitor usage.

Patches are limited to 20 files and 100 KB. A regression test and explicit reproduction result are required. Credentials, authentication, trust controls, infrastructure, dependency/configuration files, schemas and the repair machinery are protected. Executor fixes require the separate owner-enabled tier, which permits only selected implementation files. The candidate is tested in fresh jobs without publisher credentials. Publication rechecks the exact patch that passed lint, type checking, PostgreSQL tests, Firestore tests and applicable iOS tests.

A completed investigation can conclude that no repository defect was confirmed. With an unchanged checkout and a complete explanation, this is a successful investigation without a PR; the report shows the explanation as blocked. A missing/incomplete result, changed files without confirmed reproduction, or failed checks remain failures. The private worker retains its investigation result for seven days, including when later patch checks fail.

An uncertain dispatch is reconciled by repair UUID, branch and workflow run before retry. A missing run eventually becomes failed; interrupted investigations expire. Eligible failed or blocked issues expose Retry, which clears the old diagnosis and deployment evidence and joins the back of the queue. A prior legacy GitHub PR requires review of that PR or a new report rather than reuse as a fresh attempt; hosted retries use fresh branches after cleanup. Active coding/PR issues cannot be dismissed. Closed PRs become dismissed. Deployment is recorded separately from confirmation of a fix. Disabling `SELF_REPAIR_ENABLED` stops new investigations, dispatches and polling; already-dispatched GitHub runs must be cancelled separately if needed.

Raw conversations and audits stay in the assistant installation. Reports are scrubbed before storage; the worker receives a technical brief rather than the original audit or owner message. Model-generated briefs still need care: the investigation prompt requires synthetic data, and the worker repository must be private. Repair records participate in privacy erasure.

## Secure credential handoff for this installation

GitHub does not let this setup create a fine-grained personal token through the CLI. The owner creates and enters these credentials. Two prefilled forms help choose the permissions; select only the repositories specified:

- [Runtime token](https://github.com/settings/personal-access-tokens/new?name=Assistant%20repair%20runtime&target_name=bmson&expires_in=90&actions=write&contents=read&pull_requests=read): `assistant` and `assistant-repair-worker`.
- [Publisher token](https://github.com/settings/personal-access-tokens/new?name=Assistant%20repair%20publisher&target_name=bmson&expires_in=90&contents=write&pull_requests=write): `assistant` only.

Run `python3 scripts/configure-self-repair.py` from the repository. Enter the tokens only into its hidden prompts. It explains and confirms the exact destinations, verifies account/repository access, installs the publisher secret in the private worker, and installs the runtime credential in Google Secret Manager. It preserves existing service settings and mounts the credential only on the two application services. It never prints or saves the tokens locally, rejects broad CLI credentials and keeps automatic repair disabled until merge, release and a synthetic end-to-end check. Tokens expire after 90 days and need rotation. The OpenAI coding key is installed separately with explicit transfer approval.

The owner-facing setup tool is scoped to `bmson-assistant` in `us-west1`; other installations should adapt the constants and repository settings before running it.

Queued, failed, and blocked reports offer **Run now** on web and iPhone. This authenticated owner action authorizes one investigation attempt beyond the automatic daily dispatch allowance. The request is consumed atomically when claimed; double clicks cannot authorize duplicate coding runs. Another active investigation or PR review still takes precedence, and model spending budgets, provider quota, protected paths, and owner PR review remain enforced. Triage has a one-minute provider deadline and at most one fresh minute on a distinct configured fallback.

Feature requests are actionable work. Triage labels them as features and the worker demonstrates the missing requested behavior with an acceptance test, implements it, and checks that the test passes. Intentional current behavior is not a reason to decline a requested feature. Already implemented, unclear, or protected changes still require an explanation rather than a fabricated patch. Coding, test, PR, and deployment states are reconciled on each minute sweep in Firestore installations.

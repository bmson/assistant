# Audits — historical records

The documents in this folder are **point-in-time review reports**, each
describing the source and evidence available at its recorded date. For
uncommitted work, retain source hashes alongside the base commit. They are kept as decision
records: they explain *why* the codebase has the guards it has (the fork-PR
deploy fix, the boundary checker, the OIDC release hardening) and what was
deliberately deferred at the time.

They are **not current documentation**. File names, line numbers, and
"current state" claims inside them refer to the code as it was then — check
the living references in the parent folder instead:

- [architecture.md](../architecture.md) — package boundaries and data flow
- [modules.md](../modules.md) — optional capability modules
- [operations.md](../operations.md) — monitoring, verification, releases
- [self-hosting.md](../self-hosting.md) — Cloud Run deployment

| Document | Date | Subject |
| --- | --- | --- |
| [platform-review.md](platform-review.md) | 2026-07 | Feasibility review of the composable-platform shift |
| [codebase-review.md](codebase-review.md) | 2026-07 | Full review: security, performance, capability, process |
| [codebase-review-2.md](codebase-review-2.md) | 2026-07 | Second pass: release-script injection, drift detection |
| [codebase-review-3.md](codebase-review-3.md) | 2026-08 | Dead-code removal and verification tooling |
| [codebase-review-4.md](codebase-review-4.md) | 2026-08 | Writing and organization: naming, comments, file layout |
| [performance-review.md](performance-review.md) | 2026-08 | Unbounded reads, polling cadence, per-render work, the local queue driver |
| [llm-response-quality-review.md](llm-response-quality-review.md) | 2026-09 | Model-call inventory, grounding coverage, the `direct`-mode mail gap, unrecorded output |
| [web-experience-2026-10-02.md](web-experience-2026-10-02.md) | 2026-10-02 | All 34 browser routes, owner-console refactor, synthetic visual and interaction evidence |
| [ios-experience-2026-10-02.md](ios-experience-2026-10-02.md) | 2026-10-02 | Every reachable native surface, transcript/polling/voice/search refactor and device QA limits |
| [agent-architecture-2026-10-02.md](agent-architecture-2026-10-02.md) | 2026-10-02 | Recall bounds, recurring work backpressure, proactive/calendar fixes and remaining attention contract |
| [Behavior and improvement review](../behavior-review-2026-10-03.md) | 2026-10-03 | Message handling, verified effects, optional review recovery, improvement decisions and native receipts |
| [Behavior verification record](assets/assistant-behavior-2026-10-03.json) | 2026-10-03 | 4,600 repository checks, 67 retained scripted replies, source hashes and native validation limits |
| [Screenshot-led UI review](ui-review-2026-10-03.md) | 2026-10-03 | Browser and native before/after captures, shared visual foundations, forms, recovery and current validation boundaries |
| [Console usability review](console-ui-review-2026-10-03.md) | 2026-10-03 | Owner access, pairing, audit hierarchy and credential receipts after failed refreshes |
| [Release integration verification](release-2026-10-03.md) | 2026-10-03 | Combined-source checks, merge repairs, release proof and distribution boundary |

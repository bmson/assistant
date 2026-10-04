# Assistant documentation

Assistant is a continuing personal conversation backed by remembered context, connected services, durable work, and owner-controlled decisions. Start with the product guide to understand the experience, then use the system and capability references to understand how it works and what must be configured. Source-reviewed October 2–3, 2026; operational reports retain their own dates.

## Product and implementation guides

- [Product intent and every page](product-guide.md) — the app's purpose, vocabulary, all 34 web pages, native destinations, settings, and supporting flows.
- [System architecture and decisions](system-reference.md) — runtime/package boundaries, request and execution flows, memory, trust, deployment, technology roles, and the decision register.
- [Capabilities and integrations](capability-reference.md) — ability families, prerequisites, success evidence, all 78 distinct static tool names, and all 56 direct external JavaScript dependencies.
- [Product gaps and completion criteria](product-gaps.md) — differences from the brief, unfinished delivery work, and concrete acceptance examples.

These guides document implemented source separately from product direction and deployment verification. They expand the original brief without treating proposals as already built.

## October 2–3 implementation, design and model review

- [Integrated architecture review and implemented changes](architecture-review-2026-10-02.md)
- [Design system and experience guidelines](design-system.md)
- [Screenshot-led UI refinement and before/after gallery](audits/ui-review-2026-10-03.md)
- [OpenRouter cost research and model evaluation](model-evaluation.md)
- [Every browser route and visual/behavior review](audits/web-experience-2026-10-02.md)
- [Every native page and supporting flow](audits/ios-experience-2026-10-02.md)
- [Agent behavior, context and durable initiative](audits/agent-architecture-2026-10-02.md)
- [Durable pulse admission, privacy fencing and delivery limits](durable-pulse-admission.md)
- [Native relationship-map preparation and performance checks](../apps/ios/docs/graph-performance.md)
- [Session architecture and interface cleanup](ui-simplification-2026-10-03.md)
- [Message scenarios, truthful outputs, and improvement decisions](behavior-review-2026-10-03.md)

## Architecture and extension

- [Package boundaries and adding modules](architecture.md)
- [Optional modules, credentials, and readiness](modules.md)
- [Model roles and provider connections](model-routing.md)
- [Google/Vertex provider](google-model-provider.md)
- [Generative cards and UI](generative-ui.md)
- [Request continuity and checklists](request-continuity.md)

## Conversation, memory, and initiative

- [Long-running conversation, segments, recall, and GraphRAG](long-running-chat-memory.md)
- [Immediate memory correction and supersession](memory-supersession.md)
- [Temporal validity](temporal-validity.md)
- [Knowledge graph improvements](knowledge-graph-improvements.md)
- [Anticipation, watches, briefings, and suggestions](anticipation-layer.md)
- [Situation Packs](situation-packs.md)
- [Chat writing and operational notices](chat-voice.md)
- [On-device speech and Talk mode](on-device-speech.md)
- [Outgoing phone calls](phone-calls.md)

## Governance and operations

- [Costs, provider billing, and operation budgets](cost-tracking.md)
- [Automatic investigation and repair PRs](self-repair.md)
- [Self-improvement signals, decisions, validation, and promotion](self-improvement-flow.md)
- [Audit investigations](audit-investigations.md)
- [Captured model-output review](llm-output-review.md)
- [Self-hosting on Google Cloud Run](self-hosting.md)
- [Operations and supply-chain verification](operations.md)
- [Backup, restore, and migration safety](recovery.md)
- [Google OAuth setup](../infra/gcp/oauth-setup.md)
- [GitHub deployment setup](../infra/gcp/github-actions.md)

## Consumer installation and owner access

- [Installation and Firestore plan](firestore-consumer-install-plan.md)
- [Current implementation status](firestore-implementation-status.md)
- [Foundation/install preview](consumer-install-preview.md)
- [Installation preparation](consumer-prepare.md)
- [Image publication](consumer-image-publish.md)
- [Runtime seed](consumer-runtime-seed.md)
- [Fresh-account pilot](consumer-fresh-account-pilot.md)
- [Vertex model probe](consumer-vertex-model-probe.md)
- [Owner claim, passkeys, recovery, and devices](consumer-owner-passkeys.md)
- [Consumer Terraform](../infra/gcp/consumer/terraform/README.md)

## Persistence migration

- [Cutover acceptance checklist](firestore-cutover-checklist.md)
- [Workspace migration and checksums](workspace-migration.md)
- [Production export](firestore-production-export.md)
- [Production import](firestore-production-import.md)
- [Source write fencing](firestore-source-write-fence.md)
- [Agent runtime inventory](firestore-agent-runtime-inventory.md)
- [Web route inventory](firestore-web-route-inventory.md)
- [September 23 rehearsal evidence](firestore-rehearsal-2026-09-23.md)
- [Firestore package](../packages/firestore/README.md)

## Validation and native distribution

- [Complex workflow matrix](complex-workflow-test-matrix.md)
- [Question regression checks](testing/question-regression.md)
- [Assistant interaction scenarios](testing/assistant-scenarios-2026-10-03.md)
- [Every delivered scenario reply](testing/assistant-scenario-answers-2026-10-03.md)
- [October 3 behavior verification record](audits/assets/assistant-behavior-2026-10-03.json)
- [Chat readability QA](chat-readability-qa.md)
- [iOS visual consistency QA](ios-visual-consistency-qa.md)
- [iOS app, connection, speech, and test instructions](../apps/ios/README.md)
- [iOS visual QA](../apps/ios/docs/visual-qa.md)
- [Native rendering cost and streaming rules](../apps/ios/docs/render-cost.md)
- [Native shipping](../apps/ios/docs/shipping.md)
- [Audit history](audits/README.md)
- [Messaging review from September 19](messaging-review-2026-09-19.md)
- [Messaging review from September 29](messaging-review-2026-09-29.md)
- [Brand assets](brand/README.md) and [brand QA](brand/QA.md)

## Maintaining this documentation

When adding or changing a page, update the page guide and route register. When adding a tool/provider/module, update the capability catalog and its setup/effect limits. When changing a lasting architecture choice, update the decision register with a source and explain the tradeoff. When a proposed outcome ships, update the gap register only after its relevant verification gates pass.

The static tool inventory comes from `name`, `description`, and `risk` fields in declaration objects under `packages/tools/src`, with SQL/portable duplicate names merged. Dynamic MCP remote tool names are discovered at runtime. The dependency inventory comes from the root and immediate app/package/worker manifests, excluding workspace references. Resolved transitive dependencies remain in the lockfile.

Use the current mounted code for UI facts and the dedicated dated reports for deployment claims. Do not copy secrets, owner transcripts, production records, or private repair briefs into documentation. Documentation does not activate integrations, migrate data, deploy services, or change permission policy. Implemented source changes and their verification belong in the dated implementation reviews.

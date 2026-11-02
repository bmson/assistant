# Bounded web runtime diagnostics — source only

This separate manual workflow reads the fixed `assistant-web` service and its
settled current 100% revision in `bmson-assistant/us-west1`. An explicit boolean
may also read only historical revision `assistant-web-01080-hel`. It does not
change or participate in retirement, release, cleanup, scaling or editor admission.
Source approval and passing offline tests do not authorize a workflow dispatch.

Require reviewed main source matching both workflow and checkout SHA, first
attempt, production environment, existing WIF identity and the pinned SDK576.
The source/window check precedes cloud authentication. There are no added IAM,
OAuth scopes or workflow permissions. Missing existing access is unavailable.
The production-deploy lock remains in force; do not cancel another operation.

Configuration output distinguishes the current immutable revision, the next
revision template, and service-level scaling. It retains exact native image and
revision identity, observed timeout, concurrency, min/max counts, CPU/memory and
explicit CPU flags. Omitted fields are `not_returned`; zero is retained only when
explicitly returned. Values are raw observed settings, not inferred effective
defaults, allocated capacity or whole-service totals. Container resources refer
only to the exact web image container. A configuration read cannot qualify the
serving source SHA. Native fields follow the [Service API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services)
and [Revision API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services.revisions).

The optional timing observation uses [Logging entries.list](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list)
with fixed project, region, service, current revision and request-log name. Its
reviewed UTC window is at most15minutes and within24hours. The fixed filter covers
only the canonical `/profile/knowledge?view=library` request, optionally followed
by Next's `_rsc` token. Other searches, filter/order variants, routes and revisions
are outside the sample. URLs and tokens are never output. Server-side field
masks and independent local allowlists exclude content, payload, environment,
IP, user agent, referrer, trace/session identifiers and provider error text.

At most two100-row pages produce minute-level HTTP status-class counts and
sample duration summaries. Pagination is bound to the same window/filter.
Truncation and invalid/missing observations remain explicit. Empty samples and
fewer than10valid durations have no latency percentile, not zero latency. An HTTP
error count does not diagnose an application exception. These bounded request-log
observations do not prove browser speed, backend-wide rates or improvement.
Duration/status fields follow the [HttpRequest contract](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#HttpRequest).

There are at most six API reads, a60-second monotonic API deadline,15seconds per
request/body and256KiB per response. Only fixed HTTPS hosts are used, without
redirects or retry. A final service UID/etag/generation/current-revision check
rejects drift. The credential helper has two bounded10-second SDK calls and
never prints tokens or raw failures. The one-day artifact contains only the
sanitized packet and hash. A successful workflow may contain an explicitly
unavailable observation; inspect the packet instead of treating job green as
runtime evidence. No synthetic application request is sent.

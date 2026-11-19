# Optional MCP authorization

Phase 3 extends the existing owner-managed MCP connections. Integrations remain optional; chat, memory, reminders, the existing assistant account, and manual bearer-token connections do not depend on OAuth setup. The current MCP transport remains pinned to `2025-11-25`. Authorization discovery uses the published `2026-07-28` requirements; this does not advertise support for that revision's different transport protocol.

## First increment: inspect sign-in requirements

The first increment checks a saved connection's public authorization metadata and returns a transient diagnostic to its owner. It does not register a client, open a consent page, obtain tokens, change saved credentials, enable tools, or change the connection's discovery status. A successful metadata check means that sign-in requirements were found; it does not establish a working sign-in or access to the user's data.

The authenticated route is `GET /api/mobile/v1/mcp/{id}/authorization`. The caller supplies a saved connection ID, not an arbitrary fetch target. Responses distinguish `supported`, `unsupported`, and `discovery_failed` and explicitly report `authenticated: false`. Web and native clients must keep this result separate from saved connection status.

Discovery must bind the protected resource to the selected MCP endpoint and the authorization-server metadata to its exact issuer. It follows the server's Bearer challenge when present, then the specified protected-resource well-known paths, and supports the OAuth authorization-server and OpenID Connect discovery paths. Authorization-code support and advertised S256 PKCE support are required. Registration information is diagnostic only: pre-registered clients and Client ID Metadata Documents are the intended first choices; Dynamic Client Registration is a later compatibility option where needed.

All remote requests use bounded public-network access. Saved bearer tokens, cookies, and assistant credentials must never be attached to a metadata request. Private network destinations, credential-bearing URLs, redirects, mismatched resource or issuer, and excessive responses must be rejected. A network failure must remain distinguishable from metadata that establishes unsupported authorization.

The check has a 20-second total deadline, at most 12 HTTP requests, at most 64 KiB per metadata response and 256 KiB total metadata content, and at most three advertised authorization servers. DNS resolution and response-body reads share the deadline. Query-bearing URLs are unsupported by this diagnostic because they can contain manually supplied credentials. Root resource identifiers use the canonical form without a trailing slash; path resource identifiers retain their exact path. These restrictions affect diagnostics only and do not rewrite saved endpoints.

The owner can check one saved connection from Connected tools. The result identifies the MCP server and authorization provider separately, preserves the existing connection controls, and clearly states that automatic sign-in is not available in this increment. Removing or changing a connection invalidates its displayed result. Missing diagnostics on an older server must not prevent manual connection management.

Acceptance for this increment:

- Only the authenticated installation owner can inspect a saved connection.
- No request carries credentials and no grant, client registration, or connection record is created or modified by inspection.
- Resource and issuer substitutions, unsafe destinations, unsupported PKCE, malformed metadata, oversized responses, and stalled requests have bounded, truthful outcomes.
- Existing anonymous and manual-token MCP discovery and execution retain their approval behavior.
- Web and native results never use metadata discovery as evidence of connected-account identity, enabled tools, or completed sign-in.

## Optional account authorization

The installation publishes its public client description at `/api/oauth/mcp/client-metadata`. The client identifier and the sole redirect URI are derived from the configured HTTPS `AUTH_URL`. The return route is `/api/oauth/mcp/callback`. Providers using this shared callback must identify their issuer in the authorization response. The owner can use a compatible hosted client or supply a pre-registered client for a specific resource and issuer through `MCP_OAUTH_REGISTRATIONS`. Keep confidential registrations in the installation secret store.

`MCP_OAUTH_ENABLED` defaults to false. Sign-in also needs a valid encryption key and compatible web, agent, and storage versions. Run the database upgrade and qualify the release before turning on account sign-in. Use the same installation URL and registration settings on the web and agent services.

### Lifecycle acceptance

Use separate, versioned OAuth records rather than placing OAuth grants in the manual bearer-token field. Define a shared persistence contract and exercise every supported database adapter before enabling it. Bind each pending flow to its owner, connection, endpoint, issuer, resource, redirect URI, single-use state, expiry, and PKCE verifier. Validate callback issuer information before sending a code to a token endpoint.

Support pre-registered clients and hosted Client ID Metadata Documents first. Keep registration credentials and refresh state bound to the issuing authorization server. Failed or cancelled reconnects must preserve working credentials. Concurrent refresh, revocation, disconnect, and late callbacks must not revive a superseded grant. Store secrets encrypted and return only safe connection summaries.

Complete browser and native sign-in, canonical status confirmation, refresh, cancellation, and disconnect before offering a Sign in button. Tool calls must continue through the current owner approval and ambiguous-outcome recovery paths. Changed targets or sensitive tool definitions must invalidate affected approvals. Generic OAuth does not necessarily establish an account email; display only independently verified identity.

Qualify two independently implemented OAuth MCP servers through connect, an approved read, expiry recovery, and disconnect. Mocked HTTP and local persistence tests are required source evidence; they do not replace real provider and installed-iPhone acceptance.

## Local qualification for the July 2026 transport

Run the discovery qualification and legacy transport tests from the repository root:

```sh
pnpm exec vitest run packages/tools/src/mcp-discovery-qualification.test.ts packages/tools/src/mcp-transport.test.ts packages/tools/src/mcp.test.ts
```

The qualification client sends `server/discover` to a loopback HTTP fixture and follows successive pages of `tools/list` when the server advertises the requested revision and tool support. Each request carries its protocol version and client metadata. The fixture exercises JSON replies and request-scoped Server-Sent Events. Discovery follows each opaque cursor on the same endpoint, with a shared 20-second deadline, up to eight list pages and 80 tools in total. A repeated cursor, duplicate tool name, failed page, or exceeded limit ends the operation with an error. A successful result contains the entire list in server order. Tool schemas that request custom HTTP headers are outside this qualification. This exercise uses synthetic tools and requires no provider account or credentials.

Saved connections still use the November 2025 transport. Modern tool execution, protocol selection between revisions, and interoperability with a hosted provider remain open before enabling this revision for saved connections. See the [Streamable HTTP binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [pagination rules](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination), and [versioning rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).

## Remaining Phase 3 work

1. Qualify the newer MCP transport independently while preserving existing server compatibility.
2. Add a selected-repository GitHub App connection, starting with repository and pull-request reads. Unselected repositories and revoked installations must be inaccessible.
3. Add approved issue and draft pull-request creation with same-operation result confirmation. Merge and deployment remain separate actions.
4. Publish a curated service entry only after its authentication, capability mapping, failure states, and concrete recurring task are verified. Optional brokers and remote runtimes remain adapters.

Phase 2's provider and iPhone acceptance remains tracked separately. Starting this source work does not declare those checks complete or authorize a production access change.

## Protocol references

- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Authorization-server discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)
- [Client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
- [Authorization security requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [Transport version boundary](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)

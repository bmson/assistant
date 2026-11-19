# Google OAuth setup for the assistant account

This creates a refresh token that lets the assistant act through its own Gmail, Calendar, and Drive
identity. The flow does not use domain-wide delegation: the configured `ASSISTANT_EMAIL` authorizes
itself once through `pnpm auth:bot`.

## 1. Project and APIs

`infra/gcp/deploy.sh` enables the APIs the google module declares — Gmail, Calendar, Docs, Sheets,
Slides, and Drive — so there is nothing to enable by hand once the module is selected. Run
`pnpm modules:plan` to see the exact list for your installation.

Enable them manually in the project configured by `GCP_PROJECT` only if you are running
`pnpm auth:bot` before the first deployment.

Workspace organizations can use an internal consent screen. Personal Google accounts or assistants
outside the organization require an external consent screen and its corresponding Google testing or
verification configuration.

## 2. OAuth consent screen

In **APIs & Services → OAuth consent screen**:

- choose the audience appropriate to the account;
- name the application;
- add a support email;
- add `ASSISTANT_EMAIL` as a test user when the app is external and remains in testing.

## 3. OAuth client

In **APIs & Services → Credentials**, create a Web application OAuth client with this authorized
redirect URI:

```text
http://localhost:8123/callback
```

Put the credentials in `.env`:

```dotenv
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
```

The web dashboard may use the same client or a separate client through `AUTH_GOOGLE_ID` and
`AUTH_GOOGLE_SECRET`.

## 4. Workspace trust

If Google Workspace blocks the requested services, an administrator must allow the OAuth client in
**Admin Console → Security → Access and data control → API controls**. Grant only the client used by
this installation.

## 5. Authorize the assistant

Confirm that `.env` contains the account that should own the assistant's workspace:

```dotenv
ASSISTANT_EMAIL=assistant@example.com
```

Then run:

```sh
pnpm auth:bot
```

Open the printed URL while signed in as `ASSISTANT_EMAIL`. On success, the script writes
`BOT_GOOGLE_REFRESH_TOKEN` to `.env`. Run `pnpm config:check` to confirm the Google module is ready.

## Token maintenance

Changing scopes, revoking app access, or some account security changes can invalidate the token.
Rerun `pnpm auth:bot` whenever the Google module reports an authorization or insufficient-scope
error after one of those changes.

## Optional personal Google Calendar connection

The iPhone app can separately connect one personal Google account for calendar reads. This does
not replace `BOT_GOOGLE_REFRESH_TOKEN`, change the assistant's identity, or grant personal Gmail,
Drive, or Calendar write access. All integrations remain optional; an installation without these
settings continues using its existing assistant-account setup and phone calendar sharing.

1. Enable the `calendar` module (reads only) or keep the existing `google` module. Enable the
   Calendar API in the OAuth client's project.
2. Keep the existing `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Add this additional
   authorized redirect URI to that web application's OAuth client:
   `https://<your-assistant-web-host>/api/oauth/google-calendar/callback`. Retain the existing bot
   and dashboard redirect URIs. The callback must be an HTTPS URL without a query or fragment.
3. Set `GOOGLE_CALENDAR_OAUTH_CALLBACK_URL` to that exact URL on **both web and agent**. Both
   services must use the same OAuth client and the same stable, 64-character hexadecimal
   `MCP_ENC_KEY`. This optional Calendar helper prefers a complete `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET` pair, then accepts a complete `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`
   pair. It never mixes half-pairs. Web can reuse its existing dashboard secret bindings when
   they identify the same client as agent; no alias or assistant-account change is needed.
   For an existing protected deployment, set the optional `google_calendar_oauth_callback_url`
   input on a full agent/web release. It validates and applies the same callback to both candidate
   revisions, including the paused and resumed Firestore web revisions, before promotion. An empty
   input preserves existing configuration. Existing release readiness and maintenance requirements
   still apply; this input does not activate editor metadata or bypass those checks.
   The PostgreSQL `infra/gcp/deploy.sh` also forwards the optional environment setting for setup.
   Do not rotate the encryption key without migrating stored credentials.
4. Configure the OAuth audience for the personal account, including test-user access when
   applicable. The requested scopes are `openid`, `email`, and
   `https://www.googleapis.com/auth/calendar.readonly`. Consent and any Google verification remain
   provider setup steps. See [Google's server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
   and [Calendar scope reference](https://developers.google.com/workspace/calendar/api/auth).
5. After the server migration and an updated iPhone app are installed, open **More → Services →
   Google Calendar → Connect Google Calendar**. Complete Google's system-browser sign-in. The app
   shows the verified email and Connected only after the server has verified identity, permission,
   and a Calendar API read. A closed browser or callback alone does not confirm a connection.

The refresh token, access-token cache and pending sign-in verifier are encrypted at rest in the
selected PostgreSQL or Firestore store. A short-lived, single-use flow binds the callback to the
authenticated owner; only its opaque flow ID returns to iPhone. Concurrent refreshes share a
durable lease. Encrypted connection records participate in the existing installation migration
path, like other saved connections; migration artifacts must be treated as sensitive backups.
Import retains consent and the encrypted refresh credential, clears access-token caches and refresh
leases, and cancels unfinished sign-ins. Restart any pending sign-in after migration.
Keep the same encryption key, owner identity, OAuth client and callback when moving an installation,
or reconnect the personal account. Migration does not provision those external settings.

Once adopted, personal Calendar becomes the default for the four Calendar read tools. The optional
`account: 'assistant'` selector explicitly reads the assistant account. A personal connection error
or disconnect never silently switches a read to the assistant account. Calendar mutations, Gmail
and Drive keep using the existing assistant credentials; iPhone calendar sharing keeps its existing
owner identity.

Reconnect requires the same Google identity; disconnect first to select another account.
Disconnect removes this installation's stored personal credentials and stops subsequent personal
reads. It does not erase previous answers or revoke the OAuth application in Google Account
settings, since revoking a shared application could also disrupt existing assistant grants.
Any read already in flight may finish. Cancelling a new sign-in leaves a previously connected
account intact. Google outages and expired/revoked permissions have distinct unavailable and
reconnect states.

No personal computer, always-on desktop, or browser automation worker is required. OAuth opens
the iPhone system browser; the assistant uses Google's API on the server.

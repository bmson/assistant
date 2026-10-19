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

## Connect an additional Google Workspace calendar (including Okta)

The owner can add separate calendar accounts from **Settings → Connected calendars → Add Google account**.
This requests only `openid`, `email`, and `https://www.googleapis.com/auth/calendar.readonly`.
It does not connect the account's Gmail, send mail, RSVP, or write work events.
Google runs the account's normal sign-in, including a configured Okta SSO/MFA redirect.
The assistant never asks for the work password or a two-factor code.

Before using the button:

1. Enable the `calendar` or `google` module in `ASSISTANT_MODULES`. Configure `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` for a **Web application** client,
   set `AUTH_URL` to the dashboard's canonical HTTPS origin, and configure `MCP_ENC_KEY` as 32 random bytes
   encoded in 64 hexadecimal characters. Both web and agent services need the same credentials and key.
2. When the web and integration use the same Google client, calendar consent automatically reuses
   the existing `/api/auth/callback/google` address. Existing installations may provide that client
   through `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` on the web service; the agent must use the same
   client through `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
   When using a separate integration client (including passkey installations), add this exact
   authorized redirect URI to that Google OAuth client:
   `https://YOUR-ASSISTANT-HOST/api/calendar-accounts/callback`.
   Local development allows `http://localhost:3000/api/calendar-accounts/callback` when `AUTH_URL`
   matches. The bot's existing `http://localhost:8123/callback` remains a separate redirect URI.
3. Enable the Calendar API. Allow the work account in the OAuth consent audience/test users as needed.
   An internal-only OAuth client cannot authorize accounts outside its organization.
4. If the employer blocks third-party calendar apps, have IT allow this client and the read-only Calendar
   scope through Google Workspace API controls. This connection respects those policies.
5. Apply database migrations before starting a PostgreSQL deployment. Firestore uses the installation's
   `calendarAccounts` collection. Refresh tokens are encrypted with the existing credential encryption key.

Each connected account contributes its readable calendars to calendar listing, event reading/search,
free/busy checks, and briefing reads. Calendars with the same Google calendar ID are merged; the
calendar owner's direct grant takes precedence over the bot's shared-calendar access.
Provider failures preserve incomplete-coverage reporting; an unavailable work account never proves
that the owner is free. Reconnect in Settings if consent expires or organizational policies require it.
Disconnect deletes the saved encrypted grant and stops subsequent reads through that account.
Previously read events in conversations are not erased by disconnecting.

For production use, finish any Google OAuth verification required by the consent screen; testing-mode
refresh tokens can expire. No account is connected until the owner completes Google's consent flow.

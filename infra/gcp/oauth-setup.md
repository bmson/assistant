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

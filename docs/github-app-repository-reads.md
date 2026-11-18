# Selected GitHub repository reads

This developer preview is a server-side GitHub App reader and local command. It returns a summary of one selected repository or one pull request by number.

Use an existing GitHub.com App installed on a user or organization account. Choose **Only select repositories** in the installation settings and grant **Metadata: Read** and **Pull requests: Read**. Use a dedicated read-only app and keep its private key in a restricted local file outside the checkout. The reader uses GitHub's documented [App JWT signing](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) and [scoped installation token exchange](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#create-an-installation-access-token-for-an-app).

Set these variables in the local shell:

| Variable                                   | Value                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `ASSISTANT_GITHUB_APP_CLIENT_ID`           | GitHub App client ID                                                    |
| `ASSISTANT_GITHUB_APP_INSTALLATION_ID`     | Numeric ID of the app installation                                      |
| `ASSISTANT_GITHUB_APP_PRIVATE_KEY_FILE`    | Local path to the app's PEM private key                                 |
| `ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS` | Comma-separated numeric repository IDs authorized for this installation |

```sh
pnpm github:read repository 123456
pnpm github:read pull-request 123456 17
```

The entry point for server code is `createGitHubAppReader` from `@assistant/tools/github-app-reader`. Pass configuration from trusted server code. The adapter takes a snapshot of the local allowlist at construction, so recreate it after changing that list. The local command creates a reader on each invocation.

Each read checks its numeric ID against the local allowlist before making a request. It asks GitHub for a fresh token scoped to that one repository. It rejects unexpected token permissions, verifies current access using GitHub's [installation repository list](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation), and rechecks access before returning a [pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#get-a-pull-request). The PR response must match both the requested number and the selected base repository ID. GitHub API requests use a fixed host and reject redirects. Output contains projected metadata only. Tokens, the signing key, and raw provider errors are kept out of results.

The preview makes no repository writes. It has no app installation flow, account UI, agent tool registration, background reads, file or diff reads, or personal token fallback. It supports GitHub.com and installations that return verifiable single-repository token scope. Revocation is checked on every call using GitHub's live view, and requests already in flight are subject to GitHub's propagation timing. Synthetic fixtures exercise selection and revocation. A live installation and end-user flow still need qualification.

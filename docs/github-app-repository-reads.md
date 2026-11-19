# Selected GitHub repository reads

Assistant can read metadata for a selected GitHub repository and summarize a pull request by number. Set up the optional integration on the agent server or use the same credentials with the local command.

Use an existing GitHub.com App installed on a user or organization account. Choose **Only select repositories** in the installation settings and grant **Metadata: Read** and **Pull requests: Read**. Use a dedicated read-only app and keep its private key in a restricted local file outside the checkout. The reader uses GitHub's documented [App JWT signing](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) and [scoped installation token exchange](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#create-an-installation-access-token-for-an-app).

Set these variables in the agent process environment for chat, or in the local shell for the command. Use an absolute path to a regular private key file readable only by its owner (for example, mode 0600).

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

In chat, try “What is the status of PR #17?” when one repository is selected. With several selections, include the intended repository ID. The approval identifies the repository and PR. After approval, Assistant can report the title, open or closed state, draft and merge status, last update, and link. Repository reads report the default branch, visibility, and archive status. Listing the configured repository IDs uses local configuration.

The entry point for server code is `createGitHubAppReader` from `@assistant/tools/github-app-reader`. Pass configuration from trusted server code. The adapter takes a snapshot of the local allowlist at construction, so recreate it after changing that list. The local command creates a reader on each invocation.

Each read checks its numeric ID against the local allowlist before making a request. It asks GitHub for a fresh token scoped to that one repository. It rejects unexpected token permissions, verifies current access using GitHub's [installation repository list](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation), and rechecks access before returning a [pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#get-a-pull-request). The PR response must match both the requested number and the selected base repository ID. GitHub API requests use a fixed host and reject redirects. Output contains projected metadata only. Tokens, the signing key, and raw provider errors are kept out of results.

The repository and pull-request tools use read-only installation tokens. The owner manages installation access and repository selection in GitHub and in the agent configuration. It supports GitHub.com and installations that return verifiable single-repository token scope. Revocation is checked on every call using GitHub's live view, and requests already in flight are subject to GitHub's propagation timing. Synthetic fixtures exercise selection and revocation.

### Verification

On November 18, 2026, the local command used a private GitHub App installed on the public `bmson/assistant` repository to read repository metadata and PR #936. It also rejected an unselected repository ID. A separate agent dispatcher test used that same live installation with an isolated Firestore emulator. The read paused for approval and returned the expected repository ID, PR number, and URL after a simulated approval. Adding a conflicting installation owner before a second approved read caused the dispatcher to reject the operation.

The live provider read and simulated approval cover the server path. Approval from the chat interface and live installation revocation remain unverified.

## Optional issue creation

Issue creation is off by default. The existing repository and PR reads work with their documented read permissions. To enable issue creation on a chosen installation, its GitHub App needs **Issues: Read and write** for the selected repository, and the agent needs `ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED=true`. Changing the server flag does not grant GitHub permissions.

Ask Assistant to open an issue in a selected repository. Review the repository name and ID, the title, and the body before approving. GitHub issues are visible to people with access to that repository. This tool accepts bodies up to 8,000 characters. Each issue requires a separate approval.

Assistant requests an installation token for the selected repository and verifies the destination before posting. It reads the returned issue back before reporting a confirmed creation. If GitHub may have received the issue but confirmation failed, Assistant reports an uncertain outcome and suppresses automatic retries. Check the repository before requesting another issue. Approving a new request with the same title and body can create a second issue. [GitHub issue API](https://docs.github.com/en/rest/issues/issues#create-an-issue)

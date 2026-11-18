import { readFile } from 'node:fs/promises';
import { createGitHubAppReader, GitHubAppReadError } from '@assistant/tools/github-app-reader';

const usage = `Usage:
  pnpm github:read repository <repository-id>
  pnpm github:read pull-request <repository-id> <pull-request-number>

Set ASSISTANT_GITHUB_APP_CLIENT_ID, ASSISTANT_GITHUB_APP_INSTALLATION_ID,
ASSISTANT_GITHUB_APP_PRIVATE_KEY_FILE and ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS
(comma-separated IDs) in your local environment.`;

function number(value: string | undefined) {
  return value && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return;
  }
  const [command, repo, pr] = args;
  const repository = command === 'repository' && args.length === 2;
  const pullRequest = command === 'pull-request' && args.length === 3;
  if (
    (!repository && !pullRequest) ||
    !Number.isSafeInteger(number(repo)) ||
    (pullRequest && !Number.isSafeInteger(number(pr)))
  ) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }

  const env = process.env;
  const allowed = (env.ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS ?? '')
    .split(',')
    .map((value) => number(value.trim()));
  const keyFile = env.ASSISTANT_GITHUB_APP_PRIVATE_KEY_FILE;
  const appClientId = env.ASSISTANT_GITHUB_APP_CLIENT_ID;
  const installationId = number(env.ASSISTANT_GITHUB_APP_INSTALLATION_ID);
  if (
    !keyFile ||
    !appClientId ||
    !Number.isSafeInteger(installationId) ||
    allowed.some((id) => !Number.isSafeInteger(id))
  ) {
    throw new GitHubAppReadError('invalid_configuration');
  }
  if (!allowed.includes(number(repo))) throw new GitHubAppReadError('repository_not_selected');

  const privateKey = await readFile(keyFile, 'utf8').catch(() => {
    throw new GitHubAppReadError('invalid_configuration');
  });
  const reader = createGitHubAppReader({
    appClientId,
    installationId,
    privateKey,
    selectedRepositoryIds: allowed,
  });
  const result = repository
    ? await reader.getRepository(number(repo))
    : await reader.getPullRequest(number(repo), number(pr));
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof GitHubAppReadError ? error.message : 'GitHub App read failed.');
  process.exitCode = 1;
}

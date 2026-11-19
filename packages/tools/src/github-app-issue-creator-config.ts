import { githubIssueCreationEnabled } from '@assistant/config';
import type { createGitHubAppIssueCreator as CreatorFactory } from './github-app-issue-creator.js';
import {
  createGitHubAppIssueCreator,
  GitHubAppIssueCreateError,
} from './github-app-issue-creator.js';
import {
  type GitHubAppSelection,
  inspectGitHubAppKeyFile,
  loadGitHubAppKey,
  publicGitHubAppSelection,
  readGitHubAppConfiguration,
} from './github-app-reader-config.js';

type Creator = ReturnType<typeof CreatorFactory>;

function enabled(env: NodeJS.ProcessEnv): boolean {
  return githubIssueCreationEnabled({
    ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED: env.ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED === 'true',
    RESTORE_REHEARSAL: env.RESTORE_REHEARSAL === 'true',
    ASSISTANT_RELEASE_WRITES_PAUSED: env.ASSISTANT_RELEASE_WRITES_PAUSED === 'true',
    PERSISTENCE_DRIVER: env.PERSISTENCE_DRIVER === 'firestore' ? 'firestore' : 'postgres',
    POSTGRES_SOURCE_WRITES_FENCED: env.POSTGRES_SOURCE_WRITES_FENCED === 'true',
  });
}

/** Separate optional writer configuration. The existing reader remains read-only. */
export async function configuredGitHubAppIssueCreator(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<(Creator & { readonly selection: GitHubAppSelection }) | null> {
  if (!enabled(env)) return null;
  const initial = readGitHubAppConfiguration(env);
  if (!initial) return null;
  const initialKey = await loadGitHubAppKey(initial.keyFile);
  if (!initialKey) return null;
  const selection = publicGitHubAppSelection(initial);
  let signingKey = initialKey;
  const selectionIds = JSON.stringify([...selection.selectedRepositoryIds].sort((a, b) => a - b));
  function current(repoId: number, signal?: AbortSignal) {
    if (signal?.aborted) throw new GitHubAppIssueCreateError('request_failed');
    const value = readGitHubAppConfiguration(env);
    if (
      !enabled(env) ||
      !value ||
      value.appClientId !== selection.appClientId ||
      value.installationId !== selection.installationId ||
      value.keyFile !== initial?.keyFile
    )
      throw new GitHubAppIssueCreateError('invalid_configuration');
    if (!value.selectedRepositoryIds.has(repoId))
      throw new GitHubAppIssueCreateError('repository_not_selected');
    if (JSON.stringify([...value.selectedRepositoryIds].sort((a, b) => a - b)) !== selectionIds)
      throw new GitHubAppIssueCreateError('invalid_configuration');
    return value;
  }
  return {
    selection,
    async createIssue(repoId, input, signal, preflight) {
      if (!Number.isSafeInteger(repoId) || repoId < 1)
        throw new GitHubAppIssueCreateError('invalid_input');
      const config = current(repoId, signal);
      const key = await loadGitHubAppKey(config.keyFile, signingKey);
      if (!key) throw new GitHubAppIssueCreateError('invalid_configuration');
      signingKey = key;
      current(repoId, signal);
      const assertCurrent = async () => {
        current(repoId, signal);
        const unchanged = await inspectGitHubAppKeyFile(
          config.keyFile,
          (_file, version) => version === key.version,
        );
        if (!unchanged) throw new GitHubAppIssueCreateError('invalid_configuration');
        current(repoId, signal);
      };
      await assertCurrent();
      const creator = createGitHubAppIssueCreator(
        {
          appClientId: selection.appClientId,
          installationId: selection.installationId,
          privateKey: key.key,
          selectedRepositoryIds: selection.selectedRepositoryIds,
        },
        options,
      );
      return creator.createIssue(repoId, input, signal, async () => {
        await assertCurrent();
        await preflight?.();
        await assertCurrent();
      });
    },
  };
}

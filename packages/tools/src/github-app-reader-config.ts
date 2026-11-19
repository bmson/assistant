import { createPrivateKey, type KeyObject } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createGitHubAppReader, GitHubAppReadError } from './github-app-reader.js';

const MAX_KEY_BYTES = 16 * 1024;
const MAX_REPOSITORIES = 100;
const MAX_CONFIG_VALUE_LENGTH = 4096;

type Reader = ReturnType<typeof createGitHubAppReader>;

interface Selection {
  readonly appClientId: string;
  readonly installationId: number;
  readonly selectedRepositoryIds: readonly number[];
}

interface LoadedKey {
  path: string;
  version: string;
  key: KeyObject;
}

function positiveId(value: string | undefined) {
  if (!value || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function readConfiguration(env: NodeJS.ProcessEnv) {
  const appClientId = env.ASSISTANT_GITHUB_APP_CLIENT_ID;
  const installationId = positiveId(env.ASSISTANT_GITHUB_APP_INSTALLATION_ID);
  const keyFile = env.ASSISTANT_GITHUB_APP_PRIVATE_KEY_FILE;
  const ids = env.ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS;
  if (
    !appClientId ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(appClientId) ||
    installationId === null ||
    !keyFile ||
    keyFile.length > MAX_CONFIG_VALUE_LENGTH ||
    [...keyFile].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    !isAbsolute(keyFile) ||
    !ids ||
    ids.length > MAX_CONFIG_VALUE_LENGTH
  ) {
    return null;
  }

  const selectedRepositoryIds = new Set<number>();
  const items = ids.split(',');
  if (items.length > MAX_REPOSITORIES) return null;
  for (const value of items) {
    const id = positiveId(value.trim());
    if (id === null || selectedRepositoryIds.has(id)) return null;
    selectedRepositoryIds.add(id);
  }

  return { appClientId, installationId, keyFile, selectedRepositoryIds };
}

type Configuration = NonNullable<ReturnType<typeof readConfiguration>>;

function publicSelection(config: Configuration): Selection {
  return Object.freeze({
    appClientId: config.appClientId,
    installationId: config.installationId,
    selectedRepositoryIds: Object.freeze([...config.selectedRepositoryIds]),
  });
}

/** Validate local configuration and return only the app, installation and selected IDs. */
export function configuredGitHubAppSelection(
  env: NodeJS.ProcessEnv = process.env,
): Selection | null {
  const config = readConfiguration(env);
  return config ? publicSelection(config) : null;
}

function fileVersion(stat: Stats) {
  return JSON.stringify([
    stat.dev,
    stat.ino,
    stat.nlink,
    stat.mode,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ]);
}

async function inspectKeyFile<T>(
  keyFile: string,
  inspect: (file: FileHandle, version: string, size: number) => T | Promise<T>,
): Promise<T | null> {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    return null;
  }
  try {
    // Check the open descriptor, not a path that could be replaced between stat and read.
    // Nonblocking open lets an accidentally configured FIFO fail without waiting for a writer.
    const file = await open(
      keyFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink === 0 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size < 1 ||
        stat.size > MAX_KEY_BYTES
      ) {
        return null;
      }
      return await inspect(file, fileVersion(stat), stat.size);
    } finally {
      await file.close();
    }
  } catch {
    // Paths, filesystem errors and key parser errors are never surfaced.
    return null;
  }
}

async function loadKey(keyFile: string, previous?: LoadedKey): Promise<LoadedKey | null> {
  return inspectKeyFile(keyFile, async (file, version, expectedSize) => {
    if (previous?.path === keyFile && previous.version === version) return previous;
    const bytes = Buffer.alloc(expectedSize + 1);
    try {
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, size);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      if (size !== expectedSize || fileVersion(await file.stat()) !== version) return null;
      const key = createPrivateKey(bytes.subarray(0, size));
      if (
        key.type !== 'private' ||
        key.asymmetricKeyType !== 'rsa' ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      ) {
        return null;
      }
      return { path: keyFile, version, key };
    } finally {
      bytes.fill(0);
    }
  });
}

/** Optional server configuration pinned to the initial app and installation identity. */
export async function configuredGitHubAppReader(
  env: NodeJS.ProcessEnv = process.env,
): Promise<(Reader & { readonly selection: Selection }) | null> {
  const configured = readConfiguration(env);
  if (!configured) return null;
  const initialKey = await loadKey(configured.keyFile);
  if (!initialKey) return null;
  const selection = publicSelection(configured);
  let signingKey = initialKey;

  function currentConfiguration(repoId: number, signal?: AbortSignal, expectedKeyFile?: string) {
    if (signal?.aborted) throw new GitHubAppReadError('request_failed');
    const config = readConfiguration(env);
    if (
      !config ||
      config.appClientId !== selection.appClientId ||
      config.installationId !== selection.installationId ||
      (expectedKeyFile !== undefined && config.keyFile !== expectedKeyFile)
    ) {
      throw new GitHubAppReadError('invalid_configuration');
    }
    if (!config.selectedRepositoryIds.has(repoId)) {
      throw new GitHubAppReadError('repository_not_selected');
    }
    return config;
  }

  async function read<T>(
    repoId: number,
    signal: AbortSignal | undefined,
    operation: (reader: Reader) => Promise<T>,
  ) {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitHubAppReadError('invalid_input');
    }
    const config = currentConfiguration(repoId, signal);
    const key = await loadKey(config.keyFile, signingKey);
    if (!key) throw new GitHubAppReadError('invalid_configuration');
    signingKey = key;
    const latest = currentConfiguration(repoId, signal, config.keyFile);
    const reader = createGitHubAppReader({
      appClientId: selection.appClientId,
      installationId: selection.installationId,
      selectedRepositoryIds: [...latest.selectedRepositoryIds],
      privateKey: key.key,
    });
    const result = await operation(reader);
    currentConfiguration(repoId, signal, config.keyFile);
    const keyStillCurrent = await inspectKeyFile(
      config.keyFile,
      (_file, version) => version === key.version,
    );
    if (!keyStillCurrent) throw new GitHubAppReadError('invalid_configuration');
    currentConfiguration(repoId, signal, config.keyFile);
    return result;
  }

  return {
    selection,
    getRepository(repoId, signal) {
      return read(repoId, signal, (reader) => reader.getRepository(repoId, signal));
    },
    async getPullRequest(repoId, number, signal) {
      if (!Number.isSafeInteger(number) || number < 1) {
        throw new GitHubAppReadError('invalid_input');
      }
      return read(repoId, signal, (reader) => reader.getPullRequest(repoId, number, signal));
    },
  };
}

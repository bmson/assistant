import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth } from 'google-auth-library';

export interface ReadOnlyJsonClient {
  get(url: URL, signal?: AbortSignal): Promise<unknown>;
}

export interface ReadOnlyJsonLease {
  client: ReadOnlyJsonClient;
  /** Aborts HTTP reads; an already dispatched ADC lookup may still finish. */
  disposeClients(): Promise<void>;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RPC_MS = 10_000;
const MAX_RUN_MS = 60_000;

function allowedRead(url: URL): boolean {
  if (url.username || url.password || url.hash) return false;
  const segment = '[A-Za-z0-9_.()~-]+';
  const execution = new RegExp(
    `^/v2/projects/${segment}/locations/${segment}/jobs/${segment}/executions/${segment}(/tasks)?$`,
  );
  const indexes = new RegExp(
    `^/v1/projects/${segment}/databases/${segment}/collectionGroups/${segment}/(indexes|fields)$`,
  );
  if (
    !(
      (url.origin === 'https://run.googleapis.com' && execution.test(url.pathname)) ||
      (url.origin === 'https://firestore.googleapis.com' && indexes.test(url.pathname))
    )
  )
    return false;
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === 'pageSize' && !/^(2|100)$/.test(value)) return false;
    if (key === 'pageToken' && (!value || value.length > 4096)) return false;
    if (key === 'filter' && value !== 'indexConfig.usesAncestorConfig:false') return false;
    if (!['pageSize', 'pageToken', 'filter'].includes(key)) return false;
  }
  return true;
}

/** Test seam for the same bounded reader; no method or origin override is exposed. */
export function createOwnerEditorReadOnlyJsonClient(dependencies: {
  getAccessToken(): Promise<string | null | undefined>;
  fetch: typeof globalThis.fetch;
  now?: () => number;
}): ReadOnlyJsonLease {
  const now = dependencies.now ?? Date.now;
  const deadline = now() + MAX_RUN_MS;
  const controllers = new Set<AbortController>();
  let closed = false;
  return {
    client: {
      async get(url, externalSignal) {
        let target: string;
        try {
          const snapshot = new URL(url.href);
          if (!allowedRead(snapshot)) throw new Error('unsupported');
          target = snapshot.href;
        } catch {
          throw new Error('Read-only inspection is unavailable');
        }
        if (closed || externalSignal?.aborted)
          throw new Error('Read-only inspection is unavailable');
        const remaining = Math.min(MAX_RPC_MS, deadline - now());
        if (remaining <= 0) throw new Error('Read-only inspection is unavailable');
        const controller = new AbortController();
        controllers.add(controller);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => controller.abort();
        externalSignal?.addEventListener('abort', abort, { once: true });
        try {
          return await Promise.race([
            new Promise<never>((_resolve, reject) => {
              const expire = () => {
                controller.abort();
                reject(new Error('Read-only inspection is unavailable'));
              };
              timer = setTimeout(expire, remaining);
              controller.signal.addEventListener(
                'abort',
                () => reject(new Error('Read-only inspection is unavailable')),
                { once: true },
              );
            }),
            (async () => {
              const token = await dependencies.getAccessToken();
              // ADC lookup cannot necessarily be cancelled. Never dispatch a late API read.
              if (!token || controller.signal.aborted || closed || now() >= deadline)
                throw new Error('Read-only inspection is unavailable');
              const response = await dependencies.fetch(target, {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                redirect: 'error',
                signal: controller.signal,
              });
              if (!response.ok || !response.body)
                throw new Error('Read-only inspection is unavailable');
              const length = response.headers.get('content-length');
              if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))
                throw new Error('Read-only inspection is unavailable');
              const reader = response.body.getReader();
              const chunks: Uint8Array[] = [];
              let size = 0;
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  size += value.byteLength;
                  if (size > MAX_RESPONSE_BYTES || controller.signal.aborted)
                    throw new Error('Read-only inspection is unavailable');
                  chunks.push(value);
                }
              } finally {
                await reader.cancel().catch(() => undefined);
                reader.releaseLock();
              }
              if (controller.signal.aborted || closed || now() >= deadline)
                throw new Error('Read-only inspection is unavailable');
              const bytes = new Uint8Array(size);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
              }
              return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
            })(),
          ]);
        } catch {
          controller.abort();
          throw new Error('Read-only inspection is unavailable');
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          externalSignal?.removeEventListener('abort', abort);
          controllers.delete(controller);
        }
      },
    },
    async disposeClients() {
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}

/** Synchronous construction only. ADC/network resolution occurs inside bounded GET calls. */
export function createAdcOwnerEditorReadOnlyJsonClient(): ReadOnlyJsonLease {
  if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE ||
    existsSync(join(homedir(), '.config/gcloud/application_default_credentials.json')) ||
    (process.env.CLOUDSDK_CONFIG &&
      existsSync(join(process.env.CLOUDSDK_CONFIG, 'application_default_credentials.json')))
  )
    throw new Error('Read-only inspection is unavailable');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return createOwnerEditorReadOnlyJsonClient({
    getAccessToken: () => auth.getAccessToken(),
    fetch: globalThis.fetch,
  });
}

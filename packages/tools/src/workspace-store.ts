import { createHash, randomUUID } from 'node:crypto';
import type { Dir, Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  opendir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const MAX_WORKSPACE_READ_BYTES = 64 * 1024 * 1024;
const MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 5_000;
const STORAGE_TIMEOUT_MS = 60_000;
const MAX_WORKSPACE_PAGE_SIZE = 100;
const MAX_LOCAL_LIST_HANDLES = 128;
const LOCAL_LIST_TTL_MS = 5 * 60_000;

export interface WorkspaceListPage {
  items: Array<{ name: string; dir: boolean }>;
  hasMore: boolean;
  nextCursor: string | null;
  consistency: 'process-snapshot' | 'provider-token';
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`workspace object exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * The assistant's Workspace file store. Local FS for dev; GCS in prod (Cloud
 * Run's filesystem is ephemeral). Browser profiles join this in Phase 6.
 */
export interface WorkspaceStore {
  read(relPath: string): Promise<string>;
  write(relPath: string, content: string): Promise<{ bytes: number }>;
  /** Binary artifacts such as resumes prepared for an approved browser upload. */
  readBytes(relPath: string): Promise<Buffer>;
  writeBytes(relPath: string, content: Buffer, contentType: string): Promise<{ bytes: number }>;
  list(relPath: string): Promise<Array<{ name: string; dir: boolean }>>;
  listPage?(
    relPath: string,
    input: { cursor: string | null; limit: number },
  ): Promise<WorkspaceListPage>;
  /** Remove a file. Missing files are a no-op, not an error. */
  delete(relPath: string): Promise<void>;
  /** GCS-only version fencing for durable asset cleanup intents. */
  objectGeneration?(relPath: string): Promise<string | null>;
  deleteGeneration?(relPath: string, generation: string): Promise<void>;
  /** Explicit opt-in for crash-safe email attachment custody; local stores do not implement it. */
  readonly emailAttachmentCustody?: EmailAttachmentCustodyStore;
}

export interface EmailAttachmentCustodyStore {
  /** Create an empty opaque marker only when the final object key has no live generation. */
  createEmailAttachmentMarker(custodyId: string): Promise<{ generation: string }>;
  /** Replace exactly the persisted marker generation with bytes and matching ownership metadata. */
  replaceEmailAttachmentMarker(input: {
    custodyId: string;
    markerGeneration: string;
    content: Buffer;
    contentType: string;
    sha256: string;
  }): Promise<{ generation: string }>;
  /** Inspect metadata without reading private object bytes. */
  inspectEmailAttachmentObject(
    custodyId: string,
    generation?: string,
  ): Promise<{
    generation: string;
    custodyId: string;
    state: 'marker' | 'content';
    sha256: string | null;
  } | null>;
  /** Delete only a live object whose immutable custody metadata matches this intent. */
  deleteOwnedEmailAttachment(input: {
    custodyId: string;
    expectedGeneration?: string;
    expectedSha256?: string;
  }): Promise<'deleted' | 'missing' | 'changed'>;
}

export function requireEmailAttachmentCustodyStore(
  store: WorkspaceStore,
): EmailAttachmentCustodyStore {
  if (!store.emailAttachmentCustody) throw new Error('email_attachment_custody_unsupported');
  return store.emailAttachmentCustody;
}

/** Reject traversal; normalize to forward slashes. */
export function safeRelPath(rel: string): string {
  const normalized = path.posix.normalize(rel.replaceAll('\\', '/')).replace(/^\/+/, '');
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error('path escapes the workspace');
  }
  return normalized;
}

export { allowedArtifactPath, immutableArtifactPath } from '@assistant/persistence/artifact-path';

export class LocalWorkspaceStore implements WorkspaceStore {
  private readonly localListings = new Map<string, LocalListingState>();

  constructor(private root: string) {}

  private async canonicalRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return realpath(this.root);
  }

  private assertInside(root: string, target: string): string {
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error('workspace path resolves outside the workspace');
    }
    return target;
  }

  private async resolveExisting(rel: string): Promise<string> {
    const root = await this.canonicalRoot();
    const requested = path.join(root, safeRelPath(rel));
    const resolved = this.assertInside(root, await realpath(requested));
    if (requested !== resolved) throw new Error('workspace reads through symlinks are blocked');
    return resolved;
  }

  private async resolveWrite(rel: string): Promise<string> {
    const root = await this.canonicalRoot();
    const target = path.join(root, safeRelPath(rel));
    await mkdir(path.dirname(target), { recursive: true });
    this.assertInside(root, await realpath(path.dirname(target)));
    const info = await lstat(target).catch((error) => {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('workspace writes through symlinks are blocked');
    return target;
  }

  async read(rel: string): Promise<string> {
    const target = await this.resolveExisting(rel);
    const info = await stat(target);
    if (info.size > MAX_WORKSPACE_READ_BYTES) {
      throw new Error(`workspace file exceeds ${MAX_WORKSPACE_READ_BYTES} bytes`);
    }
    return readFile(target, 'utf8');
  }

  async write(rel: string, content: string): Promise<{ bytes: number }> {
    const target = await this.resolveWrite(rel);
    await writeFile(target, content, 'utf8');
    return { bytes: Buffer.byteLength(content) };
  }

  async readBytes(rel: string): Promise<Buffer> {
    const target = await this.resolveExisting(rel);
    const info = await stat(target);
    if (info.size > MAX_WORKSPACE_READ_BYTES) {
      throw new Error(`workspace file exceeds ${MAX_WORKSPACE_READ_BYTES} bytes`);
    }
    return readFile(target);
  }

  async writeBytes(rel: string, content: Buffer, _contentType: string): Promise<{ bytes: number }> {
    if (content.length > MAX_WORKSPACE_READ_BYTES) {
      throw new Error(`workspace file exceeds ${MAX_WORKSPACE_READ_BYTES} bytes`);
    }
    const target = await this.resolveWrite(rel);
    await writeFile(target, content);
    return { bytes: content.length };
  }

  async list(rel: string): Promise<Array<{ name: string; dir: boolean }>> {
    const target = await this.resolveExisting(rel || '.').catch((error) => {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    });
    if (!target) return [];
    const entries = await readdir(target, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
  }

  async listPage(
    rel: string,
    input: { cursor: string | null; limit: number },
  ): Promise<WorkspaceListPage> {
    validateListPageInput(input.limit);
    const target = await this.resolveExisting(rel || '.').catch((error) => {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    });
    if (!target) {
      if (input.cursor) throw new Error('workspace continuation is stale');
      return { items: [], hasMore: false, nextCursor: null, consistency: 'process-snapshot' };
    }

    const rootIdentity = createHash('sha256')
      .update(await this.canonicalRoot())
      .digest('hex');
    const relativePath = safeRelPath(rel || '.');
    if (!input.cursor) {
      await this.expireLocalListings();
      if (this.localListings.size >= MAX_LOCAL_LIST_HANDLES)
        throw new Error(
          'Too many local workspace listing cursors; retry after existing cursors expire',
        );
      const before = await stat(target, { bigint: true });
      const state: LocalListingState = {
        id: randomUUID(),
        path: relativePath,
        target,
        rootIdentity,
        fingerprint: directoryFingerprint(before),
        limit: input.limit,
        directory: await opendir(target),
        pending: null,
        nextIndex: 1,
        lastRequestCursor: null,
        lastResponse: null,
        inFlightCursor: null,
        inFlightPage: null,
        expiresAt: Date.now() + LOCAL_LIST_TTL_MS,
        timer: undefined,
      };
      this.localListings.set(state.id, state);
      return this.readLocalListingPage(state, null);
    }

    const decoded = decodeLocalListCursor(input.cursor, relativePath, rootIdentity, input.limit);
    const state = this.localListings.get(decoded.id);
    if (!state || state.expiresAt <= Date.now()) {
      if (state) await this.removeLocalListing(state);
      throw new Error('workspace continuation expired or belongs to a different process');
    }
    if (
      state.path !== relativePath ||
      state.rootIdentity !== rootIdentity ||
      state.fingerprint !== decoded.fingerprint ||
      state.limit !== input.limit
    ) {
      await this.removeLocalListing(state);
      throw new Error('workspace continuation is stale or does not match this directory');
    }
    if (state.inFlightCursor === input.cursor && state.inFlightPage) return state.inFlightPage;
    if (state.lastRequestCursor === input.cursor && state.lastResponse) {
      const current = await stat(target, { bigint: true });
      if (directoryFingerprint(current) !== state.fingerprint) {
        await this.removeLocalListing(state);
        throw new Error('workspace changed during listing; restart the import file page');
      }
      this.refreshLocalListingExpiry(state);
      return state.lastResponse;
    }
    if (decoded.index !== state.nextIndex)
      throw new Error('workspace continuation was already consumed');
    state.inFlightCursor = input.cursor;
    state.inFlightPage = this.continueLocalListingPage(state, input.cursor, target);
    try {
      return await state.inFlightPage;
    } finally {
      state.inFlightCursor = null;
      state.inFlightPage = null;
    }
  }

  private async continueLocalListingPage(
    state: LocalListingState,
    requestCursor: string,
    target: string,
  ): Promise<WorkspaceListPage> {
    const current = await stat(target, { bigint: true });
    if (directoryFingerprint(current) !== state.fingerprint) {
      await this.removeLocalListing(state);
      throw new Error('workspace changed during listing; restart the import file page');
    }
    state.nextIndex += 1;
    return this.readLocalListingPage(state, requestCursor);
  }

  private async readLocalListingPage(
    state: LocalListingState,
    requestCursor: string | null,
  ): Promise<WorkspaceListPage> {
    const items: Array<{ name: string; dir: boolean }> = [];
    try {
      while (items.length < state.limit) {
        const directory = state.directory;
        if (!directory) throw new Error('workspace continuation is stale');
        const entry = state.pending ?? (await directory.read());
        state.pending = null;
        if (!entry) {
          const after = await stat(state.target, { bigint: true });
          if (directoryFingerprint(after) !== state.fingerprint) {
            await this.removeLocalListing(state);
            throw new Error('workspace changed during listing; restart the import file page');
          }
          const page = {
            items,
            hasMore: false,
            nextCursor: null,
            consistency: 'process-snapshot' as const,
          };
          this.rememberLocalListingResponse(state, requestCursor, page);
          await this.closeLocalDirectory(state);
          if (requestCursor === null) await this.removeLocalListing(state);
          return page;
        }
        items.push({ name: entry.name, dir: entry.isDirectory() });
      }
      const directory = state.directory;
      if (!directory) throw new Error('workspace continuation is stale');
      state.pending = await directory.read();
      const after = await stat(state.target, { bigint: true });
      if (directoryFingerprint(after) !== state.fingerprint) {
        await this.removeLocalListing(state);
        throw new Error('workspace changed during listing; restart the import file page');
      }
      if (!state.pending) {
        const page = {
          items,
          hasMore: false,
          nextCursor: null,
          consistency: 'process-snapshot' as const,
        };
        this.rememberLocalListingResponse(state, requestCursor, page);
        await this.closeLocalDirectory(state);
        if (requestCursor === null) await this.removeLocalListing(state);
        return page;
      }
      const nextCursor = encodeLocalListCursor({
        id: state.id,
        path: state.path,
        rootIdentity: state.rootIdentity,
        fingerprint: state.fingerprint,
        limit: state.limit,
        index: state.nextIndex,
      });
      const page = { items, hasMore: true, nextCursor, consistency: 'process-snapshot' as const };
      this.rememberLocalListingResponse(state, requestCursor, page);
      return page;
    } catch (error) {
      await this.removeLocalListing(state);
      throw error;
    }
  }

  private rememberLocalListingResponse(
    state: LocalListingState,
    requestCursor: string | null,
    response: WorkspaceListPage,
  ): void {
    state.lastRequestCursor = requestCursor;
    state.lastResponse = response;
    this.refreshLocalListingExpiry(state);
  }

  private refreshLocalListingExpiry(state: LocalListingState): void {
    state.expiresAt = Date.now() + LOCAL_LIST_TTL_MS;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void this.removeLocalListing(state);
    }, LOCAL_LIST_TTL_MS);
    state.timer.unref?.();
  }

  private async expireLocalListings(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      [...this.localListings.values()]
        .filter((state) => state.expiresAt <= now)
        .map((state) => this.removeLocalListing(state)),
    );
  }

  private async closeLocalDirectory(state: LocalListingState): Promise<void> {
    const directory = state.directory;
    if (!directory) return;
    state.directory = null;
    await directory.close().catch(() => {});
  }

  private async removeLocalListing(state: LocalListingState): Promise<void> {
    if (!this.localListings.has(state.id)) return;
    this.localListings.delete(state.id);
    if (state.timer) clearTimeout(state.timer);
    await this.closeLocalDirectory(state);
  }

  async delete(rel: string): Promise<void> {
    const target = await this.resolveExisting(rel).catch((error) => {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    });
    if (target) await rm(target, { force: true });
  }
}

/** GCS JSON API via the metadata-server token — no SDK. */
export class GcsWorkspaceStore implements WorkspaceStore {
  readonly emailAttachmentCustody: EmailAttachmentCustodyStore = {
    createEmailAttachmentMarker: (custodyId) => this.createEmailAttachmentMarker(custodyId),
    replaceEmailAttachmentMarker: (input) => this.replaceEmailAttachmentMarker(input),
    inspectEmailAttachmentObject: (custodyId, generation) =>
      this.inspectEmailAttachmentObject(custodyId, generation),
    deleteOwnedEmailAttachment: (input) => this.deleteOwnedEmailAttachment(input),
  };

  constructor(
    private bucket: string,
    private prefix: string,
  ) {}

  private async token(): Promise<string> {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  private object(rel: string): string {
    return `${this.prefix}/${safeRelPath(rel)}`.replace(/^\/+/, '');
  }

  async read(rel: string): Promise<string> {
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(this.object(rel))}?alt=media`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (res.status === 404) throw new Error(`no such file: ${rel}`);
    if (!res.ok) throw new Error(`gcs read failed: ${res.status}`);
    return boundedResponseText(res, MAX_WORKSPACE_READ_BYTES);
  }

  async write(rel: string, content: string): Promise<{ bytes: number }> {
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(this.object(rel))}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
        body: content,
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`gcs write failed: ${res.status} ${await res.text()}`);
    return { bytes: Buffer.byteLength(content) };
  }

  async readBytes(rel: string): Promise<Buffer> {
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(this.object(rel))}?alt=media`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (res.status === 404) throw new Error(`no such file: ${rel}`);
    if (!res.ok) throw new Error(`gcs read failed: ${res.status}`);
    return boundedResponseBytes(res, MAX_WORKSPACE_READ_BYTES);
  }

  async writeBytes(rel: string, content: Buffer, contentType: string): Promise<{ bytes: number }> {
    if (content.length > MAX_WORKSPACE_READ_BYTES) {
      throw new Error(`workspace file exceeds ${MAX_WORKSPACE_READ_BYTES} bytes`);
    }
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(this.object(rel))}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        body: new Uint8Array(content),
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`gcs write failed: ${res.status} ${await res.text()}`);
    return { bytes: content.length };
  }

  async delete(rel: string): Promise<void> {
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(this.object(rel))}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`gcs delete failed: ${res.status}`);
    }
  }

  /** Read the exact live generation so callers can persist it with a cleanup intent. */
  async objectGeneration(rel: string): Promise<string | null> {
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(this.object(rel))}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gcs metadata read failed: ${res.status}`);
    const metadata = (await res.json()) as { generation?: unknown };
    if (typeof metadata.generation !== 'string' || !/^[1-9]\d*$/.test(metadata.generation))
      throw new Error('gcs metadata returned an invalid object generation');
    return metadata.generation;
  }

  /** Delete only the generation captured in the durable cleanup intent. */
  async deleteGeneration(rel: string, generation: string): Promise<void> {
    if (!/^[1-9]\d*$/.test(generation)) throw new Error('invalid GCS object generation');
    const token = await this.token();
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(this.object(rel))}`,
    );
    url.searchParams.set('generation', generation);
    url.searchParams.set('ifGenerationMatch', generation);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 404)
      throw new Error(`gcs generation-scoped delete failed: ${res.status}`);
  }

  private emailAttachmentObject(custodyId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(custodyId))
      throw new Error('invalid_email_attachment_custody_id');
    return `email-attachments/custody/${custodyId}`;
  }

  private async multipartCustodyWrite(input: {
    custodyId: string;
    state: 'marker' | 'content';
    content: Buffer;
    contentType: string;
    sha256: string | null;
    ifGenerationMatch: string;
  }): Promise<{ generation: string }> {
    this.emailAttachmentObject(input.custodyId);
    if (
      !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(input.contentType) ||
      input.contentType.length > 200 ||
      input.content.length > MAX_EMAIL_ATTACHMENT_BYTES ||
      (input.state === 'marker' && (input.content.length !== 0 || input.sha256 !== null)) ||
      (input.state === 'content' && input.content.length === 0)
    )
      throw new Error('invalid_email_attachment_object_metadata');
    const object = this.emailAttachmentObject(input.custodyId);
    const boundary = `assistant-${randomUUID()}`;
    const metadata = {
      name: this.object(object),
      contentType: input.contentType,
      metadata: {
        assistantCustodyId: input.custodyId,
        assistantCustodyState: input.state,
        ...(input.sha256 ? { assistantContentSha256: input.sha256 } : {}),
      },
    };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
      Buffer.from(JSON.stringify(metadata)),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${input.contentType}\r\n\r\n`),
      input.content,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const token = await this.token();
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o`);
    url.searchParams.set('uploadType', 'multipart');
    url.searchParams.set('ifGenerationMatch', input.ifGenerationMatch);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`email_attachment_object_write_failed:${response.status}`);
    const result = (await response.json()) as {
      generation?: unknown;
      metadata?: Record<string, unknown>;
    };
    if (
      typeof result.generation !== 'string' ||
      !/^[1-9]\d*$/.test(result.generation) ||
      result.metadata?.assistantCustodyId !== input.custodyId ||
      result.metadata?.assistantCustodyState !== input.state ||
      (input.sha256 && result.metadata?.assistantContentSha256 !== input.sha256)
    )
      throw new Error('email_attachment_object_receipt_invalid');
    return { generation: result.generation };
  }

  private async createEmailAttachmentMarker(custodyId: string): Promise<{ generation: string }> {
    return this.multipartCustodyWrite({
      custodyId,
      state: 'marker',
      content: Buffer.alloc(0),
      contentType: 'application/octet-stream',
      sha256: null,
      ifGenerationMatch: '0',
    });
  }

  private async replaceEmailAttachmentMarker(input: {
    custodyId: string;
    markerGeneration: string;
    content: Buffer;
    contentType: string;
    sha256: string;
  }): Promise<{ generation: string }> {
    if (!/^[1-9]\d*$/.test(input.markerGeneration))
      throw new Error('invalid_email_attachment_marker_generation');
    if (
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(input.contentType) ||
      input.contentType.length > 200 ||
      input.content.length === 0 ||
      createHash('sha256').update(input.content).digest('hex') !== input.sha256
    )
      throw new Error('invalid_email_attachment_content');
    return this.multipartCustodyWrite({
      ...input,
      state: 'content',
      sha256: input.sha256,
      ifGenerationMatch: input.markerGeneration,
    });
  }

  private async inspectEmailAttachmentObject(
    custodyId: string,
    generation?: string,
  ): Promise<{
    generation: string;
    custodyId: string;
    state: 'marker' | 'content';
    sha256: string | null;
  } | null> {
    if (generation !== undefined && !/^[1-9]\d*$/.test(generation))
      throw new Error('invalid GCS object generation');
    const token = await this.token();
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(this.object(this.emailAttachmentObject(custodyId)))}`,
    );
    if (generation !== undefined) url.searchParams.set('generation', generation);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`email_attachment_metadata_read_failed:${response.status}`);
    const metadata = (await response.json()) as {
      generation?: unknown;
      metadata?: Record<string, unknown>;
    };
    if (
      typeof metadata.generation !== 'string' ||
      !/^[1-9]\d*$/.test(metadata.generation) ||
      metadata.metadata?.assistantCustodyId !== custodyId ||
      (metadata.metadata.assistantCustodyState !== 'marker' &&
        metadata.metadata.assistantCustodyState !== 'content')
    )
      return {
        generation: typeof metadata.generation === 'string' ? metadata.generation : '',
        custodyId: '',
        state: 'marker',
        sha256: null,
      };
    const sha256 = metadata.metadata.assistantContentSha256;
    if (
      metadata.metadata.assistantCustodyState === 'content' &&
      (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
    )
      return { generation: metadata.generation, custodyId: '', state: 'content', sha256: null };
    return {
      generation: metadata.generation,
      custodyId,
      state: metadata.metadata.assistantCustodyState,
      sha256: typeof sha256 === 'string' ? sha256 : null,
    };
  }

  private async deleteOwnedEmailAttachment(input: {
    custodyId: string;
    expectedGeneration?: string;
    expectedSha256?: string;
  }): Promise<'deleted' | 'missing' | 'changed'> {
    const current = await this.inspectEmailAttachmentObject(
      input.custodyId,
      input.expectedGeneration,
    );
    if (!current) return 'missing';
    if (
      current.custodyId !== input.custodyId ||
      !current.generation ||
      (input.expectedGeneration && current.generation !== input.expectedGeneration) ||
      (input.expectedSha256 && current.sha256 !== input.expectedSha256)
    )
      return 'changed';
    try {
      await this.deleteGeneration(this.emailAttachmentObject(input.custodyId), current.generation);
    } catch (error) {
      if (error instanceof Error && error.message.endsWith(':412')) return 'changed';
      throw error;
    }
    return 'deleted';
  }

  async list(rel: string): Promise<Array<{ name: string; dir: boolean }>> {
    const token = await this.token();
    const dirPrefix = rel && rel !== '.' ? `${this.object(rel)}/` : `${this.prefix}/`;
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${this.bucket}/o`);
    url.searchParams.set('prefix', dirPrefix);
    url.searchParams.set('delimiter', '/');
    url.searchParams.set('maxResults', '100');
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`gcs list failed: ${res.status}`);
    const data = (await res.json()) as { items?: Array<{ name: string }>; prefixes?: string[] };
    return [
      ...(data.prefixes ?? []).map((p) => ({
        name: p.slice(dirPrefix.length).replace(/\/$/, ''),
        dir: true,
      })),
      ...(data.items ?? [])
        .filter((i) => i.name !== dirPrefix)
        .map((i) => ({ name: i.name.slice(dirPrefix.length), dir: false })),
    ];
  }

  async listPage(
    rel: string,
    input: { cursor: string | null; limit: number },
  ): Promise<WorkspaceListPage> {
    validateListPageInput(input.limit);
    if (input.cursor !== null && input.cursor.length > 8192)
      throw new Error('Invalid workspace continuation');
    const token = await this.token();
    const dirPrefix = rel && rel !== '.' ? `${this.object(rel)}/` : `${this.prefix}/`;
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${this.bucket}/o`);
    url.searchParams.set('prefix', dirPrefix);
    url.searchParams.set('delimiter', '/');
    url.searchParams.set('maxResults', String(input.limit));
    const pageToken = input.cursor
      ? decodeGcsListCursor(input.cursor, this.bucket, this.prefix, safeRelPath(rel || '.'))
      : null;
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`gcs list failed: ${res.status}`);
    const data = (await res.json()) as {
      items?: Array<{ name: string }>;
      prefixes?: string[];
      nextPageToken?: unknown;
    };
    const items = [
      ...(data.prefixes ?? []).map((prefix) => ({
        name: prefix.slice(dirPrefix.length).replace(/\/$/, ''),
        dir: true,
      })),
      ...(data.items ?? [])
        .filter((item) => item.name !== dirPrefix)
        .map((item) => ({ name: item.name.slice(dirPrefix.length), dir: false })),
    ].sort((left, right) => left.name.localeCompare(right.name));
    if (items.length > input.limit) throw new Error('gcs returned an oversized workspace page');
    if (
      data.nextPageToken !== undefined &&
      (typeof data.nextPageToken !== 'string' ||
        data.nextPageToken.length === 0 ||
        data.nextPageToken.length > 4096)
    )
      throw new Error('gcs returned an invalid workspace continuation');
    const nextCursor =
      typeof data.nextPageToken === 'string'
        ? encodeGcsListCursor(this.bucket, this.prefix, safeRelPath(rel || '.'), data.nextPageToken)
        : null;
    return { items, hasMore: nextCursor !== null, nextCursor, consistency: 'provider-token' };
  }
}

function validateListPageInput(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WORKSPACE_PAGE_SIZE)
    throw new Error('workspace page size must be between 1 and 100');
}

function directoryFingerprint(info: Awaited<ReturnType<typeof stat>>): string {
  const value = info as typeof info & {
    dev: bigint;
    ino: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return [value.dev, value.ino, value.mtimeNs, value.ctimeNs].map(String).join(':');
}

interface LocalListingState {
  id: string;
  path: string;
  target: string;
  rootIdentity: string;
  fingerprint: string;
  limit: number;
  directory: Dir | null;
  pending: Dirent | null;
  nextIndex: number;
  lastRequestCursor: string | null;
  lastResponse: WorkspaceListPage | null;
  inFlightCursor: string | null;
  inFlightPage: Promise<WorkspaceListPage> | null;
  expiresAt: number;
  timer: NodeJS.Timeout | undefined;
}

interface LocalListCursor {
  id: string;
  path: string;
  rootIdentity: string;
  fingerprint: string;
  limit: number;
  index: number;
}

function encodeLocalListCursor(cursor: LocalListCursor): string {
  return Buffer.from(JSON.stringify({ v: 2, ...cursor }), 'utf8').toString('base64url');
}

function decodeLocalListCursor(
  value: string,
  path: string,
  rootIdentity: string,
  limit: number,
): LocalListCursor {
  if (value.length > 8192) throw new Error('Invalid workspace continuation');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid workspace continuation');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== 2 ||
    (parsed as { path?: unknown }).path !== path ||
    (parsed as { rootIdentity?: unknown }).rootIdentity !== rootIdentity ||
    typeof (parsed as { id?: unknown }).id !== 'string' ||
    typeof (parsed as { fingerprint?: unknown }).fingerprint !== 'string' ||
    (parsed as { fingerprint: string }).fingerprint.length === 0 ||
    (parsed as { limit?: unknown }).limit !== limit ||
    !Number.isSafeInteger((parsed as { index?: unknown }).index) ||
    (parsed as { index: number }).index < 1
  )
    throw new Error('workspace continuation is stale or does not match this directory');
  return parsed as LocalListCursor;
}

function encodeGcsListCursor(
  bucket: string,
  prefix: string,
  path: string,
  pageToken: string,
): string {
  return Buffer.from(JSON.stringify({ v: 1, bucket, prefix, path, pageToken }), 'utf8').toString(
    'base64url',
  );
}

function decodeGcsListCursor(value: string, bucket: string, prefix: string, path: string): string {
  if (value.length > 8192) throw new Error('Invalid workspace continuation');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid workspace continuation');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== 1 ||
    (parsed as { bucket?: unknown }).bucket !== bucket ||
    (parsed as { prefix?: unknown }).prefix !== prefix ||
    (parsed as { path?: unknown }).path !== path ||
    typeof (parsed as { pageToken?: unknown }).pageToken !== 'string' ||
    !(parsed as { pageToken: string }).pageToken ||
    (parsed as { pageToken: string }).pageToken.length > 4096
  )
    throw new Error('workspace continuation does not match this bucket and prefix');
  return (parsed as { pageToken: string }).pageToken;
}

async function boundedResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`workspace object exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

import { createHash } from 'node:crypto';
import { Dir, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowedArtifactPath,
  GcsWorkspaceStore,
  LocalWorkspaceStore,
  requireEmailAttachmentCustodyStore,
  safeRelPath,
} from './workspace-store.js';

const root = mkdtempSync(path.join(tmpdir(), 'ws-test-'));
const outside = mkdtempSync(path.join(tmpdir(), 'ws-outside-test-'));
const store = new LocalWorkspaceStore(root);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

afterEach(() => vi.unstubAllGlobals());

describe('safeRelPath', () => {
  it('normalizes and accepts nested paths', () => {
    expect(safeRelPath('notes/today.md')).toBe('notes/today.md');
    expect(safeRelPath('/leading/slash.txt')).toBe('leading/slash.txt');
    expect(safeRelPath('a/./b.txt')).toBe('a/b.txt');
  });

  it('rejects traversal', () => {
    expect(() => safeRelPath('../outside')).toThrow(/escapes/);
    expect(() => safeRelPath('a/../../outside')).toThrow(/escapes/);
    expect(() => safeRelPath('..\\windows')).toThrow(/escapes/);
  });
});

describe('LocalWorkspaceStore', () => {
  it('does not advertise email attachment custody without cross-process CAS support', () => {
    expect(() => requireEmailAttachmentCustodyStore(store)).toThrow(
      'email_attachment_custody_unsupported',
    );
  });
  it('writes, reads, and lists round-trip', async () => {
    await store.write('notes/hello.txt', 'workspace content');
    expect(await store.read('notes/hello.txt')).toBe('workspace content');

    const rootList = await store.list('.');
    expect(rootList).toContainEqual({ name: 'notes', dir: true });
    const notesList = await store.list('notes');
    expect(notesList).toContainEqual({ name: 'hello.txt', dir: false });
  });

  it('round-trips binary attachments without decoding them as text', async () => {
    const attachment = Buffer.from([0, 255, 1, 2, 0, 250]);
    await store.writeBytes('attachments/resume.pdf', attachment, 'application/pdf');
    expect(await store.readBytes('attachments/resume.pdf')).toEqual(attachment);
  });

  it('read of a missing file throws', async () => {
    await expect(store.read('nope.txt')).rejects.toThrow();
  });

  it('blocks reads and writes through a symlink that escapes the root', async () => {
    writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    symlinkSync(outside, path.join(root, 'escape'), 'dir');
    await expect(store.read('escape/secret.txt')).rejects.toThrow(/outside/);
    await expect(store.write('escape/new.txt', 'nope')).rejects.toThrow(/outside/);
  });

  it('blocks a namespace-crossing symlink even when it remains inside the root', async () => {
    await store.write('browser/profile-secret.txt', 'protected');
    await store.write('code/ordinary.txt', 'ordinary');
    symlinkSync(
      path.join(root, 'browser/profile-secret.txt'),
      path.join(root, 'code/disguised.txt'),
    );
    await expect(store.readBytes('code/disguised.txt')).rejects.toThrow(/symlinks/);
  });

  it('continues a bounded, stable local listing and invalidates it after directory mutation', async () => {
    for (let index = 0; index < 53; index += 1) {
      await store.write(`import/page-${String(index).padStart(3, '0')}.txt`, 'x');
    }
    const first = await store.listPage('import', { cursor: null, limit: 50 });
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await store.listPage('import', { cursor: first.nextCursor, limit: 50 });
    expect(second.items).toHaveLength(3);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    const listed = [...first.items, ...second.items].map((item) => item.name).sort();
    expect(listed).toEqual(
      Array.from({ length: 53 }, (_, index) => `page-${String(index).padStart(3, '0')}.txt`),
    );

    const stale = await store.listPage('import', { cursor: null, limit: 1 });
    await store.write('import/page-053.txt', 'new');
    await expect(store.listPage('import', { cursor: stale.nextCursor, limit: 1 })).rejects.toThrow(
      /stale|changed/,
    );
  });

  it('replays an active continuation idempotently and rejects it from a fresh store instance', async () => {
    const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'ws-cursor-replay-'));
    const firstStore = new LocalWorkspaceStore(isolatedRoot);
    await firstStore.write('import/a.txt', 'a');
    await firstStore.write('import/b.txt', 'b');
    await firstStore.write('import/c.txt', 'c');
    const first = await firstStore.listPage('import', { cursor: null, limit: 1 });
    expect(first.nextCursor).toBeTruthy();

    const [second, duplicate] = await Promise.all([
      firstStore.listPage('import', { cursor: first.nextCursor, limit: 1 }),
      firstStore.listPage('import', { cursor: first.nextCursor, limit: 1 }),
    ]);
    expect(duplicate).toEqual(second);
    await expect(
      new LocalWorkspaceStore(isolatedRoot).listPage('import', {
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).rejects.toThrow(/expired|different process/);
    await expect(
      firstStore.listPage('import', { cursor: first.nextCursor, limit: 1 }),
    ).resolves.toEqual(second);
    const final = await firstStore.listPage('import', { cursor: second.nextCursor, limit: 1 });
    expect(final.hasMore).toBe(false);
    rmSync(isolatedRoot, { recursive: true, force: true });
  });

  it('replays a terminal page after closing its directory handle', async () => {
    const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'ws-terminal-replay-'));
    const local = new LocalWorkspaceStore(isolatedRoot);
    await local.write('import/a.txt', 'a');
    await local.write('import/b.txt', 'b');

    const first = await local.listPage('import', { cursor: null, limit: 1 });
    const terminalCursor = first.nextCursor;
    expect(terminalCursor).toBeTruthy();
    const terminal = await local.listPage('import', { cursor: terminalCursor, limit: 1 });
    expect(terminal.hasMore).toBe(false);
    expect(terminal.items).toHaveLength(1);
    await expect(local.listPage('import', { cursor: terminalCursor, limit: 1 })).resolves.toEqual(
      terminal,
    );

    rmSync(isolatedRoot, { recursive: true, force: true });
  });

  it('coalesces simultaneous terminal-page retries and replays the same result', async () => {
    const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'ws-terminal-concurrent-'));
    const local = new LocalWorkspaceStore(isolatedRoot);
    await local.write('import/a.txt', 'a');
    await local.write('import/b.txt', 'b');

    const first = await local.listPage('import', { cursor: null, limit: 1 });
    const terminalCursor = first.nextCursor;
    expect(terminalCursor).toBeTruthy();
    const [terminal, retry] = await Promise.all([
      local.listPage('import', { cursor: terminalCursor, limit: 1 }),
      local.listPage('import', { cursor: terminalCursor, limit: 1 }),
    ]);
    expect(terminal).toEqual(retry);
    expect(terminal.hasMore).toBe(false);
    await expect(local.listPage('import', { cursor: terminalCursor, limit: 1 })).resolves.toEqual(
      terminal,
    );

    rmSync(isolatedRoot, { recursive: true, force: true });
  });

  it('checks directory mutation before replaying a cached continuation page', async () => {
    const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'ws-replay-mutation-'));
    const local = new LocalWorkspaceStore(isolatedRoot);
    await local.write('import/a.txt', 'a');
    await local.write('import/b.txt', 'b');
    await local.write('import/c.txt', 'c');

    const first = await local.listPage('import', { cursor: null, limit: 1 });
    const cursor = first.nextCursor;
    expect(cursor).toBeTruthy();
    const second = await local.listPage('import', { cursor, limit: 1 });
    expect(second.hasMore).toBe(true);
    await local.write('import/d.txt', 'd');
    await expect(local.listPage('import', { cursor, limit: 1 })).rejects.toThrow(/changed|stale/);

    rmSync(isolatedRoot, { recursive: true, force: true });
  });

  it('rejects a directory mutation at EOF on a short terminal continuation', async () => {
    const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'ws-eof-mutation-'));
    const listing = new LocalWorkspaceStore(isolatedRoot);
    await listing.write('import/a.txt', 'a');
    await listing.write('import/b.txt', 'b');
    await listing.write('import/c.txt', 'c');
    const first = await listing.listPage('import', { cursor: null, limit: 2 });
    expect(first.hasMore).toBe(true);
    const originalRead = Dir.prototype.read;
    const read = vi.spyOn(Dir.prototype, 'read').mockImplementation(async function (this: Dir) {
      const entry = await Reflect.apply(originalRead, this, []);
      if (entry === null) await listing.write('import/d.txt', 'new after EOF');
      return entry;
    } as typeof Dir.prototype.read);
    try {
      await expect(
        listing.listPage('import', { cursor: first.nextCursor, limit: 2 }),
      ).rejects.toThrow(/changed/);
    } finally {
      read.mockRestore();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('continues past the former 20,000-entry ceiling without rescanning the directory', async () => {
    const largeRoot = mkdtempSync(path.join(tmpdir(), 'ws-large-list-'));
    const largeStore = new LocalWorkspaceStore(largeRoot);
    const directory = path.join(largeRoot, 'import');
    mkdirSync(directory);
    const total = 20_003;
    for (let index = 0; index < total; index += 1)
      writeFileSync(path.join(directory, `file-${String(index).padStart(5, '0')}.txt`), '');

    try {
      const all: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await largeStore.listPage('import', { cursor, limit: 100 });
        all.push(...page.items.map((item) => item.name));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(201);
      } while (cursor);
      expect(all).toHaveLength(total);
      expect(new Set(all).size).toBe(total);
      expect(all).toContain('file-20002.txt');
      expect(pages).toBe(201);
    } finally {
      rmSync(largeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('purpose-scoped artifact paths', () => {
  it.each([
    'code/../browser/profile.tar.enc',
    'code/./x',
    'code\\..\\browser\\profile',
    'code/%2e%2e/profile',
    'code//x',
    'browser/profile.tar.enc',
  ])('rejects %s before a purpose-scoped read', (value) => {
    expect(() => allowedArtifactPath(value, ['code/', 'browser/attachments/'])).toThrow();
  });
  it('accepts valid nested artifact paths', () => {
    expect(allowedArtifactPath('/code/task/report.csv', ['code/'])).toBe('code/task/report.csv');
  });
});

describe('GcsWorkspaceStore generation fencing', () => {
  it('forwards an exact generation through the public custody inspection capability', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const custodyId = 'de0ff2ee-7e66-4b9f-94ae-35cc09f46637';
    const requests: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input.toString());
        requests.push(url);
        if (url.hostname === 'metadata.google.internal')
          return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });
        return new Response(
          JSON.stringify({
            generation: url.searchParams.get('generation') ?? '42',
            metadata: {
              assistantCustodyId: custodyId,
              assistantCustodyState: 'marker',
            },
          }),
          { status: 200 },
        );
      }),
    );

    const inspected = await store.emailAttachmentCustody.inspectEmailAttachmentObject(
      custodyId,
      '41',
    );
    expect(inspected).toEqual({
      generation: '41',
      custodyId,
      state: 'marker',
      sha256: null,
    });
    expect(requests.at(-1)?.searchParams.get('generation')).toBe('41');
  });

  it('creates an opaque empty marker before conditional content and deletes only its owned generation', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const custodyId = 'de0ff2ee-7e66-4b9f-94ae-35cc09f46637';
    const bytes = Buffer.from('private attachment');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    let metadataReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        requests.push({ url, init });
        if (url.hostname === 'metadata.google.internal')
          return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });
        if (init?.method === 'POST') {
          const body = Buffer.from(init.body as Uint8Array).toString();
          const marker = url.searchParams.get('ifGenerationMatch') === '0';
          expect(body).toContain(`"assistantCustodyId":"${custodyId}"`);
          expect(body).toContain(`"assistantCustodyState":"${marker ? 'marker' : 'content'}"`);
          if (!marker) expect(body).toContain(digest);
          return new Response(
            JSON.stringify({
              generation: marker ? '41' : '42',
              metadata: {
                assistantCustodyId: custodyId,
                assistantCustodyState: marker ? 'marker' : 'content',
                ...(!marker ? { assistantContentSha256: digest } : {}),
              },
            }),
            { status: 200 },
          );
        }
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        metadataReads += 1;
        return new Response(
          JSON.stringify({
            generation: '42',
            metadata: {
              assistantCustodyId: custodyId,
              assistantCustodyState: 'content',
              assistantContentSha256: digest,
            },
          }),
          { status: 200 },
        );
      }),
    );

    const custody = store.emailAttachmentCustody;
    expect(custody).toBeDefined();
    const marker = await custody?.createEmailAttachmentMarker(custodyId);
    expect(marker).toEqual({ generation: '41' });
    const content = await custody?.replaceEmailAttachmentMarker({
      custodyId,
      markerGeneration: marker?.generation ?? '',
      content: bytes,
      contentType: 'application/pdf',
      sha256: digest,
    });
    expect(content).toEqual({ generation: '42' });
    await expect(
      custody?.deleteOwnedEmailAttachment({
        custodyId,
        expectedGeneration: content?.generation,
        expectedSha256: digest,
      }),
    ).resolves.toBe('deleted');
    const writes = requests.filter(({ init }) => init?.method === 'POST');
    expect(writes.map(({ url }) => url.searchParams.get('ifGenerationMatch'))).toEqual(['0', '41']);
    const deletion = requests.find(({ init }) => init?.method === 'DELETE');
    expect(deletion?.url.searchParams.get('ifGenerationMatch')).toBe('42');
    expect(metadataReads).toBe(1);
  });

  it('fails closed when a marker is missing or replaced by a different custody identity', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const custodyId = 'de0ff2ee-7e66-4b9f-94ae-35cc09f46637';
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    let metadata: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        requests.push({ url, init });
        if (url.hostname === 'metadata.google.internal')
          return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });
        return metadata === null
          ? new Response('missing', { status: 404 })
          : new Response(JSON.stringify(metadata), { status: 200 });
      }),
    );
    const custody = store.emailAttachmentCustody;
    await expect(custody?.deleteOwnedEmailAttachment({ custodyId })).resolves.toBe('missing');
    metadata = {
      generation: '41',
      metadata: {
        assistantCustodyId: '00000000-0000-4000-8000-000000000000',
        assistantCustodyState: 'marker',
      },
    };
    await expect(custody?.deleteOwnedEmailAttachment({ custodyId })).resolves.toBe('changed');
    expect(requests.some(({ init }) => init?.method === 'DELETE')).toBe(false);
  });

  it('does not issue a content write when the marker generation is invalid or the digest is wrong', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const custody = store.emailAttachmentCustody;
    await expect(
      custody?.replaceEmailAttachmentMarker({
        custodyId: 'de0ff2ee-7e66-4b9f-94ae-35cc09f46637',
        markerGeneration: '0',
        content: Buffer.from('x'),
        contentType: 'text/plain',
        sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('invalid_email_attachment_marker_generation');
    await expect(
      custody?.replaceEmailAttachmentMarker({
        custodyId: 'de0ff2ee-7e66-4b9f-94ae-35cc09f46637',
        markerGeneration: '41',
        content: Buffer.from('x'),
        contentType: 'text/plain',
        sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('invalid_email_attachment_content');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe MIME headers and oversized attachment content before network access', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const custody = store.emailAttachmentCustody;
    await expect(
      custody?.replaceEmailAttachmentMarker({
        custodyId: 'de0ff2ee-7e66-4b9f-94ae-35cc09f46637',
        markerGeneration: '41',
        content: Buffer.from('safe'),
        contentType: 'application/pdf\r\nX-Injected: yes',
        sha256: createHash('sha256').update('safe').digest('hex'),
      }),
    ).rejects.toThrow('invalid_email_attachment_content');
    const tooLarge = Buffer.alloc(25 * 1024 * 1024 + 1, 1);
    await expect(
      custody?.replaceEmailAttachmentMarker({
        custodyId: 'de0ff2ee-7e66-4b9f-94ae-35cc09f46637',
        markerGeneration: '41',
        content: tooLarge,
        contentType: 'application/pdf',
        sha256: createHash('sha256').update(tooLarge).digest('hex'),
      }),
    ).rejects.toThrow('invalid_email_attachment_object_metadata');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets marker deletion win over an in-flight content replacement', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        requests.push({ url, init });
        if (url.hostname === 'metadata.google.internal')
          return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });
        return new Response('generation precondition failed', { status: 412 });
      }),
    );
    const bytes = Buffer.from('content after erasure');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await expect(
      store.emailAttachmentCustody?.replaceEmailAttachmentMarker({
        custodyId: 'de0ff2ee-7e66-4b9f-94ae-35cc09f46637',
        markerGeneration: '41',
        content: bytes,
        contentType: 'application/pdf',
        sha256: digest,
      }),
    ).rejects.toThrow('email_attachment_object_write_failed:412');
    const upload = requests.find(({ init }) => init?.method === 'POST');
    expect(upload?.url.searchParams.get('ifGenerationMatch')).toBe('41');
    expect(upload?.url.searchParams.get('uploadType')).toBe('multipart');
  });

  it('captures and conditionally deletes only the recorded object generation', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        requests.push({ url, init });
        if (url.hostname === 'metadata.google.internal')
          return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });
        if (init?.method === 'DELETE') return new Response('generation changed', { status: 412 });
        return new Response(JSON.stringify({ generation: '41' }), { status: 200 });
      }),
    );

    const generation = await store.objectGeneration?.('import/uploads/voice.mbox');
    expect(generation).toBe('41');
    await expect(
      store.deleteGeneration?.('import/uploads/voice.mbox', generation as string),
    ).rejects.toThrow('generation-scoped delete failed: 412');
    const deletion = requests.find(({ init }) => init?.method === 'DELETE');
    expect(deletion?.url.searchParams.get('generation')).toBe('41');
    expect(deletion?.url.searchParams.get('ifGenerationMatch')).toBe('41');
  });

  it('inspects and deletes only an exact older custody generation', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const custodyId = 'de0ff2ee-7e66-4b9f-94ae-35cc09f46637';
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        requests.push({ url, init });
        if (url.hostname === 'metadata.google.internal')
          return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return new Response(
          JSON.stringify({
            generation: '41',
            metadata: {
              assistantCustodyId: custodyId,
              assistantCustodyState: 'marker',
            },
          }),
          { status: 200 },
        );
      }),
    );

    await expect(
      store.emailAttachmentCustody.deleteOwnedEmailAttachment({
        custodyId,
        expectedGeneration: '41',
      }),
    ).resolves.toBe('deleted');
    expect(requests.some(({ url }) => url.searchParams.get('generation') === '41')).toBe(true);
    const deletion = requests.find(({ init }) => init?.method === 'DELETE');
    expect(deletion?.url.searchParams.get('generation')).toBe('41');
    expect(deletion?.url.searchParams.get('ifGenerationMatch')).toBe('41');
  });

  it('does not delete an older generation with different custody ownership', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        requests.push({ url, init });
        if (url.hostname === 'metadata.google.internal')
          return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });
        return new Response(
          JSON.stringify({
            generation: '41',
            metadata: {
              assistantCustodyId: '00000000-0000-4000-8000-000000000000',
              assistantCustodyState: 'marker',
            },
          }),
          { status: 200 },
        );
      }),
    );

    await expect(
      store.emailAttachmentCustody.deleteOwnedEmailAttachment({
        custodyId: 'de0ff2ee-7e66-4b9f-94ae-35cc09f46637',
        expectedGeneration: '41',
      }),
    ).resolves.toBe('changed');
    expect(requests.some(({ init }) => init?.method === 'DELETE')).toBe(false);
  });

  it('refuses malformed generations before issuing a delete', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(store.deleteGeneration?.('import/uploads/voice.mbox', 'latest')).rejects.toThrow(
      'invalid GCS object generation',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves GCS page tokens and validates the returned continuation', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const requests: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input.toString());
        requests.push(url);
        if (url.hostname === 'metadata.google.internal')
          return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });
        return new Response(
          JSON.stringify({
            items: [{ name: 'install/owner/import/file-051.txt' }],
            prefixes: ['install/owner/import/archive/'],
            ...(url.searchParams.has('pageToken') ? {} : { nextPageToken: 'opaque-next-token' }),
          }),
          { status: 200 },
        );
      }),
    );

    const first = await store.listPage('import', { cursor: null, limit: 2 });
    expect(first).toMatchObject({
      items: [
        { name: 'archive', dir: true },
        { name: 'file-051.txt', dir: false },
      ],
      hasMore: true,
    });
    expect(JSON.parse(Buffer.from(first.nextCursor ?? '', 'base64url').toString()).pageToken).toBe(
      'opaque-next-token',
    );
    const second = await store.listPage('import', { cursor: first.nextCursor, limit: 50 });
    expect(second.hasMore).toBe(false);
    expect(requests.at(-1)?.searchParams.get('pageToken')).toBe('opaque-next-token');
    await expect(
      store.listPage('documents', { cursor: 'x'.repeat(4097), limit: 50 }),
    ).rejects.toThrow(/continuation/);
  });
});

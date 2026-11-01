import { describe, expect, it, vi } from 'vitest';
import {
  createEditorMetadataRead,
  editorMetadataTarget,
  editorMetadataUrls,
  observeEditorReadiness,
} from './owner-editor-release-readiness.js';

const target = { workspaceId: 'assistant', ownerId: '20000000-0000-4000-8000-000000000001' };
const nullPrivacy = '7bbca5c1c6b18b78824f0e513a232b9344a43a861442e577784faba92a89a322';
const completedPrivacy = '51ba31566246ed57d981bcf159932fff981051e9acb61a196bedc12e5e0faccc';
const field = (stringValue: string) => ({ stringValue });
function fixture(options: { ready?: boolean; privacy?: boolean; digest?: string } = {}) {
  const urls = editorMetadataUrls(target);
  const resource = (url: string) => new URL(url).pathname.replace(/^\/v1\//, '');
  const cursor = {
    ownerId: target.ownerId,
    epoch: '20000000-0000-4000-8000-000000000002',
    ready: options.ready ?? true,
    privacyGenerationDigest: options.digest ?? (options.privacy ? completedPrivacy : nullPrivacy),
  };
  const data = new Map<string, unknown | null>([
    [
      urls[0],
      {
        documents: [
          {
            name: `${resource(urls[0])}/${Buffer.from(target.ownerId).toString('base64url')}`,
            fields: { id: field(target.ownerId) },
          },
        ],
      },
    ],
    [
      urls[1],
      options.privacy
        ? {
            name: resource(urls[1]),
            updateTime: '2026-10-29T22:00:00.123456789Z',
            fields: {
              agentId: field(target.ownerId),
              status: field('complete'),
              generation: field('fixture-generation'),
            },
          }
        : null,
    ],
    [
      urls[2],
      {
        name: resource(urls[2]),
        fields: {
          name: field(`owner-editor-epoch:${target.ownerId}`),
          cursor: field(JSON.stringify(cursor)),
        },
      },
    ],
  ]);
  const read = vi.fn(async (url: string) => {
    if (!data.has(url)) throw new Error('unexpected URL');
    return data.get(url);
  });
  return { urls, cursor, data, read };
}
describe('field-masked release editor metadata (offline)', () => {
  it('uses exact encoded logical store keys and field masks, no user records', () => {
    const urls = editorMetadataUrls(target);
    expect(urls[0]).toContain('/installations/YXNzaXN0YW50/agents?pageSize=2&mask.fieldPaths=id');
    expect(urls[2]).not.toContain('owner-editor-epoch:');
    expect(new URL(urls[2]).searchParams.getAll('mask.fieldPaths')).toEqual(['name', 'cursor']);
    expect(() => editorMetadataUrls({ ...target, workspaceId: '../private' })).toThrow();
  });
  it('extracts only explicit plain serving config and does not guess defaults', () => {
    const service = {
      template: {
        containers: [
          {
            env: Object.entries({
              ASSISTANT_WORKSPACE_ID: target.workspaceId,
              FIRESTORE_AGENT_ID: target.ownerId,
            }).map(([name, value]) => ({ name, value })),
          },
        ],
      },
    };
    expect(editorMetadataTarget(service)).toEqual(target);
    expect(editorMetadataTarget({ template: { containers: [{ env: [] }] } })).toBeNull();
    service.template.containers[0]?.env.push({ name: 'FIRESTORE_AGENT_ID', value: target.ownerId });
    expect(editorMetadataTarget(service)).toBeNull();
  });
  it.each([false, true])(
    'observes ready bound metadata with completed privacy=%s, preserving nanoseconds',
    async (privacy) => {
      const f = fixture({ privacy });
      const result = await observeEditorReadiness(f.read, target);
      expect(result).toMatchObject({
        status: 'ready',
        epochPresent: true,
        epochReady: true,
        privacyBound: true,
        ownerMatched: true,
        consistentSnapshot: false,
        activationAuthorized: false,
      });
      expect(f.read).toHaveBeenCalledTimes(6);
      expect(JSON.stringify(result)).not.toContain(target.ownerId);
      expect(JSON.stringify(result)).not.toContain('fixture-generation');
      expect(JSON.stringify(result)).not.toContain('privacyGenerationDigest');
    },
  );
  it('reports missing and disabled epochs separately without creating either', async () => {
    const missing = fixture();
    missing.data.set(missing.urls[2], null);
    expect(await observeEditorReadiness(missing.read, target)).toMatchObject({
      status: 'missing',
      epochPresent: false,
    });
    const disabled = fixture({ ready: false });
    expect(await observeEditorReadiness(disabled.read, target)).toMatchObject({
      status: 'unavailable',
      reason: 'editor_epoch_disabled',
    });
  });
  it('reports changed privacy as unavailable, never enables or rotates', async () => {
    const f = fixture({ digest: 'a'.repeat(64) });
    expect(await observeEditorReadiness(f.read, target)).toMatchObject({
      status: 'unavailable',
      privacyBound: false,
    });
  });
  it('denied reads and malformed metadata stay unknown without raw error/body retention', async () => {
    expect(
      await observeEditorReadiness(async () => {
        throw new Error('private-token-do-not-print');
      }, target),
    ).toMatchObject({ status: 'unknown', epochReady: null });
    const f = fixture();
    f.data.set(f.urls[2], { private: 'do not retain' });
    const result = await observeEditorReadiness(f.read, target);
    expect(result.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('do not retain');
  });
  it('does not mistake repeated separate reads for a consistent snapshot', async () => {
    const f = fixture();
    let calls = 0;
    const result = await observeEditorReadiness(async (url) => {
      calls++;
      const value = await f.read(url);
      return calls === 6 ? { changed: true } : value;
    }, target);
    expect(result.status).toBe('unknown');
  });
  it('rejects wrong echoed document identity and ambiguous owner population', async () => {
    const f = fixture();
    f.data.set(f.urls[0], { documents: [], nextPageToken: 'more' });
    expect(await observeEditorReadiness(f.read, target)).toMatchObject({
      status: 'unavailable',
      reason: 'single_owner_not_verified',
    });
    const g = fixture();
    const doc = g.data.get(g.urls[2]) as { name: string };
    doc.name += 'wrong';
    expect((await observeEditorReadiness(g.read, target)).status).toBe('unknown');
  });
  it('dispatches GET only to exact masked URLs and refuses another installation before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    const read = createEditorMetadataRead('a'.repeat(32), Date.now() + 10_000, target, fetcher);
    await read(editorMetadataUrls(target)[2]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    await expect(
      read(
        'https://firestore.googleapis.com/v1/projects/bmson-assistant/databases/assistant-production/documents/private',
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('caps metadata bytes and turns a missing document into absence, not permission to write', async () => {
    const huge = createEditorMetadataRead(
      'a'.repeat(32),
      Date.now() + 10_000,
      target,
      async () => new Response('x'.repeat(16_385)),
    );
    await expect(huge(editorMetadataUrls(target)[2])).rejects.toThrow();
    const absent = createEditorMetadataRead(
      'a'.repeat(32),
      Date.now() + 10_000,
      target,
      async () => new Response(null, { status: 404 }),
    );
    expect(await absent(editorMetadataUrls(target)[2])).toBeNull();
  });
});

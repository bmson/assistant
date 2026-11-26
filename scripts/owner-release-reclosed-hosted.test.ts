import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bothPriorSuccessorsAbsent,
  reclosedPredecessor,
  selectedReclosedPredecessor,
  verifyPinnedReclosedArtifacts,
  verifyReclosedCanonicalEndpoints,
  verifyReclosedRevisionConditions,
} from './owner-release-reclosed-hosted.js';

describe('fixed hosted reclosure predecessor', () => {
  it('preserves ordinary release selection and rejects all other predecessor inputs', () => {
    expect(selectedReclosedPredecessor({})).toBeUndefined();
    expect(
      selectedReclosedPredecessor({ OWNER_RELEASE_RECLOSED_PREDECESSOR_RUN_ID: '' }),
    ).toBeUndefined();
    expect(
      selectedReclosedPredecessor({ OWNER_RELEASE_RECLOSED_PREDECESSOR_RUN_ID: '44632388669' }),
    ).toEqual(reclosedPredecessor);
    expect(() =>
      selectedReclosedPredecessor({ OWNER_RELEASE_RECLOSED_PREDECESSOR_RUN_ID: '44632388670' }),
    ).toThrow();
  });

  it('fails closed on replaced artifact bytes, missing outcome, or a third admission marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'reclosed-artifact-test-'));
    const dir = join(root, 'owner-reclosed-predecessor', 'journal');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'start.json'), '{}');
      expect(() => verifyPinnedReclosedArtifacts(root)).toThrow();
      writeFileSync(join(dir, 'outcome.json'), '{}');
      expect(() => verifyPinnedReclosedArtifacts(root)).toThrow();
      writeFileSync(join(dir, 'admission.json'), '{}');
      expect(() => verifyPinnedReclosedArtifacts(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps only the scoped canonical endpoints in a reclosed service', () => {
    const root = 'https://assistant-agent-3gimfiaifa-uw.a.run.app';
    const regional = 'https://assistant-agent-83709630368.us-west1.run.app';
    expect(() =>
      verifyReclosedCanonicalEndpoints({ uri: root, urls: [regional, root] }, 'agent'),
    ).not.toThrow();
    for (const urls of [
      [root],
      [root, root],
      [root, regional, `https://candidate---${root.slice(8)}`],
    ]) {
      expect(() => verifyReclosedCanonicalEndpoints({ uri: root, urls }, 'agent')).toThrow();
    }
    expect(() =>
      verifyReclosedCanonicalEndpoints({ uri: regional, urls: [root, regional] }, 'agent'),
    ).toThrow();
  });

  it('accepts the dormant predecessor retirement and requires healthy automatic original', () => {
    const revision = {
      conditions: [
        { type: 'Ready', state: 'CONDITION_SUCCEEDED', revisionReason: 'RETIRED' },
        { type: 'Active', state: 'CONDITION_FAILED', revisionReason: 'RETIRED' },
        { type: 'ResourcesAvailable', state: 'CONDITION_RECONCILING', revisionReason: 'RETIRED' },
        { type: 'ContainerReady', state: 'CONDITION_SUCCEEDED' },
      ],
    };
    expect(() => verifyReclosedRevisionConditions(revision, true)).not.toThrow();
    expect(() => verifyReclosedRevisionConditions(revision, false)).toThrow();
    expect(() =>
      verifyReclosedRevisionConditions(
        {
          conditions: [
            { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
            { type: 'ContainerReady', state: 'CONDITION_SUCCEEDED' },
          ],
        },
        false,
      ),
    ).not.toThrow();
    const failed = {
      type: 'ContainerHealthy',
      state: 'CONDITION_FAILED',
      revisionReason: 'RETIRED',
    };
    expect(() =>
      verifyReclosedRevisionConditions({ conditions: [...revision.conditions, failed] }, true),
    ).toThrow();
  });

  it('requires exact direct GET-only 404s for both previous unpaused successors', async () => {
    const reply = (input: URL | RequestInfo, status: number) => {
      const response = new Response(null, { status });
      Object.defineProperty(response, 'url', { value: String(input) });
      return response;
    };
    const get = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(String(input)).toMatch(
        /^https:\/\/run\.googleapis\.com\/v2\/projects\/bmson-assistant\/locations\/us-west1\/services\/assistant-(agent|web)\/revisions\/assistant-(agent|web)-r-44632388669-1-bc74fbf7$/,
      );
      return reply(input, 404);
    });
    const token = 'synthetic-credential-for-test';
    await expect(bothPriorSuccessorsAbsent(token, Date.now() + 5000, get)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(2);
    for (const status of [200, 403, 503]) {
      const partial: typeof fetch = async (input) =>
        reply(input, String(input).includes('assistant-web') ? status : 404);
      await expect(bothPriorSuccessorsAbsent(token, Date.now() + 5000, partial)).rejects.toThrow();
    }
    const opaque: typeof fetch = async () => new Response(null, { status: 404 });
    await expect(bothPriorSuccessorsAbsent(token, Date.now() + 5000, opaque)).rejects.toThrow();
  });
});

import { randomUUID } from 'node:crypto';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirestoreSkillLibraryRepository } from './skill-library.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore learned-skill library', () => {
  let store: InstallationStore;
  let repository: FirestoreSkillLibraryRepository;

  beforeEach(async () => {
    store = emulatorStore();
    repository = new FirestoreSkillLibraryRepository(store);
    await Promise.all(['owner', 'other'].map((id) => store.doc('agents', id).set({ id })));
  });

  afterEach(async () => disposeStore(store));

  async function seed(
    id: string,
    patch: Record<string, unknown> = {},
    documentId = id,
  ): Promise<void> {
    await store.doc('skills', documentId).set({
      id,
      agentId: 'owner',
      name: `Skill ${id}`,
      preconditions: 'when needed',
      steps: 'do the work',
      gotchas: 'check the result',
      ownerAuthored: false,
      deprecated: false,
      useCount: 2,
      successCount: 1,
      failureCount: 0,
      updatedAt: new Date('2026-09-10T12:00:00.000Z'),
      embedding: FieldValue.vector([1, 0]),
      ...patch,
    });
  }

  it('lists only the requested owner with the mobile fields and PostgreSQL ordering', async () => {
    await Promise.all([
      seed('active-new', { updatedAt: new Date('2026-09-12T12:00:00.000Z') }),
      seed('active-old'),
      seed('owner-authored', { ownerAuthored: true, updatedAt: new Date('2026-09-01') }),
      seed('deprecated', { deprecated: true, updatedAt: new Date('2026-09-15') }),
      seed('foreign', { agentId: 'other', ownerAuthored: true }),
    ]);

    const rows = await repository.list('owner');
    expect(rows.map((row) => row.id)).toEqual([
      'owner-authored',
      'active-new',
      'active-old',
      'deprecated',
    ]);
    expect(rows[0]).toEqual({
      id: 'owner-authored',
      name: 'Skill owner-authored',
      preconditions: 'when needed',
      steps: 'do the work',
      gotchas: 'check the result',
      ownerAuthored: true,
      deprecated: false,
      useCount: 2,
      successCount: 1,
      failureCount: 0,
      updatedAt: new Date('2026-09-01'),
    });
    expect(await repository.list('other')).toMatchObject([{ id: 'foreign' }]);
    await expect(repository.list('')).rejects.toThrow('agent is required');
  });

  it('fails closed on malformed owner data or a mismatched document identity', async () => {
    await seed('wrong-id', {}, 'different-document');
    await expect(repository.list('owner')).rejects.toThrow('Invalid learned-skill document');
    await store.doc('skills', 'different-document').delete();

    await seed('bad-counter', { failureCount: -1 });
    await expect(repository.list('owner')).rejects.toThrow('Invalid learned-skill document');
  });

  it('refuses missing agents and active or changed privacy erasure', async () => {
    await seed('private');
    await expect(repository.list('missing')).rejects.toThrow('agent is missing');
    await store.doc('privacyErasureJobs', 'owner').set({ agentId: 'owner', status: 'active' });
    await expect(repository.list('owner')).rejects.toThrow('Privacy erasure is in progress');
    await store.doc('privacyErasureJobs', 'owner').set({ agentId: 'owner', status: 'complete' });
    expect(await repository.list('owner')).toHaveLength(1);
  });

  it('rejects skills when erasure completes during the read', async () => {
    await seed('private');
    const originalDoc = store.doc.bind(store);
    let fenceReads = 0;
    const spy = vi.spyOn(store, 'doc').mockImplementation((collection, id) => {
      const ref = originalDoc(collection, id);
      if (collection === 'privacyErasureJobs' && id === 'owner') {
        const get = ref.get.bind(ref);
        vi.spyOn(ref, 'get').mockImplementation(async () => {
          fenceReads += 1;
          if (fenceReads === 2)
            await originalDoc('privacyErasureJobs', 'owner').set({
              agentId: 'owner',
              status: 'complete',
            });
          return get();
        });
      }
      return ref;
    });
    try {
      await expect(repository.list('owner')).rejects.toThrow('Privacy erasure changed during read');
      expect(fenceReads).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a library larger than the bounded mobile response', async () => {
    const first = store.db.batch();
    for (let index = 0; index < 500; index++) {
      first.set(store.doc('skills', `skill-${index}`), {
        id: `skill-${index}`,
        agentId: 'owner',
      });
    }
    await first.commit();
    await seed('skill-500');
    await expect(repository.list('owner')).rejects.toThrow('exceeds the mobile workspace limit');
  });

  it('continues through a library larger than the old 500-row limit in bounded pages', async () => {
    const ids = Array.from({ length: 501 }, () => randomUUID()).sort();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = store.db.batch();
      for (const id of ids.slice(offset, offset + 400)) {
        batch.set(store.doc('skills', id), {
          id,
          agentId: 'owner',
          name: `Skill ${id}`,
          preconditions: 'when needed',
          steps: 'do the work',
          gotchas: 'check the result',
          ownerAuthored: false,
          deprecated: false,
          useCount: 0,
          successCount: 0,
          failureCount: 0,
          updatedAt: new Date('2026-09-10T12:00:00.000Z'),
        });
      }
      await batch.commit();
    }

    const collected: string[] = [];
    let afterId: string | undefined;
    do {
      const page = await repository.listPage('owner', {
        ...(afterId ? { afterId } : {}),
        limit: 100,
      });
      collected.push(...page.items.map((row) => row.id));
      afterId = page.nextCursor ?? undefined;
      expect(page.hasMore).toBe(Boolean(afterId));
    } while (afterId);

    expect(collected).toEqual(ids);
  });
});

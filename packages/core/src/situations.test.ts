import { randomUUID } from 'node:crypto';
import {
  agents,
  commitments,
  conversations,
  createDb,
  generatedCardRevisions,
  generatedCards,
  situationPacks,
  situationPreviews,
} from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { situationChangeMoment } from './proactive/pulse.js';
import {
  affectedItems,
  commandSituationPack,
  getSituationPack,
  isSituationRequest,
  listSituationPacks,
  PackDataSchema,
  PackItemSchema,
  recallSituationDecisionContext,
  recallSituationDecisions,
  validatePack,
} from './situations.js';

const db = createDb(
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant_test',
);
const agentId = randomUUID();
const otherId = randomUUID();
const conversationId = randomUUID();
const sourceId = randomUUID();
const cardId = randomUUID();
const revisionId = randomUUID();
const item = (id: string, dependsOn: string[] = []) =>
  PackItemSchema.parse({ id, title: id, dependsOn });

describe('situation dependency model', () => {
  it('propagates transitively without moving unrelated items', () => {
    expect(
      affectedItems(
        [item('hotel'), item('route', ['hotel']), item('reminder', ['route']), item('tickets')],
        ['hotel'],
      ),
    ).toEqual(['hotel', 'route', 'reminder']);
  });
  it('rejects cycles, missing dependencies and duplicate IDs', () => {
    for (const items of [
      [item('a', ['b']), item('b', ['a'])],
      [item('a', ['missing'])],
      [item('a'), item('a')],
    ])
      expect(() => validatePack(PackDataSchema.parse({ items }))).toThrow();
  });
  it('routes explicit pack and rehearsal requests to real work', () => {
    expect(isSituationRequest('Review situation pack abc')).toBe(true);
    expect(isSituationRequest('What-if we change the hotel?')).toBe(true);
    expect(isSituationRequest('Thanks, that helps')).toBe(false);
    expect(isSituationRequest('What if the sun disappeared?')).toBe(false);
    expect(isSituationRequest('Rehearse the speech with me')).toBe(false);
  });
});

beforeAll(async () => {
  // These tests intentionally fail rather than silently skipping database proof.
  await db.insert(agents).values(
    [agentId, otherId].map((id) => ({
      id,
      name: 'Pack QA',
      email: `${id}@example.test`,
      workspacePrefix: `qa/${id}`,
    })),
  );
  await db
    .insert(conversations)
    .values({ id: conversationId, agentId, channel: 'chat', trust: 'owner' });
  await db.insert(commitments).values({
    id: sourceId,
    agentId,
    conversationId,
    kind: 'waiting_on',
    title: 'Waiting for hotel reply',
    details: 'Confirm late arrival',
    contentHash: randomUUID(),
  });
  await db.insert(generatedCards).values({
    id: cardId,
    agentId,
    sourceLabel: 'QA evidence',
    sourceFingerprint: randomUUID(),
    currentRevisionId: revisionId,
  });
  await db.insert(generatedCardRevisions).values({
    id: revisionId,
    cardId,
    spec: {
      version: 1,
      title: 'Hotel reservation',
      accessibilityLabel: 'Hotel reservation',
      sourceLabel: 'QA evidence',
      facts: [
        { id: 'name', value: 'Harbor Hotel', source: 'QA' },
        { id: 'code', value: 'SECRET-BOOKING-CODE', sensitive: true, source: 'QA' },
      ],
      blocks: [{ type: 'hero', titleFact: 'name' }],
    },
  });
});
afterAll(async () => {
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  await db.delete(agents).where(inArray(agents.id, [agentId, otherId]));
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

async function create(title = 'Soccer weekend') {
  const result = await commandSituationPack(db, agentId, {
    action: 'create',
    title,
    creationKey: randomUUID(),
  });
  if (!result.ok) throw new Error(result.error);
  return result.packId;
}
async function get(id: string) {
  const pack = await getSituationPack(db, agentId, id);
  if (!pack) throw new Error('Missing pack');
  return pack;
}
async function add(id: string, input: Record<string, unknown>) {
  const pack = await get(id);
  const result = await commandSituationPack(db, agentId, {
    action: 'item',
    packId: id,
    version: pack.version,
    item: input,
  });
  expect(result).toMatchObject({ ok: true });
}
async function preview(id: string, input: Record<string, unknown>) {
  const pack = await get(id);
  const result = await commandSituationPack(db, agentId, {
    action: 'preview',
    packId: id,
    version: pack.version,
    item: input,
  });
  if (!result.ok || !result.preview) throw new Error(JSON.stringify(result));
  return result.preview;
}

describe('durable situation packs', () => {
  it('deduplicates creation keys, including concurrent requests', async () => {
    const command = { action: 'create', title: 'Same pack', creationKey: randomUUID() };
    const [a, b] = await Promise.all([
      commandSituationPack(db, agentId, command),
      commandSituationPack(db, agentId, command),
    ]);
    expect(a).toEqual(b);
  });
  it('isolates reads, writes and sources by owner', async () => {
    const id = await create();
    expect(await getSituationPack(db, otherId, id)).toBeNull();
    expect(await listSituationPacks(db, otherId)).toEqual([]);
    expect(
      await commandSituationPack(db, otherId, { action: 'archive', packId: id, version: 1 }),
    ).toMatchObject({ ok: false });
    const foreign = await commandSituationPack(db, otherId, {
      action: 'create',
      title: 'Other pack',
      creationKey: randomUUID(),
    });
    if (!foreign.ok) throw new Error('Missing pack');
    expect(
      await commandSituationPack(db, otherId, {
        action: 'item',
        packId: foreign.packId,
        version: 1,
        item: { id: 'hotel', title: 'Hotel', source: { kind: 'card', id: cardId } },
      }),
    ).toMatchObject({ ok: false });
  });
  it('takes current source snapshots but excludes sensitive card facts', async () => {
    const id = await create();
    await add(id, { id: 'hotel', title: 'Stay', source: { kind: 'card', id: cardId } });
    const pack = await get(id);
    expect(pack.data.items[0]?.snapshot?.details).toContain('Harbor Hotel');
    expect(JSON.stringify(pack)).not.toContain('SECRET-BOOKING-CODE');
    expect(pack.changes).toEqual([]);
  });
  it('rehearses without changing the plan, applies once and cascades review flags', async () => {
    const id = await create();
    await add(id, { id: 'hotel', title: 'Hotel A' });
    await add(id, { id: 'route', title: 'Drive to hotel', dependsOn: ['hotel'] });
    await add(id, { id: 'reminder', title: 'Leave reminder', dependsOn: ['route'] });
    await add(id, { id: 'tickets', title: 'Match tickets' });
    const before = await get(id);
    const change = await preview(id, { id: 'hotel', title: 'Hotel B' });
    expect(await get(id)).toEqual(before);
    expect(change.affectedIds).toEqual(['route', 'reminder', 'hotel']);
    const command = { action: 'apply', packId: id, previewId: change.id };
    const applied = await Promise.all([
      commandSituationPack(db, agentId, command),
      commandSituationPack(db, agentId, command),
    ]);
    expect(applied.every((result) => result.ok)).toBe(true);
    const after = await get(id);
    expect(after.version).toBe(before.version + 1);
    expect(after.data.items.find((item) => item.id === 'hotel')?.title).toBe('Hotel B');
    expect(after.affectedIds).toEqual(['route', 'reminder']);
    expect(after.data.items.find((item) => item.id === 'tickets')?.needsReview).toBe(false);
  });
  it('rejects stale versions and does not allow direct overwrite', async () => {
    const id = await create();
    await add(id, { id: 'a', title: 'First' });
    expect(
      await commandSituationPack(db, agentId, {
        action: 'item',
        packId: id,
        version: 1,
        item: { id: 'b', title: 'Second' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await commandSituationPack(db, agentId, {
        action: 'item',
        packId: id,
        version: 2,
        item: { id: 'a', title: 'Overwrite' },
      }),
    ).toMatchObject({ ok: false });
    const change = await preview(id, { id: 'a', title: 'Changed' });
    await add(id, { id: 'b', title: 'Second' });
    expect(
      await commandSituationPack(db, agentId, {
        action: 'apply',
        packId: id,
        previewId: change.id,
      }),
    ).toMatchObject({ ok: false });
  });
  it('rejects source races and reports resolved waiting-on as a change, not completed dependent work', async () => {
    const id = await create();
    await add(id, {
      id: 'reply',
      title: 'Hotel reply',
      lane: 'waiting_on',
      source: { kind: 'commitment', id: sourceId },
    });
    await add(id, { id: 'confirm', title: 'Confirm arrival', lane: 'i_owe', dependsOn: ['reply'] });
    const old = await preview(id, {
      id: 'reply',
      title: 'Hotel reply',
      lane: 'waiting_on',
      source: { kind: 'commitment', id: sourceId },
    });
    await db
      .update(commitments)
      .set({
        status: 'resolved',
        resolution: 'Owner confirmed reply arrived',
        updatedAt: new Date(),
      })
      .where(eq(commitments.id, sourceId));
    expect(
      await commandSituationPack(db, agentId, { action: 'apply', packId: id, previewId: old.id }),
    ).toMatchObject({ ok: false });
    const changed = await get(id);
    expect(changed.changes[0]?.after?.state).toBe('resolved');
    expect(changed.affectedIds).toEqual(['reply', 'confirm']);
    const fresh = await preview(id, {
      id: 'reply',
      title: 'Hotel reply',
      lane: 'waiting_on',
      source: { kind: 'commitment', id: sourceId },
    });
    expect(
      await commandSituationPack(db, agentId, { action: 'apply', packId: id, previewId: fresh.id }),
    ).toMatchObject({ ok: true });
    expect((await get(id)).data.items.find((item) => item.id === 'confirm')?.needsReview).toBe(
      true,
    );
    const [source] = await db.select().from(commitments).where(eq(commitments.id, sourceId));
    expect(source?.resolution).toBe('Owner confirmed reply arrived');
  });
  it('cannot mark a dependent reviewed while its source is still changed', async () => {
    const id = await create();
    await add(id, { id: 'hotel', title: 'Hotel', source: { kind: 'card', id: cardId } });
    await add(id, { id: 'route', title: 'Route', dependsOn: ['hotel'] });
    await db
      .update(generatedCards)
      .set({ status: 'dismissed' })
      .where(eq(generatedCards.id, cardId));
    const pack = await get(id);
    expect(pack.changes[0]?.after?.state).toBe('dismissed');
    expect(
      await commandSituationPack(db, agentId, {
        action: 'reviewed',
        packId: id,
        version: pack.version,
        itemId: 'route',
      }),
    ).toMatchObject({ ok: false });
    await db.update(generatedCards).set({ status: 'active' }).where(eq(generatedCards.id, cardId));
  });
  it('expires and dismisses previews without affecting sources or packs', async () => {
    const id = await create();
    await add(id, { id: 'a', title: 'A' });
    const old = await preview(id, { id: 'a', title: 'B' });
    await db
      .update(situationPreviews)
      .set({ expiresAt: new Date(0) })
      .where(eq(situationPreviews.id, old.id));
    expect(
      await commandSituationPack(db, agentId, { action: 'apply', packId: id, previewId: old.id }),
    ).toMatchObject({ ok: false });
    const next = await preview(id, { id: 'a', title: 'C' });
    await commandSituationPack(db, agentId, {
      action: 'dismiss_preview',
      packId: id,
      previewId: next.id,
    });
    expect(
      await commandSituationPack(db, agentId, { action: 'apply', packId: id, previewId: next.id }),
    ).toMatchObject({ ok: false });
    expect((await get(id)).data.items[0]?.title).toBe('A');
  });
  it('does not reuse one-off rejections as preferences; confirmation cannot be forged by a tool', async () => {
    const id = await create();
    const decision = {
      id: 'food',
      option: 'Late dinner',
      outcome: 'rejected',
      reason: 'Too late before soccer',
      scope: 'preference',
      confirmed: true,
    };
    expect(
      await commandSituationPack(db, agentId, {
        action: 'decision',
        packId: id,
        version: 1,
        decision,
      }),
    ).toMatchObject({ ok: false });
    await commandSituationPack(
      db,
      agentId,
      { action: 'decision', packId: id, version: 1, decision: { ...decision, scope: 'situation' } },
      { ownerConfirmed: true },
    );
    expect(await recallSituationDecisions(db, agentId, 'dinner')).toEqual([]);
    expect(await recallSituationDecisions(db, agentId, 'dinner', id)).toHaveLength(1);
    await commandSituationPack(
      db,
      agentId,
      { action: 'decision', packId: id, version: 2, decision },
      { ownerConfirmed: true },
    );
    expect(await recallSituationDecisions(db, agentId, 'dinner')).toHaveLength(1);
    expect(await recallSituationDecisions(db, otherId, 'dinner', id)).toEqual([]);
    expect((await get(id)).data.decisions).toHaveLength(1);
    await commandSituationPack(db, agentId, { action: 'archive', packId: id, version: 3 });
    expect(await recallSituationDecisions(db, agentId, 'dinner')).toHaveLength(1);
    expect(
      await commandSituationPack(db, agentId, {
        action: 'forget_decision',
        packId: id,
        version: 4,
        decisionId: 'food',
      }),
    ).toMatchObject({ ok: true });
    expect(await recallSituationDecisions(db, agentId, 'dinner')).toEqual([]);
  });

  it('a corrected reason replaces the same option instead of retaining contradictory decisions', async () => {
    const id = await create();
    for (const [index, outcome] of ['rejected', 'chosen'].entries()) {
      expect(
        await commandSituationPack(
          db,
          agentId,
          {
            action: 'decision',
            packId: id,
            version: index + 1,
            decision: {
              id: `choice-${index}`,
              option: 'Early lunch',
              outcome,
              reason: index ? 'The timing now works' : 'Too early',
              scope: 'situation',
            },
          },
          { ownerConfirmed: true },
        ),
      ).toMatchObject({ ok: true });
    }
    expect((await get(id)).data.decisions).toHaveLength(1);
    expect((await get(id)).data.decisions[0]?.outcome).toBe('chosen');
  });

  it('preplanning context keeps opposite owner-confirmed choices from separate packs', async () => {
    const rejectedPack = await create('Launch plan A');
    const chosenPack = await create('Launch plan B');
    for (const [packId, outcome, reason] of [
      [rejectedPack, 'rejected', 'Daily meetings interrupt focus during launch.'],
      [chosenPack, 'chosen', 'Daily check-ins catch blockers during launch.'],
    ] as const) {
      const result = await commandSituationPack(
        db,
        agentId,
        {
          action: 'decision',
          packId,
          version: 1,
          decision: {
            id: 'daily-check-in',
            option: 'Daily check-in',
            outcome,
            reason,
            scope: 'situation',
            confirmed: true,
          },
        },
        { ownerConfirmed: true },
      );
      expect(result).toMatchObject({ ok: true });
    }

    const matches = await recallSituationDecisionContext(
      db,
      agentId,
      'Should we add a daily check-in for launch?',
      1,
    );

    expect(
      matches
        .map(({ packId, packVersion, outcome }) => ({ packId, packVersion, outcome }))
        .sort((a, b) => a.outcome.localeCompare(b.outcome)),
    ).toEqual([
      { packId: chosenPack, packVersion: 2, outcome: 'chosen' },
      { packId: rejectedPack, packVersion: 2, outcome: 'rejected' },
    ]);
    expect(await recallSituationDecisionContext(db, otherId, 'daily check-in launch')).toEqual([]);
  });
  it('produces a deduplicated, non-executing review suggestion only for changed sources', async () => {
    const id = await create();
    await add(id, { id: 'hotel', title: 'Stay', source: { kind: 'card', id: cardId } });
    const pack = await get(id);
    expect(situationChangeMoment(pack)).toBeNull();
    const changed = {
      ...pack,
      changes: [
        {
          itemId: 'hotel',
          before: pack.data.items[0]?.snapshot ?? null,
          after: { revision: 'next', state: 'expired', title: 'Hotel', details: '' },
        },
      ],
      affectedIds: ['hotel'],
    };
    const moment = situationChangeMoment(changed);
    expect(moment?.key).toBe(situationChangeMoment(changed)?.key);
    expect(moment?.suggestion?.proposedAction).toContain('do not send, book, cancel, reschedule');
    expect(situationChangeMoment({ ...changed, archived: true })).toBeNull();
  });
  it('rejects invalid input and leaves invalid graphs unchanged', async () => {
    const id = await create();
    expect(await commandSituationPack(db, agentId, { action: 'nonsense' })).toMatchObject({
      ok: false,
    });
    expect(
      await commandSituationPack(db, agentId, {
        action: 'item',
        packId: id,
        version: 1,
        item: { id: 'a', title: 'A', dependsOn: ['missing'] },
      }),
    ).toMatchObject({ ok: false });
    expect((await get(id)).version).toBe(1);
    const [row] = await db.select().from(situationPacks).where(eq(situationPacks.id, id));
    expect(row?.data).toEqual({ items: [], decisions: [] });
  });
});

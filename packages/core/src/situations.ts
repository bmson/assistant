import { createHash } from 'node:crypto';
import {
  commitments,
  type Db,
  generatedCardRevisions,
  generatedCards,
  situationPacks,
  situationPreviews,
} from '@assistant/db';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { isSensitiveCardFact, publicCardText } from './card-privacy.js';
import { GenerativeCardSpecV1Schema } from './generative-card.js';
import {
  affectedItems,
  PackCommandSchema,
  type PackData,
  PackDataSchema,
  type PackItem,
  PackItemSchema,
  type PackSnapshot,
  type SituationDecisionContext,
  type SituationPackView,
  selectSituationDecisionContext,
  validatePack,
} from './situations-schema.js';

export * from './situations-schema.js';

type Reader = Pick<Db, 'select'>;
type PackRow = typeof situationPacks.$inferSelect;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function snapshot(
  db: Reader,
  agentId: string,
  source: NonNullable<PackItem['source']>,
  lock = false,
): Promise<PackSnapshot> {
  if (source.kind === 'card') {
    const query = db
      .select()
      .from(generatedCards)
      .where(and(eq(generatedCards.id, source.id), eq(generatedCards.agentId, agentId)));
    const [card] = await (lock ? query.for('share') : query);
    if (!card)
      return {
        revision: 'missing',
        state: 'unavailable',
        title: 'Source unavailable',
        details: '',
      };
    const [revision] = await db
      .select()
      .from(generatedCardRevisions)
      .where(
        and(
          eq(generatedCardRevisions.id, card.currentRevisionId),
          eq(generatedCardRevisions.cardId, card.id),
        ),
      );
    const parsed = GenerativeCardSpecV1Schema.safeParse(revision?.spec);
    const privateValues = parsed.success
      ? parsed.data.facts.filter(isSensitiveCardFact).map((fact) => fact.value)
      : [];
    return {
      revision: card.currentRevisionId,
      state: card.expiresAt && card.expiresAt <= new Date() ? 'expired' : card.status,
      title: parsed.success
        ? (publicCardText(parsed.data.title, privateValues) ?? 'Saved card')
        : 'Saved card',
      // Secret/booking-code values must never leak through a planning snapshot.
      details: parsed.success
        ? parsed.data.facts
            .filter((fact) => !isSensitiveCardFact(fact))
            .map((fact) => `${fact.label ?? fact.id}: ${fact.value}`)
            .join('\n')
            .slice(0, 4000)
        : '',
    };
  }
  const query = db
    .select()
    .from(commitments)
    .where(and(eq(commitments.id, source.id), eq(commitments.agentId, agentId)));
  const [row] = await (lock ? query.for('share') : query);
  return row
    ? {
        revision: row.updatedAt.toISOString(),
        state: row.status,
        title: row.title,
        details: [row.details, row.nextAction, row.dueAt?.toISOString(), row.resolution]
          .filter(Boolean)
          .join('\n')
          .slice(0, 4000),
      }
    : { revision: 'missing', state: 'unavailable', title: 'Source unavailable', details: '' };
}

async function sources(db: Reader, agentId: string, items: PackItem[], lock = false) {
  const result: Record<string, PackSnapshot> = {};
  const unique = new Map(
    items.flatMap((item) =>
      item.source ? [[`${item.source.kind}:${item.source.id}`, item.source] as const] : [],
    ),
  );
  // Consistent source-lock order across packs avoids cross-pack deadlocks.
  for (const [key, source] of [...unique].sort(([a], [b]) => a.localeCompare(b)))
    result[key] = await snapshot(db, agentId, source, lock);
  return result;
}
function currentSnapshot(item: PackItem, live: Record<string, PackSnapshot>) {
  return item.source ? (live[`${item.source.kind}:${item.source.id}`] ?? null) : null;
}

async function project(db: Reader, row: PackRow): Promise<SituationPackView> {
  const data = PackDataSchema.parse(row.data);
  const live = await sources(db, row.agentId, data.items);
  const changes = data.items
    .filter((item) => item.source && digest(item.snapshot) !== digest(currentSnapshot(item, live)))
    .map((item) => ({
      itemId: item.id,
      before: item.snapshot,
      after: currentSnapshot(item, live),
    }));
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    archived: row.archived,
    updatedAt: row.updatedAt.toISOString(),
    data,
    changes,
    affectedIds: affectedItems(data.items, [
      ...changes.map((change) => change.itemId),
      ...data.items.filter((item) => item.needsReview).map((item) => item.id),
    ]),
  };
}

export async function listSituationPacks(db: Db, agentId: string): Promise<SituationPackView[]> {
  const rows = await db
    .select()
    .from(situationPacks)
    .where(and(eq(situationPacks.agentId, agentId), eq(situationPacks.archived, false)))
    .orderBy(desc(situationPacks.updatedAt))
    .limit(50);
  return Promise.all(rows.map((row) => project(db, row)));
}
export async function getSituationPack(
  db: Db,
  agentId: string,
  id: string,
): Promise<SituationPackView | null> {
  const [row] = await db
    .select()
    .from(situationPacks)
    .where(and(eq(situationPacks.id, id), eq(situationPacks.agentId, agentId)));
  return row ? project(db, row) : null;
}

export interface SituationPreview {
  id: string;
  packId: string;
  baseVersion: number;
  before: PackItem;
  after: PackItem;
  affectedIds: string[];
  unknowns: string[];
  expiresAt: string;
}
export type SituationResult =
  | { ok: true; packId: string; preview?: SituationPreview }
  | { ok: false; error: string };

/** All owner and tool mutations converge here. No network or task side effects. */
export async function commandSituationPack(
  db: Db,
  agentId: string,
  input: unknown,
  options: { ownerConfirmed?: boolean } = {},
): Promise<SituationResult> {
  const parsed = PackCommandSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: 'Invalid pack command. Check the required fields and limits.' };
  const command = parsed.data;
  try {
    return await db.transaction(async (tx): Promise<SituationResult> => {
      if (command.action === 'create') {
        const [row] = await tx
          .insert(situationPacks)
          .values({
            agentId,
            title: command.title,
            creationKey: command.creationKey,
            data: { items: [], decisions: [] },
          })
          .onConflictDoNothing()
          .returning();
        const existing =
          row ??
          (
            await tx
              .select()
              .from(situationPacks)
              .where(
                and(
                  eq(situationPacks.agentId, agentId),
                  eq(situationPacks.creationKey, command.creationKey),
                ),
              )
          )[0];
        if (!existing) throw new Error('Could not create the pack.');
        return { ok: true, packId: existing.id };
      }
      const [row] = await tx
        .select()
        .from(situationPacks)
        .where(and(eq(situationPacks.id, command.packId), eq(situationPacks.agentId, agentId)))
        .for('update');
      if (!row || (row.archived && command.action !== 'forget_decision'))
        throw new Error('This pack is unavailable.');
      if ('version' in command && command.version !== row.version)
        throw new Error('This pack changed. Reload it before trying again.');
      const data = PackDataSchema.parse(row.data);
      const save = async (next: PackData) => {
        validatePack(next);
        await tx
          .update(situationPacks)
          .set({ data: next, version: row.version + 1, updatedAt: new Date() })
          .where(eq(situationPacks.id, row.id));
      };
      if (command.action === 'archive') {
        await tx
          .update(situationPacks)
          .set({ archived: true, version: row.version + 1, updatedAt: new Date() })
          .where(eq(situationPacks.id, row.id));
      } else if (command.action === 'forget_decision') {
        await save({
          ...data,
          decisions: data.decisions.filter((decision) => decision.id !== command.decisionId),
        });
      } else if (command.action === 'decision') {
        const decision = { ...command.decision, confirmed: options.ownerConfirmed === true };
        if (decision.scope === 'preference' && !decision.confirmed)
          throw new Error(
            'A lasting preference needs explicit confirmation in the pack. Save it as a situation decision first.',
          );
        await save({
          ...data,
          decisions: [
            ...data.decisions.filter(
              (item) =>
                item.id !== decision.id &&
                item.option.trim().toLocaleLowerCase() !==
                  decision.option.trim().toLocaleLowerCase(),
            ),
            decision,
          ],
        });
      } else if (command.action === 'reviewed') {
        const item = data.items.find((item) => item.id === command.itemId);
        if (!item) throw new Error('This item no longer exists.');
        const live = await sources(tx, agentId, data.items, true);
        const changed = data.items
          .filter(
            (entry) =>
              entry.source && digest(entry.snapshot) !== digest(currentSnapshot(entry, live)),
          )
          .map((entry) => entry.id);
        if (affectedItems(data.items, changed).includes(item.id))
          throw new Error(
            'Review the source change first; this item still depends on changed information.',
          );
        await save({
          ...data,
          items: data.items.map((entry) =>
            entry.id === item.id ? { ...entry, needsReview: false } : entry,
          ),
        });
      } else if (command.action === 'item' || command.action === 'preview') {
        const before = data.items.find((item) => item.id === command.item.id);
        if (command.action === 'item' && before)
          throw new Error('Use a preview to change an existing item.');
        if (command.action === 'preview' && !before)
          throw new Error('Add the item before previewing a correction.');
        const after = PackItemSchema.parse(command.item);
        const live = await sources(tx, agentId, [...data.items, after], true);
        after.snapshot = currentSnapshot(after, live);
        if (
          after.snapshot?.state === 'unavailable' &&
          (!before?.source || digest(before.source) !== digest(after.source))
        )
          throw new Error('The linked source is unavailable or belongs to another owner.');
        const next = {
          ...data,
          items: [...data.items.filter((item) => item.id !== after.id), after],
        };
        validatePack(next);
        if (command.action === 'item') await save(next);
        else if (before) {
          const impacted = affectedItems(next.items, [after.id]);
          const expiresAt = new Date(Date.now() + 24 * 3600_000);
          const body = {
            before,
            after,
            affectedIds: impacted,
            unknowns: [
              'Only linked, stored sources were checked. Availability, travel times and external changes are not verified.',
              'Applying updates this pack only. Reminders, bookings and messages remain unchanged.',
            ],
          };
          const [preview] = await tx
            .insert(situationPreviews)
            .values({
              packId: row.id,
              baseVersion: row.version,
              sourceHash: digest(live),
              data: body,
              expiresAt,
            })
            .returning();
          if (!preview) throw new Error('Could not save the preview.');
          return {
            ok: true,
            packId: row.id,
            preview: {
              ...body,
              id: preview.id,
              packId: row.id,
              baseVersion: row.version,
              expiresAt: expiresAt.toISOString(),
            },
          };
        }
      } else {
        const [preview] = await tx
          .select()
          .from(situationPreviews)
          .where(
            and(eq(situationPreviews.id, command.previewId), eq(situationPreviews.packId, row.id)),
          )
          .for('update');
        if (!preview) throw new Error('This preview is unavailable.');
        if (command.action === 'dismiss_preview') {
          if (preview.status === 'pending')
            await tx
              .update(situationPreviews)
              .set({ status: 'dismissed' })
              .where(eq(situationPreviews.id, preview.id));
        } else {
          if (preview.status === 'applied') return { ok: true, packId: row.id };
          if (
            preview.status !== 'pending' ||
            preview.expiresAt <= new Date() ||
            preview.baseVersion !== row.version
          )
            throw new Error('This preview is stale. Create a new preview.');
          const body = preview.data as Omit<
            SituationPreview,
            'id' | 'packId' | 'baseVersion' | 'expiresAt'
          >;
          const after = PackItemSchema.parse(body.after);
          const live = await sources(tx, agentId, [...data.items, after], true);
          if (digest(live) !== preview.sourceHash)
            throw new Error('A linked source changed. Create a fresh preview before applying.');
          const affected = new Set(
            affectedItems(
              [...data.items.filter((item) => item.id !== after.id), after],
              [after.id],
            ),
          );
          await save({
            ...data,
            items: data.items.map((item) =>
              item.id === after.id
                ? after
                : affected.has(item.id)
                  ? { ...item, needsReview: true }
                  : item,
            ),
          });
          await tx
            .update(situationPreviews)
            .set({ status: 'applied' })
            .where(eq(situationPreviews.id, preview.id));
        }
      }
      return { ok: true, packId: row.id };
    });
  } catch (error) {
    // Only bounded, deliberate domain errors reach the UI. Never expose SQL.
    const message = error instanceof Error ? error.message : '';
    const safe =
      /^(This |A linked |A dependency |A lasting |Item IDs |Decision IDs |Dependencies |Use a preview |Add the item |The linked |Review the source |Could not )/;
    return {
      ok: false,
      error: safe.test(message)
        ? message
        : 'Could not update the pack. Check the fields and try again.',
    };
  }
}

/** Read-only catalog lets the model/UI attach real IDs, never fabricated data. */
export async function listPackSources(db: Db, agentId: string) {
  const [cards, loops] = await Promise.all([
    db
      .select({ id: generatedCards.id })
      .from(generatedCards)
      .where(
        and(
          eq(generatedCards.agentId, agentId),
          eq(generatedCards.status, 'active'),
          or(isNull(generatedCards.expiresAt), gt(generatedCards.expiresAt, new Date())),
        ),
      )
      .orderBy(desc(generatedCards.updatedAt))
      .limit(100),
    db
      .select({
        id: commitments.id,
        title: commitments.title,
        kind: commitments.kind,
        status: commitments.status,
      })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.status, 'open')))
      .orderBy(desc(commitments.updatedAt))
      .limit(100),
  ]);
  const saved = await Promise.all(
    cards.map(async (card) => ({
      kind: 'card' as const,
      id: card.id,
      title: (await snapshot(db, agentId, { kind: 'card', id: card.id })).title,
      lane: 'plan' as const,
    })),
  );
  return [
    ...saved,
    ...loops.map((loop) => ({
      kind: 'commitment' as const,
      id: loop.id,
      title: loop.title,
      lane: loop.kind === 'waiting_on' ? ('waiting_on' as const) : ('i_owe' as const),
    })),
  ];
}

export async function recallSituationDecisions(
  db: Db,
  agentId: string,
  query: string,
  packId?: string,
) {
  const rows = await db
    .select()
    .from(situationPacks)
    .where(eq(situationPacks.agentId, agentId))
    .orderBy(desc(situationPacks.updatedAt))
    .limit(50);
  const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  if (!words.length && !packId) return [];
  const candidates = rows
    .sort((a, b) => Number(b.id === packId) - Number(a.id === packId))
    .flatMap((row) =>
      PackDataSchema.parse(row.data)
        .decisions.filter(
          (decision) =>
            decision.confirmed && (decision.scope === 'preference' || row.id === packId),
        )
        .filter(
          (decision) =>
            row.id === packId ||
            words.some((word) =>
              `${decision.option} ${decision.reason}`.toLocaleLowerCase().includes(word),
            ),
        )
        .map((decision) => ({ ...decision, packId: row.id, packTitle: row.title })),
    );
  // Situation-specific choices outrank general ones. For the same literal
  // option, keep the most recently edited choice instead of contradictory rows.
  const latest = new Map<string, (typeof candidates)[number]>();
  for (const decision of candidates) {
    const key = decision.option.trim().toLocaleLowerCase();
    if (!latest.has(key)) latest.set(key, decision);
  }
  return [...latest.values()].slice(0, 12);
}

/** Owner-scoped, read-only context projection used before ordinary chat planning. */
export async function recallSituationDecisionContext(
  db: Db,
  agentId: string,
  discussionFrame: string,
  limit = 12,
): Promise<SituationDecisionContext[]> {
  const rows = await db
    .select({
      id: situationPacks.id,
      title: situationPacks.title,
      version: situationPacks.version,
      archived: situationPacks.archived,
      updatedAt: situationPacks.updatedAt,
      data: situationPacks.data,
    })
    .from(situationPacks)
    .where(and(eq(situationPacks.agentId, agentId), eq(situationPacks.archived, false)))
    .orderBy(desc(situationPacks.updatedAt))
    .limit(50);
  return selectSituationDecisionContext(
    rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
    discussionFrame,
    limit,
  );
}

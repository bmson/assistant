import { createHash } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import {
  affectedItems,
  PackDataSchema,
  type PackItem,
  type PackSnapshot,
  type SituationDecisionContext,
  type SituationPackView,
  selectSituationDecisionContext,
} from '@assistant/persistence/situations';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

type Pack = Records['situationPacks'];
type Card = Records['generatedCards'];
type Revision = Records['generatedCardRevisions'];
type Commitment = Records['commitments'];
type Source = NonNullable<PackItem['source']>;
const SCAN_LIMIT = 10_000;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = (): PackSnapshot => ({
  revision: 'missing',
  state: 'unavailable',
  title: 'Source unavailable',
  details: '',
});

function cardDetails(spec: unknown) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const value = spec as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 100 ||
    !Array.isArray(value.facts) ||
    value.facts.length < 1 ||
    value.facts.length > 24
  )
    return null;
  const facts: string[] = [];
  for (const entry of value.facts) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const fact = entry as Record<string, unknown>;
    if (
      typeof fact.id !== 'string' ||
      typeof fact.value !== 'string' ||
      (fact.label !== undefined && typeof fact.label !== 'string') ||
      (fact.sensitive !== undefined && typeof fact.sensitive !== 'boolean')
    )
      return null;
    if (fact.sensitive !== true) facts.push(`${fact.label ?? fact.id}: ${fact.value}`);
  }
  return { title: value.title, details: facts.join('\n').slice(0, 4000) };
}

/** Owner-scoped, read-only view of migrated packs and their current linked sources. */
export class FirestoreSituationPackReadRepository {
  constructor(readonly store: InstallationStore) {}

  async overview(agentId: string) {
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const [packs, sources] = await Promise.all([this.list(agentId), this.listSources(agentId)]);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return { packs, sources };
  }

  private async ownedRows<T extends { id: string; agentId: string }>(
    collection: string,
    agentId: string,
  ): Promise<T[]> {
    const page = await this.store
      .collection(collection)
      .where('agentId', '==', agentId)
      .limit(SCAN_LIMIT + 1)
      .get();
    if (page.size > SCAN_LIMIT) throw new Error('Situation pack read limit exceeded');
    return page.docs.flatMap((doc) => {
      const row = decodeRecord<T>(doc.data());
      return row.agentId === agentId && row.id && documentKey(row.id) === doc.id ? [row] : [];
    });
  }

  private async owned<T extends { id: string; agentId: string }>(
    collection: string,
    id: string,
    agentId: string,
  ): Promise<T | null> {
    const doc = await this.store.doc(collection, id).get();
    if (!doc.exists) return null;
    const row = decodeRecord<T>(doc.data());
    return row.agentId === agentId && row.id === id && documentKey(id) === doc.id ? row : null;
  }

  private async snapshot(agentId: string, source: Source): Promise<PackSnapshot> {
    if (source.kind === 'commitment') {
      const row = await this.owned<Commitment>('commitments', source.id, agentId);
      return row && row.updatedAt instanceof Date
        ? {
            revision: row.updatedAt.toISOString(),
            state: row.status,
            title: row.title,
            details: [row.details, row.nextAction, row.dueAt?.toISOString(), row.resolution]
              .filter(Boolean)
              .join('\n')
              .slice(0, 4000),
          }
        : unavailable();
    }
    const card = await this.owned<Card>('generatedCards', source.id, agentId);
    if (!card) return unavailable();
    const revisionDoc = await this.store
      .doc('generatedCardRevisions', card.currentRevisionId)
      .get();
    const revision = revisionDoc.exists ? decodeRecord<Revision>(revisionDoc.data()) : null;
    if (
      !revision ||
      revision.id !== card.currentRevisionId ||
      revision.cardId !== card.id ||
      documentKey(revision.id) !== revisionDoc.id
    ) {
      return unavailable();
    }
    const spec = cardDetails(revision.spec);
    return {
      revision: card.currentRevisionId,
      state:
        card.expiresAt instanceof Date && card.expiresAt <= this.store.now()
          ? 'expired'
          : card.status,
      title: spec?.title ?? 'Saved card',
      details: spec?.details ?? '',
    };
  }

  private async project(row: Pack): Promise<SituationPackView> {
    if (!(row.updatedAt instanceof Date) || !Number.isSafeInteger(row.version)) {
      throw new Error('Invalid situation pack record');
    }
    const data = PackDataSchema.parse(row.data);
    const snapshots = new Map<string, PackSnapshot>();
    for (const source of new Map(
      data.items.flatMap((item) =>
        item.source ? [[sourceKey(item.source), item.source] as const] : [],
      ),
    ).values()) {
      snapshots.set(sourceKey(source), await this.snapshot(row.agentId, source));
    }
    const changes = data.items.flatMap((item) => {
      if (!item.source) return [];
      const after = snapshots.get(sourceKey(item.source)) ?? null;
      return digest(item.snapshot) === digest(after)
        ? []
        : [{ itemId: item.id, before: item.snapshot, after }];
    });
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

  async list(agentId: string): Promise<SituationPackView[]> {
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const rows = await this.ownedRows<Pack>('situationPacks', agentId);
    const selected = rows
      .filter((row) => !row.archived)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 50);
    const views = await Promise.all(selected.map((row) => this.project(row)));
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return views;
  }

  async decisionContext(
    agentId: string,
    discussionFrame: string,
    limit = 12,
  ): Promise<SituationDecisionContext[]> {
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const rows = (await this.ownedRows<Pack>('situationPacks', agentId))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, 50)
      .filter((row) => !row.archived);
    const selected = selectSituationDecisionContext(
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        version: row.version,
        archived: row.archived,
        updatedAt: row.updatedAt.toISOString(),
        data: row.data,
      })),
      discussionFrame,
      limit,
    );
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return selected;
  }

  async get(agentId: string, id: string): Promise<SituationPackView | null> {
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const row = await this.owned<Pack>('situationPacks', id, agentId);
    const view = row ? await this.project(row) : null;
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return view;
  }

  /**
   * Confirmed choices matching the query words, from the 50 most recently
   * edited packs (archived included, like SQL). The current pack's choices
   * come first and need no word match; elsewhere only lasting preferences can.
   */
  async decisions(agentId: string, query: string, packId?: string) {
    const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
    if (!words.length && !packId) return [];
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const rows = (await this.ownedRows<Pack>('situationPacks', agentId))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, 50);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
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
    // For the same literal option, keep the situation-specific or most recent choice.
    const latest = new Map<string, (typeof candidates)[number]>();
    for (const decision of candidates) {
      const key = decision.option.trim().toLocaleLowerCase();
      if (!latest.has(key)) latest.set(key, decision);
    }
    return [...latest.values()].slice(0, 12);
  }

  async listSources(agentId: string) {
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const [cards, commitments] = await Promise.all([
      this.ownedRows<Card>('generatedCards', agentId),
      this.ownedRows<Commitment>('commitments', agentId),
    ]);
    const now = this.store.now();
    const active = cards
      .filter(
        (card) =>
          card.status === 'active' && (!(card.expiresAt instanceof Date) || card.expiresAt > now),
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 100);
    const open = commitments
      .filter((row) => row.status === 'open')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 100);
    const sources = [
      ...(await Promise.all(
        active.map(async (card) => ({
          kind: 'card' as const,
          id: card.id,
          title: (await this.snapshot(agentId, { kind: 'card', id: card.id })).title,
          lane: 'plan' as const,
        })),
      )),
      ...open.map((row) => ({
        kind: 'commitment' as const,
        id: row.id,
        title: row.title,
        lane: row.kind === 'waiting_on' ? ('waiting_on' as const) : ('i_owe' as const),
      })),
    ];
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return sources;
  }
}

function sourceKey(source: Source) {
  return `${source.kind}:${source.id}`;
}

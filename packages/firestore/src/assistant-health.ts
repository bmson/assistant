import { createHash, randomUUID } from 'node:crypto';
import type {
  AssistantHealthObservations,
  AssistantHealthRepository,
  AssistantHealthSignal,
  MailHealthWindow,
  Records,
} from '@assistant/persistence';
import type { DocumentSnapshot, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { FirestoreMessageRepository } from './messages.js';
import { FirestoreOwnerNoticeRepository } from './owner-notices.js';
import { FirestoreProactiveHealthRepository } from './proactive-health.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

type Alert = Records['assistantHealthAlerts'];

/**
 * Rows read per observation. The monitor's thresholds are single digits, so a
 * count at this bound is still an unambiguous alert; above it the reported
 * number is a lower bound rather than a failure of the whole check.
 */
const OBSERVATION_BOUND = 2_000;
const GETALL_CHUNK = 100;

function alertKey(agentId: string, kind: string): string {
  return createHash('sha256')
    .update(JSON.stringify([agentId, kind]))
    .digest('hex');
}

/**
 * The health monitor on Firestore. Graph sources and response checks carry no
 * reliable owner field of their own, so ownership is confirmed through their
 * memory and task documents. Alerts live at a deterministic key per
 * (owner, kind) and every claim runs in one transaction, so two monitors
 * cannot both notify.
 */
export class FirestoreAssistantHealthRepository implements AssistantHealthRepository {
  readonly kind = 'assistant-health-repository' as const;
  private readonly notices: FirestoreOwnerNoticeRepository;
  private readonly messages: FirestoreMessageRepository;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {
    this.notices = new FirestoreOwnerNoticeRepository(store, configuredAgentId);
    this.messages = new FirestoreMessageRepository(store);
  }

  private scope(agentId: string): void {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Health monitor is outside the configured Firestore agent');
  }

  /** Documents in `collection` with these ids whose `agentId` is `agentId`. */
  private async owned(collection: string, ids: string[], agentId: string): Promise<Set<string>> {
    const owned = new Set<string>();
    for (let index = 0; index < ids.length; index += GETALL_CHUNK) {
      const refs = ids
        .slice(index, index + GETALL_CHUNK)
        .map((id) => this.store.doc(collection, id));
      if (refs.length === 0) continue;
      for (const snapshot of await this.store.db.getAll(...refs)) {
        if (snapshot.exists && snapshot.get('agentId') === agentId)
          owned.add(String(snapshot.get('id')));
      }
    }
    return owned;
  }

  private async ownedSources(docs: QueryDocumentSnapshot[], agentId: string): Promise<number> {
    const direct = docs.filter((doc) => doc.get('agentId') === agentId).length;
    const unscoped = docs
      .filter((doc) => doc.get('agentId') === undefined || doc.get('agentId') === null)
      .map((doc) => String(doc.get('memoryId') ?? ''))
      .filter(Boolean);
    return direct + (await this.owned('memories', unscoped, agentId)).size;
  }

  async observe({
    agentId,
    staleBefore,
    qualitySince,
  }: {
    agentId: string;
    staleBefore: Date;
    qualitySince: Date;
  }): Promise<AssistantHealthObservations> {
    this.scope(agentId);
    const sources = this.store.collection('knowledgeGraphSources');
    const [quarantined, stalePending, recall, checks] = await Promise.all([
      sources.where('status', '==', 'quarantined').limit(OBSERVATION_BOUND).get(),
      sources
        .where('status', '==', 'pending')
        .where('updatedAt', '<', staleBefore)
        .limit(OBSERVATION_BOUND)
        .get(),
      this.store
        .collection('recallMetrics')
        .where('agentId', '==', agentId)
        .where('createdAt', '>=', qualitySince)
        .limit(OBSERVATION_BOUND)
        .get(),
      this.store
        .collection('responseChecks')
        .where('createdAt', '>=', qualitySince)
        .limit(OBSERVATION_BOUND)
        .get(),
    ]);

    const ownTasks = await this.owned(
      'tasks',
      checks.docs.map((doc) => String(doc.get('taskId') ?? '')).filter(Boolean),
      agentId,
    );
    const ownChecks = checks.docs.filter((doc) => ownTasks.has(String(doc.get('taskId'))));
    const count = (docs: QueryDocumentSnapshot[], field: string) =>
      docs.filter((doc) => doc.get(field) === true).length;
    const sum = (docs: QueryDocumentSnapshot[], field: string) =>
      docs.reduce((total, doc) => total + (Number(doc.get(field)) || 0), 0);
    return {
      graphQuarantined: await this.ownedSources(quarantined.docs, agentId),
      graphStalePending: await this.ownedSources(stalePending.docs, agentId),
      graphRecallFailures: count(recall.docs, 'graphFailed'),
      historyRecallFailures: count(recall.docs, 'historyFailed'),
      verifierUnavailable: count(ownChecks, 'outputVerificationUnavailable'),
      contractBlocks: count(ownChecks, 'blocked'),
      mustActRetries: sum(ownChecks, 'mustActRetries'),
      degradedSteps: sum(ownChecks, 'degradedSteps'),
    };
  }

  observeMail(agentId: string, window: MailHealthWindow) {
    this.scope(agentId);
    return new FirestoreProactiveHealthRepository(this.store).mailCounts(agentId, window);
  }

  async claim({
    agentId,
    signals,
    now,
    renotifyBefore,
  }: {
    agentId: string;
    signals: readonly AssistantHealthSignal[];
    now: Date;
    renotifyBefore: Date;
  }): Promise<AssistantHealthSignal[]> {
    this.scope(agentId);
    return this.store.db.runTransaction(async (tx) => {
      // Every alert this owner has, including rows an import stored under
      // their legacy id, so resolution and reopening see the full history.
      const existing = await tx.get(
        this.store.collection('assistantHealthAlerts').where('agentId', '==', agentId).limit(200),
      );
      const byKind = new Map<string, DocumentSnapshot>();
      for (const doc of existing.docs) {
        const kind = String(doc.get('kind') ?? '');
        const current = byKind.get(kind);
        // Prefer the canonical key when an import left a second copy.
        if (
          !current ||
          doc.id === this.store.doc('assistantHealthAlerts', alertKey(agentId, kind)).id
        )
          byKind.set(kind, doc);
      }
      const notify: AssistantHealthSignal[] = [];
      const observed = new Set(signals.map((signal) => signal.kind));
      for (const signal of signals) {
        const doc = byKind.get(signal.kind);
        if (!doc) {
          const row: Alert = {
            id: randomUUID(),
            agentId,
            kind: signal.kind,
            detail: signal.detail,
            status: 'open',
            observationCount: 1,
            firstSeenAt: now,
            lastSeenAt: now,
            lastNotifiedAt: now,
            createdAt: now,
            updatedAt: now,
          };
          tx.create(
            this.store.doc('assistantHealthAlerts', alertKey(agentId, signal.kind)),
            encodeRecord(row),
          );
          notify.push(signal);
          continue;
        }
        const row = decodeRecord<Alert>(doc.data());
        const due =
          (!signal.notificationDueBefore && row.status !== 'open') ||
          row.lastNotifiedAt === null ||
          row.lastNotifiedAt < (signal.notificationDueBefore ?? renotifyBefore);
        tx.update(doc.ref, {
          detail: signal.detail,
          status: 'open',
          observationCount: (Number(row.observationCount) || 0) + 1,
          lastSeenAt: now,
          updatedAt: now,
          ...(due ? { lastNotifiedAt: now } : {}),
        });
        if (due) notify.push(signal);
      }
      for (const [kind, doc] of byKind) {
        if (!observed.has(kind) && doc.get('status') === 'open')
          tx.update(doc.ref, { status: 'resolved', updatedAt: now });
      }
      return notify;
    });
  }

  async release({
    agentId,
    kinds,
    claimedAt,
  }: {
    agentId: string;
    kinds: readonly string[];
    claimedAt: Date;
  }): Promise<void> {
    this.scope(agentId);
    const wanted = new Set(kinds);
    await this.store.db.runTransaction(async (tx) => {
      const alerts = await tx.get(
        this.store.collection('assistantHealthAlerts').where('agentId', '==', agentId).limit(200),
      );
      for (const doc of alerts.docs) {
        const row = decodeRecord<Alert>(doc.data());
        if (wanted.has(row.kind) && row.lastNotifiedAt?.getTime() === claimedAt.getTime())
          tx.update(doc.ref, { lastNotifiedAt: null, updatedAt: this.store.now() });
      }
    });
  }

  async notify({ agentId, text, taskId }: { agentId: string; text: string; taskId?: string }) {
    this.scope(agentId);
    const conversationId = await this.notices.notificationsConversationId();
    await this.messages.append({
      conversationId,
      ...(taskId ? { taskId } : {}),
      role: 'assistant',
      origin: 'assistant',
      parts: [{ type: 'text', text }],
      text,
    });
  }
}

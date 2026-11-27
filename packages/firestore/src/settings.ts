import type {
  NotificationPreferenceSettings,
  OwnerSettings,
  QuietHoursWindow,
  Records,
  SettingsRepository,
} from '@assistant/persistence';
import { Timestamp } from '@google-cloud/firestore';
import {
  assertPrivacyErasureInactiveInTransaction,
  privacyErasureIsActive,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const PAGE_SIZE = 500;

function createdAtOrder(value: unknown): Timestamp {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date) return Timestamp.fromDate(value);
  throw new Error('Agent has invalid creation timestamp');
}

export class FirestoreSettingsRepository implements SettingsRepository {
  readonly kind = 'settings-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId?: string,
  ) {}

  async getOwner(): Promise<OwnerSettings | null> {
    let owner: Records['agents'] | undefined;
    if (this.configuredAgentId) {
      const snapshot = await this.store.doc('agents', this.configuredAgentId).get();
      if (!snapshot.exists) return null;
      const row = decodeRecord<Records['agents']>(snapshot.data());
      if (
        row.id !== this.configuredAgentId ||
        documentKey(row.id) !== snapshot.id ||
        typeof row.name !== 'string' ||
        typeof row.timezone !== 'string' ||
        typeof row.locale !== 'string' ||
        typeof row.signature !== 'string' ||
        !(row.createdAt instanceof Date) ||
        !(row.updatedAt instanceof Date)
      )
        throw new Error('Configured agent record is malformed');
      owner = row;
    } else {
      const snapshot = await this.store.collection('agents').get();
      const rows = snapshot.docs
        .map((doc) => ({ doc, row: decodeRecord<Records['agents']>(doc.data()) }))
        .filter(({ doc, row }) => row.id && documentKey(row.id) === doc.id)
        .map(({ doc, row }) => ({ row, createdAt: createdAtOrder(doc.get('createdAt')) }))
        .sort(
          (a, b) =>
            a.createdAt.seconds - b.createdAt.seconds ||
            a.createdAt.nanoseconds - b.createdAt.nanoseconds ||
            (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
        );
      owner = rows[0]?.row;
    }
    if (!owner) return null;
    return {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      calendarId: owner.calendarId,
      phoneE164: owner.phoneE164,
      avatarUrl: owner.avatarUrl,
      signature: owner.signature,
      timezone: owner.timezone,
      locale: owner.locale,
      workspacePrefix: owner.workspacePrefix,
      browserProfilePath: owner.browserProfilePath,
      credentialRefs: owner.credentialRefs,
      createdAt: owner.createdAt,
      updatedAt: owner.updatedAt,
    };
  }

  async getNotificationPrefs(agentId: string): Promise<NotificationPreferenceSettings | null> {
    const snapshot = await this.store.doc('notificationPrefs', agentId).get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<Records['notificationPrefs']>(snapshot.data());
    if (row.agentId !== agentId) return null;
    return {
      quietStartMin: row.quietStartMin,
      quietEndMin: row.quietEndMin,
      ambientDailyCap: row.ambientDailyCap,
    };
  }

  async countHeldPings(agentId: string, since: Date) {
    let quietHours = 0;
    let dailyCap = 0;
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store
        .collection('proactivePings')
        .where('agentId', '==', agentId)
        .where('delivered', '==', false)
        .where('createdAt', '>=', since)
        .orderBy('createdAt', 'asc')
        .limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = decodeRecord<Records['proactivePings']>(doc.data());
        if (row.agentId !== agentId || row.delivered || row.createdAt < since) continue;
        if (row.reason === 'quiet-hours') quietHours += 1;
        if (row.reason === 'daily-cap') dailyCap += 1;
      }
      cursor = page.docs.at(-1);
      if (page.size < PAGE_SIZE) return { quietHours, dailyCap };
    }
  }

  async updateNotificationPrefs(
    agentId: string,
    input: NotificationPreferenceSettings,
  ): Promise<boolean> {
    const agentRef = this.store.doc('agents', agentId);
    const prefsRef = this.store.doc('notificationPrefs', agentId);
    return this.store.db.runTransaction(async (tx) => {
      const [owner, existing] = await tx.getAll(agentRef, prefsRef);
      if (!owner?.exists || owner.get('id') !== agentId) return false;
      if (existing?.exists && existing.get('agentId') !== agentId) return false;
      const now = this.store.now();
      tx.set(
        prefsRef,
        encodeRecord({
          agentId,
          ...input,
          createdAt: existing?.exists ? existing.get('createdAt') : now,
          updatedAt: now,
        }),
        { merge: true },
      );
      return true;
    });
  }

  async updateQuietHours(
    agentId: string,
    { quietStartMin, quietEndMin }: QuietHoursWindow,
  ): Promise<boolean> {
    if (this.configuredAgentId && agentId !== this.configuredAgentId) return false;
    const prefsRef = this.store.doc('notificationPrefs', agentId);
    return this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      if (
        owners.size !== 1 ||
        owners.docs[0]?.id !== this.store.doc('agents', agentId).id ||
        owners.docs[0]?.get('id') !== agentId
      )
        return false;
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const existing = await tx.get(prefsRef);
      if (existing.exists && existing.get('agentId') !== agentId) return false;
      const now = this.store.now();
      tx.set(
        prefsRef,
        encodeRecord({
          agentId,
          quietStartMin,
          quietEndMin,
          ...(!existing.exists ? { createdAt: now, ambientDailyCap: null } : {}),
          updatedAt: now,
        }),
        { merge: true },
      );
      return true;
    });
  }

  async updateOwner(
    agentId: string,
    input: { timezone: string; locale: string; signature: string },
  ): Promise<boolean> {
    const ref = this.store.doc('agents', agentId);
    return this.store.db.runTransaction(async (tx) => {
      if (this.configuredAgentId) {
        if (agentId !== this.configuredAgentId)
          throw new Error('Settings update requires the configured agent');
        const agents = await tx.get(this.store.collection('agents').limit(2));
        if (
          agents.size !== 1 ||
          agents.docs[0]?.id !== ref.id ||
          agents.docs[0]?.get('id') !== agentId
        )
          throw new Error('Settings update requires exactly one configured agent');
        const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
        if (
          erasure.exists &&
          (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
        )
          throw new Error('Privacy erasure is in progress');
      }
      const owner = await tx.get(ref);
      if (!owner.exists || owner.get('id') !== agentId) return false;
      tx.update(ref, { ...input, updatedAt: this.store.now() });
      return true;
    });
  }
}

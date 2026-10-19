import type { CalendarAccount, CalendarAccountRepository } from '@assistant/persistence';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

export class FirestoreCalendarAccountRepository implements CalendarAccountRepository {
  constructor(readonly store: InstallationStore) {}

  async list(): Promise<CalendarAccount[]> {
    const page = await this.store.collection('calendarAccounts').get();
    return page.docs
      .map((doc) => {
        const row = decodeRecord<CalendarAccount>(doc.data());
        if (
          !row ||
          typeof row.id !== 'string' ||
          documentKey(row.id) !== doc.id ||
          typeof row.email !== 'string' ||
          typeof row.clientId !== 'string' ||
          typeof row.refreshTokenEncrypted !== 'string' ||
          !Array.isArray(row.scopes) ||
          !(row.updatedAt instanceof Date)
        )
          throw new Error('Stored calendar account is malformed');
        return row;
      })
      .sort((a, b) => a.email.localeCompare(b.email));
  }

  async save(account: CalendarAccount): Promise<void> {
    await this.store.doc('calendarAccounts', account.id).set(encodeRecord(account));
  }

  async remove(id: string): Promise<void> {
    await this.store.doc('calendarAccounts', id).delete();
  }

  async recordError(id: string, credential: string, lastError: string | null): Promise<void> {
    const ref = this.store.doc('calendarAccounts', id);
    await this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return;
      const row = decodeRecord<CalendarAccount>(snapshot.data());
      if (row.refreshTokenEncrypted === credential) tx.update(ref, { lastError });
    });
  }
}

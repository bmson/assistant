import { describe, expect, it } from 'vitest';
import { FirestoreCalendarAccountRepository } from './calendar-accounts.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore calendar accounts', () => {
  it('keeps grants installation-scoped and ignores old credential errors after reconnect or disconnect', async () => {
    const store = emulatorStore();
    const other = emulatorStore();
    const accounts = new FirestoreCalendarAccountRepository(store);
    const row = {
      id: 'google-subject',
      email: 'work@example.test',
      clientId: 'client',
      refreshTokenEncrypted: 'sealed-old',
      scopes: ['calendar.readonly'],
      lastError: null,
      updatedAt: new Date(),
    };
    try {
      await accounts.save(row);
      expect(await new FirestoreCalendarAccountRepository(other).list()).toEqual([]);
      await accounts.recordError(row.id, 'sealed-old', 'Reconnect');
      expect((await accounts.list())[0]?.lastError).toBe('Reconnect');
      await accounts.save({ ...row, refreshTokenEncrypted: 'sealed-new' });
      await accounts.recordError(row.id, 'sealed-old', 'Stale failure');
      expect((await accounts.list())[0]).toMatchObject({
        refreshTokenEncrypted: 'sealed-new',
        lastError: null,
      });
      await accounts.remove(row.id);
      await accounts.recordError(row.id, 'sealed-new', 'Late failure');
      expect(await accounts.list()).toEqual([]);
    } finally {
      await disposeStore(store);
      await disposeStore(other);
    }
  });
});

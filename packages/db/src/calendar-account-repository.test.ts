import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createPostgresCalendarAccountRepository } from './calendar-account-repository.js';
import { createDb } from './client.js';

it('persists a grant and fences old credential errors across reconnect and disconnect', async () => {
  const db = createDb(process.env.DATABASE_URL ?? '');
  const accounts = createPostgresCalendarAccountRepository(db);
  const id = randomUUID();
  const row = {
    id,
    email: 'work@example.test',
    clientId: 'client',
    refreshTokenEncrypted: 'sealed-old',
    scopes: ['calendar.readonly'],
    lastError: null,
    updatedAt: new Date(),
  };
  try {
    await accounts.save(row);
    await accounts.recordError(id, 'sealed-old', 'Reconnect');
    expect((await accounts.list()).find((account) => account.id === id)?.lastError).toBe(
      'Reconnect',
    );
    await accounts.save({ ...row, refreshTokenEncrypted: 'sealed-new' });
    await accounts.recordError(id, 'sealed-old', 'Stale failure');
    expect((await accounts.list()).find((account) => account.id === id)).toMatchObject({
      refreshTokenEncrypted: 'sealed-new',
      lastError: null,
    });
    await accounts.remove(id);
    await accounts.recordError(id, 'sealed-new', 'Late failure');
    expect((await accounts.list()).find((account) => account.id === id)).toBeUndefined();
  } finally {
    await accounts.remove(id);
    await db.$client.end();
  }
});

import { sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { createDb, type Db } from './client.js';
import { assertPostgresRestoreRehearsalReadOnly } from './restore-readonly.js';

it('requires a read-only session and a non-elevated role without write grants', async () => {
  const execute = vi.fn().mockResolvedValue([
    {
      default_read_only: true,
      transaction_read_only: true,
      elevated_role: false,
      can_create_objects: false,
      can_write_public_relation: false,
    },
  ]);
  await expect(
    assertPostgresRestoreRehearsalReadOnly({ execute } as unknown as Db),
  ).resolves.toBeUndefined();

  execute.mockResolvedValueOnce([
    {
      default_read_only: true,
      transaction_read_only: true,
      elevated_role: false,
      can_create_objects: false,
      can_write_public_relation: true,
    },
  ]);
  await expect(
    assertPostgresRestoreRehearsalReadOnly({ execute } as unknown as Db),
  ).rejects.toThrow('Restore rehearsal database session is not enforced read-only');
});

it('sets PostgreSQL read-only as a server-enforced default for rehearsal connections', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
    throw new Error('Requires allocator-owned disposable _test database');
  const db = createDb(databaseUrl, { readOnly: true });
  try {
    const rows = await db.execute(
      sql`SELECT current_setting('default_transaction_read_only') AS value`,
    );
    expect(rows[0]?.value).toBe('on');
    await expect(db.execute(sql`UPDATE agents SET name = name WHERE false`)).rejects.toThrow();
  } finally {
    await db.$client.end({ timeout: 5 });
  }
});

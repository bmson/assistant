import { describe, expect, it } from 'vitest';
import { validatePostgresRestoreDrillTarget } from './postgres-restore-drill.js';

describe('PostgreSQL restore drill target guard', () => {
  it('accepts only an explicit loopback disposable database identity', () => {
    expect(
      validatePostgresRestoreDrillTarget(
        'postgres://assistant_restore_reader_0123456789ab:secret@127.0.0.1:55432/assistant_restore_0123456789ab_test',
      ),
    ).toEqual({
      database: 'assistant_restore_0123456789ab_test',
      host: '127.0.0.1',
      port: 55432,
    });
  });

  it.each([
    undefined,
    'postgres://assistant_restore_reader_0123456789ab:secret@example.com:5432/assistant_restore_0123456789ab_test',
    'postgres://assistant_restore_reader_0123456789ab:secret@localhost:5432/assistant_restore_0123456789ab_test',
    'postgres://assistant_restore_reader_0123456789ab:secret@127.0.0.1:5432/assistant',
    'postgres://assistant_restore_reader_0123456789ab:secret@127.0.0.1:5432/assistant_restore_arbitrary_test',
    'postgres://restore:secret@127.0.0.1:5432/assistant_restore_0123456789ab_test',
    'postgres://assistant_restore_reader_abcdefabcdef:secret@127.0.0.1:5432/assistant_restore_0123456789ab_test',
    'postgres://assistant_restore_reader_0123456789ab@127.0.0.1:5432/assistant_restore_0123456789ab_test',
    'http://127.0.0.1:5432/assistant_restore_0123456789ab_test',
  ])('rejects unsafe or ambiguous target %s', (url) => {
    expect(() => validatePostgresRestoreDrillTarget(url)).toThrow();
  });
});

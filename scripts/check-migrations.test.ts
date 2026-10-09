import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateMigrationJournal } from './check-migrations.js';

const journal = JSON.parse(
  readFileSync(new URL('../packages/db/drizzle/meta/_journal.json', import.meta.url), 'utf8'),
);
describe('immutable migration journal guard', () => {
  it('allows the documented historical inversion and requires its correction', () => {
    expect(() => validateMigrationJournal(journal.entries)).not.toThrow();
    expect(() =>
      validateMigrationJournal(
        journal.entries
          .filter((entry: { tag: string }) => entry.tag !== '0084_approval_identity_reconciliation')
          .map((entry: { idx: number }, idx: number) => ({ ...entry, idx })),
      ),
    ).toThrow('correction');
  });
  it('rejects future inversions and duplicated identities', () => {
    const last = journal.entries.at(-1);
    expect(() =>
      validateMigrationJournal([
        ...journal.entries,
        { ...last, idx: last.idx + 1, tag: 'future', when: last.when },
      ]),
    ).toThrow('strictly newer');
    expect(() =>
      validateMigrationJournal([
        ...journal.entries,
        { ...last, idx: last.idx + 1, when: last.when + 1 },
      ]),
    ).toThrow('identity');
  });
});

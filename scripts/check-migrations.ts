import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function validateMigrationJournal(
  entries: Array<{ idx: number; when: number; tag: string }>,
): void {
  const ids = new Set<number>(),
    tags = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (
      entry.idx !== index ||
      !Number.isSafeInteger(entry.when) ||
      ids.has(entry.idx) ||
      tags.has(entry.tag)
    )
      throw new Error('Invalid migration journal identity');
    ids.add(entry.idx);
    tags.add(entry.tag);
    const previous = entries[index - 1];
    // Preserve the pinned historical inversion; 0084 repairs its omitted invariant.
    if (
      previous &&
      entry.when <= previous.when &&
      !(entry.idx === 21 && entry.when === 1784569354578 && previous.when === 1784570400000)
    )
      throw new Error(`Migration ${entry.tag} must have a strictly newer timestamp`);
  }
  if (!entries.some((entry) => entry.tag === '0084_approval_identity_reconciliation'))
    throw new Error('Historical approval identity correction is required');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const journal = JSON.parse(
    readFileSync(new URL('../packages/db/drizzle/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };
  validateMigrationJournal(journal.entries);
  console.log(
    'Migration journal validated; historical inversion requires forward correction 0084.',
  );
}

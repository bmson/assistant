export interface MigrationTailMetadata {
  hash: string;
  folderMillis: number;
}

export interface AppliedMigrationTailRow {
  hash: unknown;
  createdAt: unknown;
}

const EXPECTED_OWNER_EDITOR_MIGRATIONS = [
  {
    folderMillis: 1_792_966_293_267,
    hash: '631bc32012855cdb76f5f64a64fed1f4f3071afa616a6447833b10115270973e',
  },
  {
    folderMillis: 1_792_974_848_505,
    hash: '47b833824d64635a1cb82f30403be575053150aaecd24a2bb03681820a36f9e3',
  },
  {
    folderMillis: 1_793_040_000_000,
    hash: 'cae24837bad4b9643b9f191bb3320f9f15338bdfb6e56356beff6cf9fb2a0610',
  },
] as const;
export class IncompatibleOwnerEditorMigrationTailError extends Error {
  constructor() {
    super('Incompatible owner-editor migration ledger.');
    this.name = 'IncompatibleOwnerEditorMigrationTailError';
  }
}

const incompatible = () => new IncompatibleOwnerEditorMigrationTailError();

/**
 * Accept only a strict prefix of the shipped owner-editor migration tail.
 * The expected metadata comes from Drizzle's readMigrationFiles; the first
 * three entries are pinned so an unmerged contact-only 0131 cannot be treated
 * as the canonical memory-0131/contact-0132 history.
 */
export function assertCompatibleOwnerEditorMigrationTail(
  expectedTail: readonly MigrationTailMetadata[],
  appliedTail: readonly AppliedMigrationTailRow[],
  requireComplete = false,
): void {
  if (expectedTail.length < EXPECTED_OWNER_EDITOR_MIGRATIONS.length) throw incompatible();

  for (let index = 0; index < expectedTail.length; index++) {
    const expected = expectedTail[index];
    if (
      !expected ||
      !/^[a-f0-9]{64}$/.test(expected.hash) ||
      !Number.isSafeInteger(expected.folderMillis) ||
      expected.folderMillis <= 0 ||
      (index > 0 && expected.folderMillis <= expectedTail[index - 1]!.folderMillis)
    )
      throw incompatible();
    const canonical = EXPECTED_OWNER_EDITOR_MIGRATIONS[index];
    if (
      canonical &&
      (expected.hash !== canonical.hash || expected.folderMillis !== canonical.folderMillis)
    )
      throw incompatible();
  }

  if (
    appliedTail.length > expectedTail.length ||
    (requireComplete && appliedTail.length !== expectedTail.length)
  )
    throw incompatible();
  for (let index = 0; index < appliedTail.length; index++) {
    const applied = appliedTail[index];
    const expected = expectedTail[index];
    if (
      !applied ||
      !expected ||
      typeof applied.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(applied.hash) ||
      typeof applied.createdAt !== 'string' ||
      !/^\d+$/.test(applied.createdAt) ||
      applied.hash !== expected.hash ||
      applied.createdAt !== String(expected.folderMillis)
    )
      throw incompatible();
  }
}

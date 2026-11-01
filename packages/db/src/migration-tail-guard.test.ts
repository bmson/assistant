import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import {
  type AppliedMigrationTailRow,
  assertCompatibleOwnerEditorMigrationTail,
  type MigrationTailMetadata,
} from './migration-tail-guard.js';

const expected: MigrationTailMetadata[] = [
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
  {
    folderMillis: 1_793_211_324_481,
    hash: '405665b0cfe4181160c973e464b36fa9841a0d3df24c5c8006d99b8758142917',
  },
];
const applied = (count: number): AppliedMigrationTailRow[] =>
  expected.slice(0, count).map((migration) => ({
    hash: migration.hash,
    createdAt: String(migration.folderMillis),
  }));

describe('owner-editor migration tail guard', () => {
  it('binds the expected tail to the actual reviewed SQL bytes and journal timestamps', () => {
    const shipped = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL('../drizzle/', import.meta.url)),
    })
      .slice(130)
      .map(({ hash, folderMillis }) => ({ hash, folderMillis }));
    expect(shipped).toEqual(expected);
  });

  it.each([0, 1, 2, 3, 4])('accepts canonical strict prefix length %i', (count) => {
    expect(() => assertCompatibleOwnerEditorMigrationTail(expected, applied(count))).not.toThrow();
  });

  it('rejects the historical contact-only 0131 watermark', () => {
    expect(() =>
      assertCompatibleOwnerEditorMigrationTail(expected, [
        applied(1)[0]!,
        { hash: expected[2]!.hash, createdAt: String(expected[2]!.folderMillis) },
      ]),
    ).toThrow('Incompatible owner-editor migration ledger.');
  });

  it('rejects hash/time mismatch, duplicate, future-extra, null and malformed rows', () => {
    const invalid: AppliedMigrationTailRow[][] = [
      [{ hash: 'a'.repeat(64), createdAt: String(expected[0]!.folderMillis) }],
      [{ hash: expected[0]!.hash, createdAt: String(expected[0]!.folderMillis + 1) }],
      [applied(1)[0]!, applied(1)[0]!],
      [...applied(4), { hash: 'b'.repeat(64), createdAt: String(expected[3]!.folderMillis + 1) }],
      [{ hash: expected[0]!.hash, createdAt: null }],
      [{ hash: 'not-a-hash', createdAt: 'not-a-time' }],
    ];
    for (const rows of invalid)
      expect(() => assertCompatibleOwnerEditorMigrationTail(expected, rows)).toThrow(
        'Incompatible owner-editor migration ledger.',
      );
  });

  it('requires all shipped tail entries for post-migration readback', () => {
    expect(() => assertCompatibleOwnerEditorMigrationTail(expected, applied(2), true)).toThrow(
      'Incompatible owner-editor migration ledger.',
    );
    expect(() => assertCompatibleOwnerEditorMigrationTail(expected, applied(3), true)).toThrow(
      'Incompatible owner-editor migration ledger.',
    );
    expect(() =>
      assertCompatibleOwnerEditorMigrationTail(expected, applied(4), true),
    ).not.toThrow();
  });

  it('rejects the pre-amendment 0133 hash even when its timestamp matches', () => {
    const generatedBeforeReview =
      'c1fd4afc945f1c9379c4979e375dc1a1e68c936ad920553e1084bf2106cdb67d';
    const divergentApplied: AppliedMigrationTailRow[] = [
      ...applied(3),
      {
        hash: generatedBeforeReview,
        createdAt: String(expected[3]!.folderMillis),
      },
    ];

    expect(() =>
      assertCompatibleOwnerEditorMigrationTail(expected, divergentApplied, true),
    ).toThrow('Incompatible owner-editor migration ledger.');
  });

  it('rejects a reviewed 0133 hash recorded at the wrong timestamp', () => {
    expect(() =>
      assertCompatibleOwnerEditorMigrationTail(expected, [
        ...applied(3),
        {
          hash: expected[3]!.hash,
          createdAt: String(expected[3]!.folderMillis + 1),
        },
      ]),
    ).toThrow('Incompatible owner-editor migration ledger.');
  });

  it('rejects a 0133 ledger row that skips contact-authority 0132', () => {
    expect(() =>
      assertCompatibleOwnerEditorMigrationTail(expected, [
        ...applied(2),
        {
          hash: expected[3]!.hash,
          createdAt: String(expected[3]!.folderMillis),
        },
      ]),
    ).toThrow('Incompatible owner-editor migration ledger.');
  });

  it('rejects an extra ledger row after the reviewed 0133 tail', () => {
    expect(() =>
      assertCompatibleOwnerEditorMigrationTail(expected, [
        ...applied(4),
        {
          hash: 'b'.repeat(64),
          createdAt: String(expected[3]!.folderMillis + 1),
        },
      ]),
    ).toThrow('Incompatible owner-editor migration ledger.');
  });
});

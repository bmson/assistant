import { readFile } from 'node:fs/promises';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { memories } from './schema.js';

const checkName = 'memories_memory_write_witness_check';
const normalizeSql = (value: string) => value.replace(/\s+/g, ' ').trim();

describe('memory write witness PostgreSQL storage contract', () => {
  it('keeps the column nullable and enforces the strict version 1 JSON shape', async () => {
    const column = getTableColumns(memories).memoryWriteWitness;
    expect(column.notNull).toBe(false);

    const check = getTableConfig(memories).checks.find(({ name }) => name === checkName);
    if (!check) throw new Error('Memory write witness structural check is missing');
    const schemaSql = new PgDialect().sqlToQuery(check.value).sql;

    for (const fragment of [
      '"memory_write_witness" IS NULL',
      `"memory_write_witness" = 'null'::jsonb`,
      "\"memory_write_witness\" - ARRAY['version','writeVersion','contentHash','attribution']",
      "ARRAY['version','writeVersion','contentHash','attribution']",
      "->'version' = '1'::jsonb",
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      "ARRAY['operationKey','requestHash','provenanceFingerprint']",
      '("memories"."memory_write_witness"->\'attribution\') = \'null\'::jsonb',
      "->>'provenanceFingerprint' ~ '^[0-9a-f]{64}$'",
      'IS TRUE',
    ]) {
      expect(schemaSql).toContain(fragment);
    }

    const migration = await readFile(
      new URL('../drizzle/0135_memory_write_witness.sql', import.meta.url),
      'utf8',
    );
    const migrationCheck = migration.match(
      /ADD CONSTRAINT "memories_memory_write_witness_check" CHECK \(([\s\S]*?)\);\s*$/,
    )?.[1];
    expect(migrationCheck).toBeDefined();
    expect(normalizeSql(schemaSql)).toBe(normalizeSql(migrationCheck ?? ''));

    const snapshot = JSON.parse(
      await readFile(new URL('../drizzle/meta/0135_snapshot.json', import.meta.url), 'utf8'),
    ) as {
      tables?: Record<string, { checkConstraints?: Record<string, { value?: string }> }>;
    };
    const snapshotCheck =
      snapshot.tables?.['public.memories']?.checkConstraints?.[checkName]?.value;
    expect(snapshotCheck).toBeDefined();
    expect(normalizeSql(schemaSql)).toBe(normalizeSql(snapshotCheck ?? ''));
  });
});

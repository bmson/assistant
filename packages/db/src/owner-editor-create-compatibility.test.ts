import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { ownerEditorOperations } from './schema.js';

const existingCommands = [
  'create_person',
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
] as const;

describe('PostgreSQL owner editor command storage boundary', () => {
  it('keeps the physical check limited to the five existing commands', () => {
    // Source-schema evidence only. PostgreSQL cannot contain a create_owner_memory receipt unless
    // a future migration changes this physical constraint; no native database is contacted.
    const commandCheck = getTableConfig(ownerEditorOperations).checks.find(
      ({ name }) => name === 'owner_editor_operation_command',
    );
    if (!commandCheck) throw new Error('PostgreSQL owner editor command check is missing');
    const sql = new PgDialect().sqlToQuery(commandCheck.value).sql;
    for (const command of existingCommands) expect(sql).toContain(`'${command}'`);
    expect(sql).not.toContain("'create_owner_memory'");
  });
});

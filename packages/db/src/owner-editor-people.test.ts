import { randomUUID } from 'node:crypto';
import {
  type OwnerEditorClaim,
  type OwnerEditorOperationRecord,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from '@assistant/persistence';
import type { SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import {
  commitPostgresOwnerEditorPerson,
  postgresOwnerEditorContact,
} from './owner-editor-people.js';
import { agents, contacts, maintenanceCursors, ownerEditorOperations } from './schema.js';

function fixture(command: 'create_person' | 'update_person_identity' = 'update_person_identity') {
  const now = new Date();
  const scope = {
    ownerId: randomUUID(),
    sessionDigest: 'a'.repeat(64),
    epoch: randomUUID(),
    privacyGeneration: null,
    command,
    operationId: randomUUID(),
    targetId: null as string | null,
    nonce: randomUUID(),
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 600000,
  };
  const claim: OwnerEditorClaim = {
    scope,
    requestHash: 'b'.repeat(64),
    claimToken: randomUUID(),
    claimExpiresAt: new Date(now.getTime() + 60000),
    statusVersion: 1,
  };
  const person = {
    id: randomUUID(),
    name: 'Alex',
    aliases: [] as string[],
    trust: 'unknown',
    relationship: '',
    emails: [],
    phones: [],
    notes: '',
    createdAt: now,
    updatedAt: now,
  };
  scope.targetId = command === 'update_person_identity' ? person.id : null;
  const record: OwnerEditorOperationRecord = {
    id: ownerEditorOperationId(scope),
    ownerId: scope.ownerId,
    epoch: scope.epoch,
    privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    operationId: scope.operationId,
    requestHash: claim.requestHash,
    scopeDigest: ownerEditorScopeDigest(scope),
    command,
    protocolVersion: 1,
    formIssuedAt: now,
    formExpiresAt: new Date(scope.expiresAt),
    claimToken: claim.claimToken,
    claimExpiresAt: claim.claimExpiresAt,
    status: 'preparing',
    statusVersion: 1,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  const state = {
    leased: false,
    people: [person],
    operation: record,
    failReceipt: false,
    events: [] as string[],
    nativeSuffix: '.000001+00',
  };
  function select(inTransaction: boolean, fields?: Record<string, unknown>) {
    if (state.leased && !inTransaction)
      throw new Error('Outer pool read while transaction owns connection');
    let table: PgTable, condition: SQL | undefined;
    const query = {
      from(value: PgTable) {
        table = value;
        return query;
      },
      where(value: SQL) {
        condition = value;
        return query;
      },
      for(mode: string) {
        state.events.push(`lock:${mode}`);
        return query;
      },
      limit() {
        return query;
      },
      // biome-ignore lint/suspicious/noThenProperty: This intentionally models Drizzle query await semantics.
      then(resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
        const params = condition ? new PgDialect().sqlToQuery(condition).params : [];
        let rows: unknown[] = [];
        if (table === agents) rows = [{ id: scope.ownerId }];
        else if (table === maintenanceCursors) {
          if (String(params[0]).startsWith('owner-editor-epoch:'))
            rows = [
              {
                cursor: JSON.stringify({
                  ownerId: scope.ownerId,
                  epoch: scope.epoch,
                  ready: true,
                  privacyGenerationDigest: ownerEditorPrivacyDigest(null),
                }),
              },
            ];
        } else if (table === ownerEditorOperations) {
          state.events.push('operation-read');
          rows = [state.operation];
        } else if (table === contacts) {
          if (fields?.contact) {
            state.events.push('contact-read');
            rows = state.people
              .filter((row) => row.id === params[0])
              .map((contact) => ({
                contact,
                native: {
                  id: contact.id,
                  name: contact.name,
                  aliases: contact.aliases,
                  trust: contact.trust,
                  updated_at: `2026-10-25 00:00:00${state.nativeSuffix}`,
                },
              }));
          } else
            rows = state.people
              .filter((row) => row.name.toLowerCase() === String(params[0]))
              .map((row) => ({ id: row.id }));
        } else throw new Error('Unexpected table');
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return query;
  }
  function update(table: PgTable) {
    let values: Record<string, unknown>;
    const query = {
      set(value: Record<string, unknown>) {
        values = value;
        return query;
      },
      where() {
        return query;
      },
      async returning() {
        if (!state.leased) throw new Error('Write without lease');
        if (table === contacts) {
          state.events.push('person-write');
          Object.assign(state.people[0]!, values);
          return [state.people[0]];
        }
        if (table === ownerEditorOperations) {
          state.events.push('receipt-write');
          if (state.failReceipt) return [];
          Object.assign(state.operation, values);
          return [state.operation];
        }
        throw new Error('Unexpected update');
      },
    };
    return query;
  }
  const tx = {
    select: (fields?: Record<string, unknown>) => select(true, fields),
    update,
    insert(table: PgTable) {
      const query = {
        values(value: Record<string, unknown>) {
          if (table !== contacts) throw new Error('Unexpected insert');
          state.events.push('person-write');
          const row = { ...person, ...value, id: randomUUID() };
          state.people.push(row);
          return query;
        },
        returning: async () => [state.people.at(-1)],
      };
      return query;
    },
  };
  const db = {
    select: (fields?: Record<string, unknown>) => select(false, fields),
    async transaction<T>(run: (value: typeof tx) => Promise<T>) {
      const originalPeople = structuredClone(state.people),
        originalOperation = structuredClone(state.operation);
      state.leased = true;
      try {
        return await run(tx);
      } catch (error) {
        state.people = originalPeople;
        state.operation = originalOperation;
        throw error;
      } finally {
        state.leased = false;
      }
    },
  } as unknown as Db;
  return { db, state, claim, person, now };
}

describe('actual PG named-person writer + actual claim/receipt fence (offline single-lease fake)', () => {
  it('uses exact native precision, preserves unknown trust, old alias and commits receipt in same transaction', async () => {
    const f = fixture();
    const snapshot = await postgresOwnerEditorContact(f.db, f.claim.scope.ownerId, f.person.id);
    f.state.nativeSuffix = '.000002+00';
    const changed = await postgresOwnerEditorContact(f.db, f.claim.scope.ownerId, f.person.id);
    expect(changed?.revision).not.toBe(snapshot?.revision);
    const result = await commitPostgresOwnerEditorPerson(
      f.db,
      f.claim,
      {
        request: {
          version: 1,
          intent: 'apply',
          command: 'update_person_identity',
          operationId: f.claim.scope.operationId,
          contactId: f.person.id,
          expectedContactRevision: changed!.revision,
          name: 'Alex New',
          aliases: [],
        },
        name: 'Alex New',
        aliases: [],
      },
      f.now,
    );
    expect(result).toMatchObject({
      authority: 'operation_receipt',
      outcome: 'saved',
      ids: { contactId: f.person.id },
    });
    expect(f.state.people[0]?.trust).toBe('unknown');
    expect(f.state.people[0]?.aliases).toEqual(['Alex']);
    expect(f.state.events.indexOf('operation-read')).toBeLessThan(
      f.state.events.indexOf('person-write'),
    );
    expect(f.state.events.slice(-2)).toEqual(['person-write', 'receipt-write']);
    expect(f.state.leased).toBe(false);
  });
  it('rejects stale browser revision without person writes and records authoritative conflict', async () => {
    const f = fixture();
    const result = await commitPostgresOwnerEditorPerson(
      f.db,
      f.claim,
      {
        request: {
          version: 1,
          intent: 'apply',
          command: 'update_person_identity',
          operationId: f.claim.scope.operationId,
          contactId: f.person.id,
          expectedContactRevision: '0'.repeat(64),
          name: 'New',
          aliases: [],
        },
        name: 'New',
        aliases: [],
      },
      f.now,
    );
    expect(result).toMatchObject({ authority: 'operation_receipt', outcome: 'conflict' });
    expect(f.state.events).not.toContain('person-write');
    expect(f.state.people[0]?.name).toBe('Alex');
  });
  it('rolls primary changes back if conditional receipt completion fails', async () => {
    const f = fixture();
    const snapshot = await postgresOwnerEditorContact(f.db, f.claim.scope.ownerId, f.person.id);
    f.state.failReceipt = true;
    await expect(
      commitPostgresOwnerEditorPerson(
        f.db,
        f.claim,
        {
          request: {
            version: 1,
            intent: 'apply',
            command: 'update_person_identity',
            operationId: f.claim.scope.operationId,
            contactId: f.person.id,
            expectedContactRevision: snapshot!.revision,
            name: 'New',
            aliases: [],
          },
          name: 'New',
          aliases: [],
        },
        f.now,
      ),
    ).rejects.toThrow('claim changed');
    expect(f.state.people[0]?.name).toBe('Alex');
    expect(f.state.operation.status).toBe('preparing');
    expect(f.state.leased).toBe(false);
  });
  it('creates known contacts explicitly, with no relationship-label mutation', async () => {
    const f = fixture('create_person');
    const result = await commitPostgresOwnerEditorPerson(
      f.db,
      f.claim,
      {
        request: {
          version: 1,
          intent: 'apply',
          command: 'create_person',
          operationId: f.claim.scope.operationId,
          name: 'Sam',
          aliases: [],
        },
        name: 'Sam',
        aliases: [],
      },
      f.now,
    );
    expect(result.outcome).toBe('saved');
    expect(f.state.people.at(-1)).toMatchObject({ name: 'Sam', trust: 'known', relationship: '' });
  });
  it('reports an exact identity no-op as unchanged without touching the person', async () => {
    const f = fixture(),
      before = await postgresOwnerEditorContact(f.db, f.claim.scope.ownerId, f.person.id);
    const result = await commitPostgresOwnerEditorPerson(
      f.db,
      f.claim,
      {
        request: {
          version: 1,
          intent: 'apply',
          command: 'update_person_identity',
          operationId: f.claim.scope.operationId,
          contactId: f.person.id,
          expectedContactRevision: before!.revision,
          name: 'Alex',
          aliases: [],
        },
        name: 'Alex',
        aliases: [],
      },
      f.now,
    );
    expect(result).toMatchObject({ authority: 'operation_receipt', outcome: 'unchanged' });
    expect(f.state.events).not.toContain('person-write');
    expect(f.state.people[0]?.trust).toBe('unknown');
  });
});

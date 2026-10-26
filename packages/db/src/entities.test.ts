import { profileContactIdentityRevision } from '@assistant/persistence';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  deleteContact,
  findContactsByName,
  findDuplicateContactSuggestions,
  mergeContacts,
  normalizeContactAliases,
  normalizeContactName,
  renameContact,
  resolveSubjectContact,
  updateContactIdentity,
} from './entities.js';
import { contacts, memories, memoryTombstones, occasions } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let ownerId: string;
let ownerOriginalName: string;
let agentId: string;
const createdContactIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
    if (!owner) throw new Error('no owner');
    ownerId = owner.id;
    ownerOriginalName = owner.name;
    const [agentRow] = await db.execute(sql`select id from agents limit 1`);
    agentId = (agentRow as { id: string }).id;
    dbUp = true;
  } catch {
    console.warn('entities.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db.update(contacts).set({ name: ownerOriginalName }).where(eq(contacts.id, ownerId));
    await db.delete(memories).where(sql`${memories.content} LIKE 'xtest-entities%'`);
    await db
      .delete(memoryTombstones)
      .where(sql`${memoryTombstones.contentHash} LIKE 'xtest-entities-%'`);
    // occasions reference contacts with no cascade — clear them before the rows go.
    await db.execute(
      sql`delete from occasions where contact_id in (select id from contacts where name like 'Xtest%')`,
    );
    if (createdContactIds.length) {
      await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
    }
    await db.delete(contacts).where(sql`${contacts.name} LIKE 'Xtest%'`);
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('contact names', () => {
  it('normalizes whitespace and rejects unsafe names', () => {
    expect(normalizeContactName('  Anna   Jónsdóttir  ')).toBe('Anna Jónsdóttir');
    expect(() => normalizeContactName('   ')).toThrow('required');
    expect(() => normalizeContactName(`Anna\u0000Bad`)).toThrow('control');
    expect(() => normalizeContactName('x'.repeat(121))).toThrow('120');
    expect(normalizeContactAliases([' Annie ', 'annie', 'Anna'], 'Anna')).toEqual(['Annie']);
  });

  it('suggests duplicate people from names, aliases, email, or phone without auto-merging', () => {
    const suggestions = findDuplicateContactSuggestions([
      {
        id: 'first',
        name: 'Anna Jónsdóttir',
        aliases: ['Annie'],
        emails: [],
        phones: [],
        trust: 'known',
      },
      {
        id: 'second',
        name: 'Annie',
        aliases: [],
        emails: [],
        phones: [],
        trust: 'unknown',
      },
      {
        id: 'third',
        name: 'Different Person',
        aliases: [],
        emails: ['shared@example.com'],
        phones: [],
        trust: 'known',
      },
      {
        id: 'fourth',
        name: 'Another Person',
        aliases: [],
        emails: ['SHARED@example.com'],
        phones: [],
        trust: 'unknown',
      },
    ]);
    expect(suggestions).toEqual([
      { contactId: 'second', targetId: 'first', reason: 'matching name or alias' },
      { contactId: 'fourth', targetId: 'third', reason: 'same email' },
    ]);
  });

  it('renames a non-owner person but never the owner', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [person] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Old Name', trust: 'known' })
      .returning();
    if (!person) throw new Error('failed to create test person');
    createdContactIds.push(person.id);

    const [before] = await db
      .select({ native: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
      .from(contacts)
      .where(eq(contacts.id, person.id));
    if (!before) throw new Error('missing test contact snapshot');
    const revision = profileContactIdentityRevision({
      driver: 'postgres',
      ownerId: agentId,
      native: before.native,
    });

    await expect(
      renameContact(db, {
        contactId: person.id,
        name: '  Xtest-New   Name ',
        expectedContactRevision: revision,
      }),
    ).resolves.toEqual({ status: 'updated', name: 'Xtest-New Name', aliases: ['Xtest-Old Name'] });
    const [renamed] = await db.select().from(contacts).where(eq(contacts.id, person.id));
    expect(renamed?.name).toBe('Xtest-New Name');
    expect(renamed?.aliases).toContain('Xtest-Old Name');
    const resolvedOldName = await resolveSubjectContact(db, { subject: 'Xtest-Old Name' });
    expect(resolvedOldName?.contactId).toBe(person.id);
    const [stillCanonical] = await db.select().from(contacts).where(eq(contacts.id, person.id));
    expect(stillCanonical?.name).toBe('Xtest-New Name');

    const [ownerBefore] = await db
      .select({ native: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
      .from(contacts)
      .where(eq(contacts.id, ownerId));
    if (!ownerBefore) throw new Error('missing owner test snapshot');
    await expect(
      renameContact(db, {
        contactId: ownerId,
        name: 'Not the owner',
        expectedContactRevision: profileContactIdentityRevision({
          driver: 'postgres',
          ownerId: agentId,
          native: ownerBefore.native,
        }),
      }),
    ).resolves.toEqual({ status: 'not_found' });
  });

  it('rejects missing and stale contact revisions before replacing an owner edit', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [person] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Revision Before', trust: 'known', identityAuthority: 'inferred' })
      .returning();
    if (!person) throw new Error('failed to create revision test person');
    createdContactIds.push(person.id);
    const [before] = await db
      .select({ native: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
      .from(contacts)
      .where(eq(contacts.id, person.id));
    if (!before) throw new Error('missing revision test snapshot');
    const oldRevision = profileContactIdentityRevision({
      driver: 'postgres',
      ownerId: agentId,
      native: before.native,
    });

    await expect(
      updateContactIdentity(db, {
        contactId: person.id,
        name: 'Xtest-Missing Revision',
        aliases: ['Xtest-Missing Alias'],
        relationship: 'missing-revision-relationship',
      }),
    ).resolves.toEqual({ status: 'review_required' });
    const [afterMissing] = await db.select().from(contacts).where(eq(contacts.id, person.id));
    expect(afterMissing).toMatchObject({
      name: 'Xtest-Revision Before',
      aliases: [],
      relationship: '',
      identityAuthority: 'inferred',
      trust: 'known',
    });

    await expect(
      updateContactIdentity(db, {
        contactId: person.id,
        name: 'Xtest-Combined Name',
        aliases: ['Xtest-Combined Alias'],
        relationship: 'combined relationship',
        expectedContactRevision: oldRevision,
      }),
    ).resolves.toMatchObject({
      status: 'updated',
      name: 'Xtest-Combined Name',
      aliases: ['Xtest-Combined Alias', 'Xtest-Revision Before'],
    });
    const [afterCombined] = await db.select().from(contacts).where(eq(contacts.id, person.id));
    expect(afterCombined).toMatchObject({
      name: 'Xtest-Combined Name',
      aliases: ['Xtest-Combined Alias', 'Xtest-Revision Before'],
      relationship: 'combined relationship',
      identityAuthority: 'owner',
      trust: 'known',
    });

    await db
      .update(contacts)
      .set({
        name: 'Xtest-Owner Chosen',
        aliases: ['Xtest-Owner Alias'],
        relationship: 'intervening relationship',
        identityAuthority: 'owner',
        updatedAt: sql`now()`,
      })
      .where(eq(contacts.id, person.id));
    await expect(
      updateContactIdentity(db, {
        contactId: person.id,
        name: 'Xtest-Stale Inference',
        aliases: ['Xtest-Stale Alias'],
        relationship: 'stale relationship',
        expectedContactRevision: oldRevision,
      }),
    ).resolves.toEqual({ status: 'conflict' });
    const [after] = await db.select().from(contacts).where(eq(contacts.id, person.id));
    expect(after).toMatchObject({
      name: 'Xtest-Owner Chosen',
      aliases: ['Xtest-Owner Alias'],
      relationship: 'intervening relationship',
      identityAuthority: 'owner',
    });

    const [failureBefore] = await db
      .select({ native: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
      .from(contacts)
      .where(eq(contacts.id, person.id));
    if (!failureBefore) throw new Error('missing pre-failure contact');
    const failureRevision = profileContactIdentityRevision({
      driver: 'postgres',
      ownerId: agentId,
      native: failureBefore.native,
    });
    await expect(
      updateContactIdentity(db, {
        contactId: person.id,
        name: 'Xtest-Failure Name',
        aliases: ['Xtest-Failure Alias'],
        // PostgreSQL text rejects NUL; the native UPDATE must fail and roll back.
        relationship: 'invalid\u0000relationship',
        expectedContactRevision: failureRevision,
      }),
    ).rejects.toThrow();
    const [afterFailure] = await db.select().from(contacts).where(eq(contacts.id, person.id));
    expect(afterFailure).toMatchObject({
      name: 'Xtest-Owner Chosen',
      aliases: ['Xtest-Owner Alias'],
      relationship: 'intervening relationship',
      identityAuthority: 'owner',
    });
  });

  it('deletes a person, tombstones their facts, and never deletes the owner', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [person] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Delete Person', trust: 'known' })
      .returning();
    if (!person) throw new Error('failed to create test person');
    const contentHash = 'xtest-entities-delete-contact-hash';
    const [personFact] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'person',
        content: 'xtest-entities: delete this person fact',
        contentHash,
        originTrust: 'owner',
        subjectContactId: person.id,
      })
      .returning();
    if (!personFact) throw new Error('failed to create test person fact');
    const referringHash = 'xtest-entities-delete-referring-hash';
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: 'xtest-entities: fact that previously referred to the deleted fact',
      contentHash: referringHash,
      originTrust: 'owner',
      subjectContactId: ownerId,
      supersededById: personFact.id,
    });

    await expect(deleteContact(db, person.id)).resolves.toEqual({
      deletedMemories: 1,
      deletedOccasions: 0,
    });
    const [[deletedPerson], [deletedFact], [tombstone], [referringFact]] = await Promise.all([
      db.select().from(contacts).where(eq(contacts.id, person.id)),
      db.select().from(memories).where(eq(memories.contentHash, contentHash)),
      db.select().from(memoryTombstones).where(eq(memoryTombstones.contentHash, contentHash)),
      db.select().from(memories).where(eq(memories.contentHash, referringHash)),
    ]);
    expect(deletedPerson).toBeUndefined();
    expect(deletedFact).toBeUndefined();
    expect(tombstone?.reason).toBe('owner_delete_contact');
    expect(referringFact?.supersededById).toBeNull();

    await expect(deleteContact(db, ownerId)).rejects.toThrow('cannot be deleted');
  });

  it('deletes a person who still has an unapproved occasion', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [person] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Delete Occasion Person', trust: 'known' })
      .returning();
    if (!person) throw new Error('failed to create test person');
    const contentHash = 'xtest-entities-delete-occasion-hash';
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'person',
      content: 'xtest-entities: fact about a person with an unapproved birthday',
      contentHash,
      originTrust: 'unknown',
      subjectContactId: person.id,
    });
    const [occasion] = await db
      .insert(occasions)
      .values({
        agentId,
        contactId: person.id,
        kind: 'birthday',
        month: 3,
        day: 14,
        originTrust: 'unknown',
        quarantined: true,
      })
      .returning();
    if (!occasion) throw new Error('failed to create test occasion');

    await expect(deleteContact(db, person.id)).resolves.toEqual({
      deletedMemories: 1,
      deletedOccasions: 1,
    });
    const [[deletedPerson], [deletedOccasion]] = await Promise.all([
      db.select().from(contacts).where(eq(contacts.id, person.id)),
      db.select().from(occasions).where(eq(occasions.id, occasion.id)),
    ]);
    expect(deletedPerson).toBeUndefined();
    expect(deletedOccasion).toBeUndefined();
  });
});

describe('findContactsByName', () => {
  it('resolves a person by name prefix and returns their saved emails, but not a stranger', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [person] = await db
      .insert(contacts)
      .values({
        name: 'Xtest Anna Jónsdóttir',
        emails: ['anna@example.com'],
        phones: ['+15551234567'],
        trust: 'known',
      })
      .returning();
    if (!person) throw new Error('failed to create test person');
    createdContactIds.push(person.id);

    const byPrefix = await findContactsByName(db, 'Xtest Anna');
    expect(byPrefix.map((c) => c.id)).toContain(person.id);
    expect(byPrefix.find((c) => c.id === person.id)?.emails).toContain('anna@example.com');

    const noMatch = await findContactsByName(db, 'Zzz Nonexistent Person');
    expect(noMatch.map((c) => c.id)).not.toContain(person.id);
  });
});

describe('resolveSubjectContact', () => {
  it('never creates a contact for the assistant itself', async (ctx) => {
    if (!dbUp) return ctx.skip();
    expect(await resolveSubjectContact(db, { subject: 'assistant' })).toBeNull();
    expect(await resolveSubjectContact(db, { subject: 'AI Bot' })).toBeNull();
  });

  it('resolves an exact candidate by its nested native row identity', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [person] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Exact Candidate', trust: 'unknown' })
      .returning();
    if (!person) throw new Error('failed to create exact candidate');
    createdContactIds.push(person.id);
    await expect(resolveSubjectContact(db, { subject: 'Xtest-Exact Candidate' })).resolves.toEqual({
      contactId: person.id,
      created: false,
    });
  });

  it("matches the owner's fuller name but never changes the owner's identity", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [owner] = await db.select().from(contacts).where(eq(contacts.id, ownerId));
    const fullName = `${owner?.name} Xtestson`;

    const resolved = await resolveSubjectContact(db, { subject: fullName });
    expect(resolved?.contactId).toBe(ownerId);
    expect(resolved?.created).toBe(false);

    const [after] = await db.select().from(contacts).where(eq(contacts.id, ownerId));
    expect(after?.name).toBe(owner?.name);
    // The fuller name resolves without granting an inferred owner identity write.
    const again = await resolveSubjectContact(db, { subject: fullName });
    expect(again?.contactId).toBe(ownerId);
  });

  it('treats "Anna" and "Anna Xtestdóttir" as the same person, fuller name wins', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const first = await resolveSubjectContact(db, {
      subject: 'Xtest-Anna',
      relationship: 'friend',
    });
    expect(first?.created).toBe(true);
    if (first) createdContactIds.push(first.contactId);

    const fuller = await resolveSubjectContact(db, { subject: 'Xtest-Anna Jónsdóttir' });
    expect(fuller?.created).toBe(false);
    expect(fuller?.contactId).toBe(first?.contactId);

    const [row] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, first?.contactId ?? ''));
    expect(row?.name).toBe('Xtest-Anna Jónsdóttir');
    expect(row?.relationship).toBe('friend');
    expect(row?.identityAuthority).toBe('inferred');

    // the short form still resolves to the same (now fuller-named) contact
    const short = await resolveSubjectContact(db, { subject: 'xtest-anna' });
    expect(short?.contactId).toBe(first?.contactId);
  });

  it('does not infer a replacement identity for legacy contacts with unknown authority', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [legacy] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Legacy Name', relationship: 'friend', trust: 'unknown' })
      .returning();
    if (!legacy) throw new Error('failed to create legacy contact');
    createdContactIds.push(legacy.id);
    const resolved = await resolveSubjectContact(db, { subject: 'Xtest-Legacy Name Extended' });
    expect(resolved).toEqual({ contactId: legacy.id, created: false });
    const [after] = await db.select().from(contacts).where(eq(contacts.id, legacy.id));
    expect(after).toMatchObject({ name: 'Xtest-Legacy Name', identityAuthority: null });
  });
});

describe('mergeContacts', () => {
  it('moves facts, unions fields, deletes the duplicate', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [dup] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Dup', relationship: 'cousin', emails: ['dup@x.is'], trust: 'unknown' })
      .returning();
    const [target] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Dup Fullname', emails: ['full@x.is'], trust: 'unknown' })
      .returning();
    createdContactIds.push((target as NonNullable<typeof target>).id);

    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: 'xtest-entities: dup fact',
      contentHash: 'xtest-entities-hash-1',
      originTrust: 'owner',
      subjectContactId: (dup as NonNullable<typeof dup>).id,
    });

    const result = await mergeContacts(db, {
      sourceId: (dup as NonNullable<typeof dup>).id,
      targetId: (target as NonNullable<typeof target>).id,
    });
    expect(result.movedMemories).toBe(1);

    const [gone] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, (dup as NonNullable<typeof dup>).id));
    expect(gone).toBeUndefined();
    const [merged] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, (target as NonNullable<typeof target>).id));
    expect(merged?.relationship).toBe('cousin');
    expect(merged?.aliases).toContain('Xtest-Dup');
    expect(merged?.identityAuthority).toBe('owner');
    expect(merged?.emails.sort()).toEqual(['dup@x.is', 'full@x.is']);
    const [fact] = await db
      .select()
      .from(memories)
      .where(eq(memories.contentHash, 'xtest-entities-hash-1'));
    expect(fact?.subjectContactId).toBe((target as NonNullable<typeof target>).id);
  });

  it('moves occasions to the target and drops a colliding duplicate', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [dup] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Dup Dates', trust: 'unknown' })
      .returning();
    const [target] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Dup Dates Fullname', trust: 'unknown' })
      .returning();
    if (!dup || !target) throw new Error('failed to create test people');
    createdContactIds.push(target.id);

    await db.insert(occasions).values([
      // the duplicate holds the same birthday as the target, plus a date only it knows
      { agentId, contactId: dup.id, kind: 'birthday', month: 4, day: 2, quarantined: true },
      { agentId, contactId: dup.id, kind: 'anniversary', month: 9, day: 9 },
      { agentId, contactId: target.id, kind: 'birthday', month: 4, day: 2 },
    ]);

    const result = await mergeContacts(db, { sourceId: dup.id, targetId: target.id });
    expect(result.movedOccasions).toBe(1);

    const merged = await db.select().from(occasions).where(eq(occasions.contactId, target.id));
    expect(merged.map((row) => row.kind).sort()).toEqual(['anniversary', 'birthday']);
    expect(merged.filter((row) => row.kind === 'birthday')).toHaveLength(1);
    const [gone] = await db.select().from(contacts).where(eq(contacts.id, dup.id));
    expect(gone).toBeUndefined();
  });

  it('refuses to merge the owner away', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [other] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Other', trust: 'unknown' })
      .returning();
    createdContactIds.push((other as NonNullable<typeof other>).id);
    await expect(
      mergeContacts(db, { sourceId: ownerId, targetId: (other as NonNullable<typeof other>).id }),
    ).rejects.toThrow(/owner/);
  });
});

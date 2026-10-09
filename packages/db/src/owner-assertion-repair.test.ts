import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from './client.js';
import {
  agents,
  knowledgeGraphAssertionEvidence,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  memories,
} from './schema.js';

it('repairs only exactly supported owner-authored legacy assertions and is idempotent', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const owner = randomUUID();
  const journal = JSON.parse(
    await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  const entry = journal.entries.find((item) => item.idx === 112);
  if (!entry) throw new Error('Owner assertion repair migration is missing');
  const repair = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
  const asserted = { tense: 'present', polarity: 'positive', modality: 'asserted' } as const;
  const unverified = {
    tense: 'unspecified',
    polarity: 'positive',
    modality: 'unverified',
  } as const;
  const cases = [
    'eligible',
    'imported',
    'unconfirmed-source',
    'external-trust',
    'inferred-claim',
    'rejected-claim',
    'superseded-claim',
    'rejected-edge',
    'changed-source-hash',
    'changed-quote',
    'other-author',
    'other-trust',
    'different-fingerprint',
    'stale-reviewed-revision',
    'stale-reviewed-hash',
    'different-predicate',
  ];
  try {
    await db.insert(agents).values({
      id: owner,
      name: 'Assertion repair fixture',
      email: `${owner}@example.test`,
      workspacePrefix: `test/${owner}`,
    });
    const relations = new Map<string, string>();
    for (const label of cases) {
      const source = randomUUID();
      const subject = randomUUID();
      const object = randomUUID();
      const claim = randomUUID();
      const relation = randomUUID();
      const quote = `Owner ${label} works at Example ${label}.`;
      const hash = randomUUID();
      await db.insert(memories).values({
        id: source,
        agentId: owner,
        category: 'knowledge',
        kind: 'fact',
        content: quote,
        contentHash: hash,
        source: label === 'imported' ? 'archive-import' : 'knowledge-graph-owner',
        originTrust: label === 'external-trust' ? 'unknown' : 'owner',
        ownerConfirmed: label !== 'unconfirmed-source',
      });
      await db.insert(knowledgeGraphEntities).values([
        { id: subject, agentId: owner, canonicalKey: `person:${label}`, label, kind: 'person' },
        {
          id: object,
          agentId: owner,
          canonicalKey: `organization:${label}`,
          label: `Example ${label}`,
          kind: 'organization',
        },
      ]);
      await db.insert(knowledgeGraphAssertions).values({
        id: claim,
        agentId: owner,
        semanticKey: label,
        subjectEntityId: subject,
        predicate: 'works_at',
        objectEntityId: object,
        assertion: asserted,
        ownerAuthored: label !== 'inferred-claim',
        reviewStatus: label === 'rejected-claim' ? 'rejected' : 'confirmed',
        reviewedRevision: label === 'stale-reviewed-revision' ? 2 : 1,
        reviewedPayloadHash: label === 'stale-reviewed-hash' ? 'old-semantic-key' : label,
        lifecycle: label === 'superseded-claim' ? 'superseded' : 'current',
      });
      await db.insert(knowledgeGraphRelations).values({
        id: relation,
        agentId: owner,
        subjectEntityId: subject,
        predicate: label === 'different-predicate' ? 'knows' : 'works_at',
        objectEntityId: object,
        assertionId: claim,
        assertion: unverified,
        sourceMemoryId: source,
        evidenceQuote: label === 'changed-quote' ? 'Unrelated quotation' : quote,
        sourceFingerprint: label,
        ordinal: 1,
        reviewStatus: label === 'rejected-edge' ? 'rejected' : 'confirmed',
      });
      await db.insert(knowledgeGraphAssertionEvidence).values({
        id: randomUUID(),
        agentId: owner,
        assertionId: claim,
        sourceMemoryId: source,
        sourceFingerprint: label === 'different-fingerprint' ? 'other-span' : label,
        sourceContentHash: label === 'changed-source-hash' ? randomUUID() : hash,
        evidenceQuote: quote,
        sourceAuthor: label === 'other-author' ? 'other' : 'owner',
        sourceTrust: label === 'other-trust' ? 'unknown' : 'owner',
        extractionVersion: 4,
        observedAt: new Date(),
      });
      relations.set(label, relation);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await db.execute(sql.raw(repair));
      const rows = await db
        .select({ id: knowledgeGraphRelations.id, assertion: knowledgeGraphRelations.assertion })
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.agentId, owner));
      expect(rows).toHaveLength(cases.length);
      for (const label of cases)
        expect(rows.find((row) => row.id === relations.get(label))?.assertion).toEqual(
          label === 'eligible' ? asserted : unverified,
        );
    }
  } finally {
    await db.delete(memories).where(eq(memories.agentId, owner));
    await db.delete(agents).where(eq(agents.id, owner));
    await db.$client.end();
  }
});

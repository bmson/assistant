import { randomUUID } from 'node:crypto';
import { agents, createDb, type Db, improvementProposals, modelRoles, models } from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { applyProposal, dismissProposal } from './improve.js';

describe('atomic owner improvement decisions', () => {
  let db: Db;
  let agentId: string;
  let available = false;
  let original: { primaryModel: string; fallbackModel: string };
  const candidateId = `xtest-improvement-${randomUUID()}`;
  const proposals: string[] = [];

  beforeAll(async () => {
    db = createDb(
      process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant_test',
    );
    try {
      agentId = (await getAgent(db)).id;
      const [role] = await db.select().from(modelRoles).where(eq(modelRoles.role, 'draft'));
      if (!role) throw new Error('Seeded draft role is required');
      original = { primaryModel: role.primaryModel, fallbackModel: role.fallbackModel };
      await db.insert(models).values({
        id: candidateId,
        label: 'Synthetic proposal candidate',
        promptCostPerMTok: '0',
        completionCostPerMTok: '0',
        capabilities: {},
      });
      available = true;
    } catch {
      console.warn('improve-decisions.test: database unavailable');
    }
  });
  afterEach(async () => {
    if (!available) return;
    await db.update(modelRoles).set(original).where(eq(modelRoles.role, 'draft'));
  });
  afterAll(async () => {
    if (!available) return;
    if (proposals.length)
      await db.delete(improvementProposals).where(inArray(improvementProposals.id, proposals));
    await db.delete(models).where(eq(models.id, candidateId));
  });

  async function seed(
    kind = 'model_role',
    change: Record<string, unknown> = { role: 'draft', primaryModel: candidateId },
  ) {
    const [row] = await db
      .insert(improvementProposals)
      .values({
        agentId,
        kind,
        title: `xtest-proposal-${randomUUID()}`,
        change,
        evidenceIds: ['synthetic-task'],
      })
      .returning();
    if (!row) throw new Error('Proposal fixture missing');
    proposals.push(row.id);
    return row;
  }
  async function state(id: string) {
    const [proposal] = await db
      .select()
      .from(improvementProposals)
      .where(eq(improvementProposals.id, id));
    const [role] = await db.select().from(modelRoles).where(eq(modelRoles.role, 'draft'));
    return { proposal, role };
  }

  it('separates acknowledgment and repeated decisions from applied changes', async (ctx) => {
    if (!available) return ctx.skip();
    const proposal = await seed('note', { suggestion: 'Investigate the behavior' });
    expect(await applyProposal(db, proposal.id, agentId)).toMatchObject({
      outcome: 'acknowledged',
      enacted: false,
    });
    expect(await dismissProposal(db, proposal.id, agentId)).toMatchObject({
      outcome: 'already_decided',
      enacted: false,
    });
    expect((await state(proposal.id)).proposal?.status).toBe('applied');
  });

  it('returns already current without claiming a configuration mutation', async (ctx) => {
    if (!available) return ctx.skip();
    await db
      .update(modelRoles)
      .set({ primaryModel: candidateId })
      .where(eq(modelRoles.role, 'draft'));
    const proposal = await seed();
    expect(await applyProposal(db, proposal.id, agentId)).toMatchObject({
      outcome: 'already_current',
      enacted: false,
    });
    expect((await state(proposal.id)).proposal?.status).toBe('applied');
  });

  it('refuses a partial swap and keeps both routing fields and the proposal intact', async (ctx) => {
    if (!available) return ctx.skip();
    const proposal = await seed('model_role', {
      role: 'draft',
      primaryModel: candidateId,
      fallbackModel: 'missing/model',
    });
    await expect(applyProposal(db, proposal.id, agentId)).rejects.toThrow(
      'not enabled with prices',
    );
    const after = await state(proposal.id);
    expect(after.proposal?.status).toBe('open');
    expect(after.role).toMatchObject(original);
  });

  it('serializes simultaneous approvals and apply versus dismiss', async (ctx) => {
    if (!available) return ctx.skip();
    const duplicate = await seed();
    const same = await Promise.all([
      applyProposal(db, duplicate.id, agentId),
      applyProposal(db, duplicate.id, agentId),
    ]);
    expect(same.map((row) => row.outcome).sort()).toEqual(['already_decided', 'applied']);
    await db.update(modelRoles).set(original).where(eq(modelRoles.role, 'draft'));
    const contested = await seed();
    const results = await Promise.all([
      applyProposal(db, contested.id, agentId),
      dismissProposal(db, contested.id, agentId),
    ]);
    const after = await state(contested.id);
    expect(results.filter((row) => row.outcome === 'already_decided')).toHaveLength(1);
    expect(after.role?.primaryModel).toBe(
      after.proposal?.status === 'applied' ? candidateId : original.primaryModel,
    );
    expect(results.filter((row) => row.enacted)).toHaveLength(
      after.proposal?.status === 'applied' ? 1 : 0,
    );
  });

  it('rolls back routing when the proposal decision cannot be persisted', async (ctx) => {
    if (!available) return ctx.skip();
    const proposal = await seed();
    // Exercise a real PostgreSQL transaction, with an injected write failure
    // exactly after its routing update and before its ledger update.
    const failing = new Proxy(db, {
      get(target, property) {
        if (property !== 'transaction') return Reflect.get(target, property);
        return (work: (tx: unknown) => Promise<unknown>) =>
          target.transaction((tx) =>
            work(
              new Proxy(tx, {
                get(transaction, key) {
                  if (key !== 'update') return Reflect.get(transaction, key);
                  return (table: unknown) => {
                    if (table === improvementProposals)
                      throw new Error('Injected proposal persistence failure');
                    return transaction.update(table as typeof modelRoles);
                  };
                },
              }),
            ),
          );
      },
    }) as Db;
    await expect(applyProposal(failing, proposal.id, agentId)).rejects.toThrow(
      'Injected proposal persistence failure',
    );
    const after = await state(proposal.id);
    expect(after.proposal?.status).toBe('open');
    expect(after.role).toMatchObject(original);
  });

  it('refuses a different owner and does not mutate their proposal', async (ctx) => {
    if (!available) return ctx.skip();
    const proposal = await seed('note');
    const [other] = await db
      .insert(agents)
      .values({
        name: 'Synthetic foreign owner',
        email: `xtest-proposal-owner-${randomUUID()}@example.com`,
        workspacePrefix: `xtest-proposal-owner-${randomUUID()}`,
      })
      .returning();
    if (!other) throw new Error('Foreign owner fixture missing');
    try {
      await expect(applyProposal(db, proposal.id, other.id)).rejects.toThrow(
        'Owned improvement proposal was not found',
      );
      await expect(dismissProposal(db, proposal.id, other.id)).rejects.toThrow(
        'Owned improvement proposal was not found',
      );
      expect((await state(proposal.id)).proposal?.status).toBe('open');
    } finally {
      await db.delete(agents).where(eq(agents.id, other.id));
    }
  });
});

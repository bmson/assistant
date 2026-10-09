import { randomUUID } from 'node:crypto';
import {
  agents,
  anomalies,
  approvalPolicies,
  conversations,
  createDb,
  type Db,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import {
  dismissAnomaly,
  listOpenAnomalies,
  runAnomalyScan,
  suspendAnomalyPolicy,
} from './anomaly.js';
import { enqueueTask } from './machine.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('approval anomaly detection', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  let taskId: string;
  const createdForeignAgentIds: string[] = [];
  const createdAnomalyIds: string[] = [];
  const createdPolicyIds: string[] = [];
  const insertedToolCallIds: string[] = [];

  async function insertAutoExec(
    policyId: string,
    toolName: string,
    createdAt: Date,
  ): Promise<void> {
    const [row] = await db
      .insert(toolCalls)
      .values({
        taskId,
        step: 0,
        toolName,
        args: {},
        risk: 'autonomous',
        status: 'succeeded',
        decision: { policyId, riskTier: 'autonomous', reason: 'policy allow' },
        createdAt,
      })
      .returning({ id: toolCalls.id });
    if (row) insertedToolCallIds.push(row.id);
  }

  async function makePolicy(toolName: string, recipient: string): Promise<string> {
    const [row] = await db
      .insert(approvalPolicies)
      .values({
        agentId,
        toolName,
        templateKey: 'gmail.send.to_recipient',
        match: { recipient },
        effect: 'allow',
        createdVia: 'approval_dialog',
      })
      .returning({ id: approvalPolicies.id });
    const id = row?.id ?? '';
    createdPolicyIds.push(id);
    return id;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      const { task } = await enqueueTask(db, {
        event: {
          source: 'internal',
          agentId,
          trust: 'assistant',
          payload: { note: 'xtest-anomaly' },
        },
        type: 'adhoc',
      });
      taskId = task.id;
      dbUp = true;
    } catch {
      console.warn('anomaly.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) {
      if (createdAnomalyIds.length)
        await db.delete(anomalies).where(inArray(anomalies.id, createdAnomalyIds));
      if (createdPolicyIds.length) {
        await db.delete(anomalies).where(inArray(anomalies.policyId, createdPolicyIds));
        await db.delete(approvalPolicies).where(inArray(approvalPolicies.id, createdPolicyIds));
      }
      if (createdForeignAgentIds.length)
        await db.delete(agents).where(inArray(agents.id, createdForeignAgentIds));
      if (insertedToolCallIds.length) {
        await db.delete(toolCalls).where(inArray(toolCalls.id, insertedToolCallIds));
      }
      await db.delete(messages).where(eq(messages.taskId, taskId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
      // remove the Notifications conversation only if it is now empty
      const [notif] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')));
      if (notif) {
        const remaining = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, notif.id))
          .limit(1);
        if (remaining.length === 0)
          await db.delete(conversations).where(eq(conversations.id, notif.id));
      }
    }
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('flags a burst, cites the calls, notifies, dedupes, and suspends the policy', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const policyId = await makePolicy('gmail.send', `burst-${Date.now()}@x.com`);
    // Pin to noon UTC so the off-hours detector (00:00-06:00 UTC) never also fires
    // on these outward-tool calls — this test asserts exactly one (burst) anomaly.
    const now = new Date();
    now.setUTCHours(12, 0, 0, 0);
    // exactly BURST_MIN (5) auto-execs within a couple of minutes → burst, but not
    // over the frequency threshold (5 is not > 5), so exactly one anomaly.
    for (let i = 0; i < 5; i++) {
      await insertAutoExec(policyId, 'gmail.send', new Date(now.getTime() - i * 30_000));
    }

    const first = await runAnomalyScan({ db }, { now });
    expect(first.flagged).toBe(1);
    expect(first.byKind.burst).toBe(1);

    const open = (await listOpenAnomalies(db, agentId)).filter((a) => a.policyId === policyId);
    expect(open).toHaveLength(1);
    const anomaly = open[0];
    expect(anomaly?.kind).toBe('burst');
    expect(anomaly?.toolCallIds.length).toBe(5); // cites every call in the burst
    expect(anomaly?.observed).toBe(5);

    // the owner was notified in the Notifications thread
    const [notif] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')));
    const notices = await db
      .select({ text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, notif?.id ?? ''));
    expect(notices.some((m) => m.text.includes('anomal'))).toBe(true);

    // re-scan: same window → deduped, nothing new.
    const second = await runAnomalyScan({ db }, { now });
    expect(second.flagged).toBe(0);

    // suspend the policy behind it → policy disabled, anomaly marked suspended.
    const foreignMarker = `xtest-anomaly-foreign-${randomUUID()}`;
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        name: foreignMarker,
        email: `${foreignMarker}@example.com`,
        workspacePrefix: foreignMarker,
      })
      .returning({ id: agents.id });
    if (!foreignAgent) throw new Error('foreign fixture agent was not created');
    createdForeignAgentIds.push(foreignAgent.id);
    const foreignAttempt = await suspendAnomalyPolicy(db, anomaly?.id ?? '', foreignAgent.id);
    expect(foreignAttempt.suspended).toBe(false);
    const result = await suspendAnomalyPolicy(db, anomaly?.id ?? '', agentId);
    expect(result.suspended).toBe(true);
    const [policy] = await db
      .select({ enabled: approvalPolicies.enabled })
      .from(approvalPolicies)
      .where(eq(approvalPolicies.id, policyId));
    expect(policy?.enabled).toBe(false);
    expect((await listOpenAnomalies(db, agentId)).some((a) => a.id === anomaly?.id)).toBe(false);
  });

  it('flags high frequency and dismissing it stops re-flagging', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const policyId = await makePolicy('calendar.create_event', `freq-${Date.now()}@x.com`);
    // Pin to noon UTC so off-hours never co-fires on these outward-tool calls.
    const now = new Date();
    now.setUTCHours(12, 0, 0, 0);
    // 7 auto-execs spread over ~35 min (no 5-in-10-min burst), but > the freq
    // threshold (max(5, 0, 0)) → a single frequency anomaly.
    for (let i = 0; i < 7; i++) {
      await insertAutoExec(
        policyId,
        'calendar.create_event',
        new Date(now.getTime() - i * 5 * 60_000),
      );
    }

    const scan = await runAnomalyScan({ db }, { now });
    const mine = (await listOpenAnomalies(db, agentId)).filter((a) => a.policyId === policyId);
    expect(scan.byKind.frequency).toBeGreaterThanOrEqual(1);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.kind).toBe('frequency');
    expect(mine[0]?.observed).toBe(7);

    // dismiss → re-scan same window → deduped, no new open anomaly for this policy.
    const foreignAttempt = await dismissAnomaly(
      db,
      mine[0]?.id ?? '',
      '00000000-0000-4000-8000-000000000001',
    );
    expect(foreignAttempt).toBe(false);
    expect((await listOpenAnomalies(db, agentId)).some((a) => a.id === mine[0]?.id)).toBe(true);
    await dismissAnomaly(db, mine[0]?.id ?? '', agentId);
    await runAnomalyScan({ db }, { now });
    const afterDismiss = (await listOpenAnomalies(db, agentId)).filter(
      (a) => a.policyId === policyId,
    );
    expect(afterDismiss).toHaveLength(0);
  });

  it('does not suspend a foreign approval policy linked from a stale anomaly row', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const marker = `xtest-anomaly-owner-${randomUUID()}`;
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        name: marker,
        email: `${marker}@example.com`,
        workspacePrefix: marker,
      })
      .returning({ id: agents.id });
    if (!foreignAgent) throw new Error('foreign fixture agent was not created');
    createdForeignAgentIds.push(foreignAgent.id);
    const [foreignPolicy] = await db
      .insert(approvalPolicies)
      .values({
        agentId: foreignAgent.id,
        toolName: 'gmail.send',
        templateKey: 'gmail.send.to_recipient',
        match: { recipient: `${marker}@example.com` },
        effect: 'allow',
        createdVia: 'approval_dialog',
      })
      .returning({ id: approvalPolicies.id });
    if (!foreignPolicy) throw new Error('foreign fixture policy was not created');
    createdPolicyIds.push(foreignPolicy.id);
    const [staleAnomaly] = await db
      .insert(anomalies)
      .values({
        agentId,
        kind: 'burst',
        policyId: foreignPolicy.id,
        toolName: 'gmail.send',
        observed: 5,
        expected: 2,
        windowLabel: marker,
        subjectKey: foreignPolicy.id,
      })
      .returning({ id: anomalies.id });
    if (!staleAnomaly) throw new Error('stale fixture anomaly was not created');
    createdAnomalyIds.push(staleAnomaly.id);

    expect(await suspendAnomalyPolicy(db, staleAnomaly.id, agentId)).toEqual({ suspended: false });
    const [[policy], [anomaly]] = await Promise.all([
      db
        .select({ enabled: approvalPolicies.enabled })
        .from(approvalPolicies)
        .where(eq(approvalPolicies.id, foreignPolicy.id)),
      db
        .select({ status: anomalies.status })
        .from(anomalies)
        .where(eq(anomalies.id, staleAnomaly.id)),
    ]);
    expect(policy?.enabled).toBe(true);
    expect(anomaly?.status).toBe('open');
  });
});

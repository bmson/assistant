import { randomUUID } from 'node:crypto';
import {
  agents,
  type CommitmentRow,
  commitments,
  conversations,
  createDb,
  type Db,
  maintenanceCursors,
  messages,
} from '@assistant/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import {
  correctCommitment,
  dismissCommitment,
  extractCommitments,
  listOpenCommitments,
  listRecentlyClosedCommitments,
  maintainCommitments,
  renderOpenCommitments,
  reopenCommitment,
  resolveCommitment,
  snoozeCommitment,
} from './commitments.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-commitment-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
let resolvedTitles: string[] = [];
let extractionPromptMarker = MARKER;
let extractionModelCalls = 0;
let extractedCommitments: Array<{
  kind: 'question';
  title: string;
  details: string;
  nextAction: string;
  dueAt: string;
  confidence: number;
}> = [];

const fakeRouter = {
  async object(_role: string, opts: { prompt?: string }) {
    extractionModelCalls += 1;
    const relevant = opts.prompt?.includes(extractionPromptMarker);
    const ownerMessageIds = [
      ...(opts.prompt ?? '').matchAll(/\[message_id=([0-9a-f-]{36})\] owner:/g),
    ]
      .map((match) => match[1])
      .filter((id): id is string => Boolean(id));
    const latestOwnerMessageId = ownerMessageIds.at(-1);
    return {
      ok: true,
      modelId: 'fake',
      degraded: false,
      object: {
        commitments: relevant
          ? extractedCommitments.map((item) => ({
              ...item,
              sourceMessageIds: [latestOwnerMessageId],
            }))
          : [],
        resolvedTitles: relevant ? resolvedTitles : [],
      },
    };
  },
} as unknown as ModelRouter;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Commitment Test',
        email: `${MARKER}@example.com`,
        workspacePrefix: MARKER,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('test agent was not created');
    agentId = agent.id;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: MARKER })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('test conversation was not created');
    conversationId = conversation.id;
    await db.insert(messages).values({
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [],
      text: `${MARKER}: keep tracking the travel decision until I confirm it is complete.`,
    });
    dbUp = true;
  } catch {
    console.warn('commitments.test: database unreachable — integration cases skipped');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

function row(overrides: Partial<CommitmentRow> = {}): CommitmentRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    sourceMessageId: null,
    sourceTaskId: null,
    sourceOccurrenceKey: null,
    reopenedFromId: null,
    reopenOperationId: null,
    kind: 'question',
    title: 'Confirm the travel dates',
    details: '',
    nextAction: 'Choose between Thursday and Friday',
    status: 'open',
    dueAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    resolution: null,
    confidence: '0.95',
    contentHash: 'hash',
    createdAt: new Date('2026-08-25T00:00:00Z'),
    updatedAt: new Date('2026-08-25T00:00:00Z'),
    ...overrides,
  };
}

describe('open-loop rendering', () => {
  it('renders a bounded, instruction-free continuity block', () => {
    const rendered = renderOpenCommitments([row({ dueAt: new Date('2026-08-30T00:00:00Z') })]);
    expect(rendered).toContain('Open loops from earlier owner conversations');
    expect(rendered).toContain('[question] Confirm the travel dates');
    expect(rendered).toContain('Next: Choose between Thursday and Friday');
    expect(rendered).toContain('due 2026-08-30');
    expect(rendered.length).toBeLessThanOrEqual(1400);
  });

  it('does not render an empty block', () => {
    expect(renderOpenCommitments([])).toBe('');
  });
});

describe('commitment lifecycle', () => {
  it('does not resolve a merely overlapping title, but resolves one exact title', async () => {
    if (!dbUp) return;
    const iceland = `${MARKER} Confirm travel dates for Iceland`;
    const japan = `${MARKER} Confirm travel dates for Japan`;
    await db.insert(commitments).values([
      {
        agentId,
        conversationId,
        kind: 'question',
        title: iceland,
        contentHash: `${MARKER}-iceland`,
      },
      {
        agentId,
        conversationId,
        kind: 'question',
        title: japan,
        contentHash: `${MARKER}-japan`,
      },
    ]);

    resolvedTitles = [`${MARKER} Confirm travel dates`];
    await extractCommitments({ db, router: fakeRouter }, { agentId });
    let rows = await db
      .select({ title: commitments.title, status: commitments.status })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.kind, 'question')));
    expect(rows.filter((item) => [iceland, japan].includes(item.title))).toEqual(
      expect.arrayContaining([
        { title: iceland, status: 'open' },
        { title: japan, status: 'open' },
      ]),
    );

    resolvedTitles = [iceland];
    await extractCommitments({ db, router: fakeRouter }, { agentId });
    rows = await db
      .select({ title: commitments.title, status: commitments.status })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.kind, 'question')));
    expect(rows.find((item) => item.title === iceland)?.status).toBe('resolved');
    expect(rows.find((item) => item.title === japan)?.status).toBe('open');
  });

  it('fences a closed source occurrence but permits a later owner statement', async () => {
    if (!dbUp) return;
    const title = `${MARKER} Choose the final itinerary`;
    resolvedTitles = [];
    extractedCommitments = [
      {
        kind: 'question',
        title,
        details: 'Pick one itinerary before booking.',
        nextAction: 'Choose option A or B',
        dueAt: '',
        confidence: 0.95,
      },
    ];

    await extractCommitments({ db, router: fakeRouter }, { agentId });
    const [first] = await db
      .select({ id: commitments.id })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.title, title)));
    if (!first) throw new Error('first commitment occurrence was not created');
    expect(await resolveCommitment(db, agentId, first.id, 'Completed in test')).toBe(true);

    await extractCommitments({ db, router: fakeRouter }, { agentId });
    let occurrences = await db
      .select({ status: commitments.status, sourceOccurrenceKey: commitments.sourceOccurrenceKey })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.title, title)));
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe('resolved');
    expect(occurrences[0]?.sourceOccurrenceKey).toContain(':question:');

    await db.insert(messages).values({
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [],
      text: `${MARKER}: please reopen this as a new commitment for the next trip.`,
    });
    await extractCommitments({ db, router: fakeRouter }, { agentId });
    occurrences = await db
      .select({ status: commitments.status, sourceOccurrenceKey: commitments.sourceOccurrenceKey })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.title, title)));
    expect(occurrences.map((item) => item.status).sort()).toEqual(['open', 'resolved']);
    expect(new Set(occurrences.map((item) => item.sourceOccurrenceKey)).size).toBe(2);
  });

  it('does not mutate a commitment through another agent id', async () => {
    if (!dbUp) return;
    const [target] = await db
      .select({ id: commitments.id, status: commitments.status })
      .from(commitments)
      .where(eq(commitments.agentId, agentId));
    if (!target) throw new Error('test commitment was not created');

    expect(
      await resolveCommitment(db, '00000000-0000-0000-0000-000000000000', target.id, 'nope'),
    ).toBe(false);
    const [unchanged] = await db
      .select({ status: commitments.status })
      .from(commitments)
      .where(eq(commitments.id, target.id));
    expect(unchanged?.status).toBe(target.status);
  });

  it('does not reopen or edit a closed commitment through a stale action', async () => {
    if (!dbUp) return;
    const title = `${MARKER} Closed state is immutable`;
    const [target] = await db
      .insert(commitments)
      .values({
        agentId,
        conversationId,
        kind: 'promise',
        title,
        details: 'Original details',
        contentHash: `${MARKER}-closed-state`,
      })
      .returning({ id: commitments.id });
    if (!target) throw new Error('closed-state test commitment was not created');

    expect(await resolveCommitment(db, agentId, target.id, 'Completed in test')).toBe(true);
    expect(
      await snoozeCommitment(db, agentId, target.id, new Date(Date.now() + 24 * 3600 * 1000)),
    ).toBe(false);
    expect(await dismissCommitment(db, agentId, target.id)).toBe(false);
    expect(
      await correctCommitment(db, agentId, target.id, {
        title: `${title} edited`,
        details: 'Changed details',
      }),
    ).toBe(false);

    const [unchanged] = await db
      .select({
        status: commitments.status,
        title: commitments.title,
        details: commitments.details,
      })
      .from(commitments)
      .where(eq(commitments.id, target.id));
    expect(unchanged).toEqual({ status: 'resolved', title, details: 'Original details' });
  });

  it('opens a new idempotent occurrence without changing the closed source or its replay key', async () => {
    if (!dbUp) return;
    const title = `${MARKER} Reopen keeps the source closure`;
    const sourceKey = `${MARKER}:source-occurrence`;
    const [source] = await db
      .insert(commitments)
      .values({
        agentId,
        conversationId,
        kind: 'promise',
        title,
        details: 'Original evidence',
        nextAction: 'Review it again',
        sourceOccurrenceKey: sourceKey,
        contentHash: `${MARKER}-reopen`,
      })
      .returning({ id: commitments.id });
    if (!source) throw new Error('reopen source was not created');
    expect(await resolveCommitment(db, agentId, source.id, 'Closed before reopen')).toBe(true);
    const [closed] = await db.select().from(commitments).where(eq(commitments.id, source.id));
    if (!closed) throw new Error('closed source was not found');
    const operationId = 'd2d70b66-4b46-4e9b-8cc8-6cf35e7f8bf9';

    const opened = await reopenCommitment(db, agentId, source.id, closed.updatedAt, operationId);
    expect(opened).toMatchObject({ replay: false });
    if (!opened) throw new Error('explicit reopen was rejected');
    expect(await reopenCommitment(db, agentId, source.id, closed.updatedAt, operationId)).toEqual({
      commitmentId: opened.commitmentId,
      replay: true,
    });
    expect(
      await reopenCommitment(
        db,
        '00000000-0000-0000-0000-000000000000',
        source.id,
        closed.updatedAt,
        randomUUID(),
      ),
    ).toBeNull();
    expect(
      await reopenCommitment(
        db,
        agentId,
        source.id,
        new Date(closed.updatedAt.getTime() - 1000),
        randomUUID(),
      ),
    ).toBeNull();
    expect(
      await reopenCommitment(db, agentId, source.id, closed.updatedAt, randomUUID()),
    ).toBeNull();

    const [unchanged, child] = await Promise.all([
      db
        .select()
        .from(commitments)
        .where(eq(commitments.id, source.id))
        .then((rows) => rows[0]),
      db
        .select()
        .from(commitments)
        .where(eq(commitments.id, opened.commitmentId))
        .then((rows) => rows[0]),
    ]);
    expect(unchanged).toMatchObject({
      status: 'resolved',
      resolution: 'Closed before reopen',
      sourceOccurrenceKey: sourceKey,
      reopenedFromId: null,
      reopenOperationId: null,
    });
    expect(child).toMatchObject({
      status: 'open',
      resolvedAt: null,
      sourceOccurrenceKey: `manual-reopen:v1:${agentId}:${operationId}`,
      reopenedFromId: source.id,
      reopenOperationId: operationId,
      title,
      details: 'Original evidence',
    });

    resolvedTitles = [title];
    extractedCommitments = [];
    await extractCommitments({ db, router: fakeRouter }, { agentId });
    const [afterOldResolutionReplay] = await db
      .select({ status: commitments.status })
      .from(commitments)
      .where(eq(commitments.id, opened.commitmentId));
    expect(afterOldResolutionReplay?.status).toBe('open');
    resolvedTitles = [];

    expect(await resolveCommitment(db, agentId, opened.commitmentId, 'Reclosed')).toBe(true);
    const [closedChild] = await db
      .select()
      .from(commitments)
      .where(eq(commitments.id, opened.commitmentId));
    if (!closedChild) throw new Error('reopened occurrence was not found');
    const reopenedAgain = await reopenCommitment(
      db,
      agentId,
      opened.commitmentId,
      closedChild.updatedAt,
      'fbdd199e-8dc8-407b-bdcb-c70d2e391052',
    );
    expect(reopenedAgain?.replay).toBe(false);
    const [secondChild] = await db
      .select({ reopenedFromId: commitments.reopenedFromId, status: commitments.status })
      .from(commitments)
      .where(eq(commitments.id, reopenedAgain?.commitmentId ?? ''));
    expect(secondChild).toEqual({ reopenedFromId: opened.commitmentId, status: 'open' });

    const [raceSource] = await db
      .insert(commitments)
      .values({
        agentId,
        conversationId,
        kind: 'promise',
        title: `${title} race`,
        contentHash: `${MARKER}-race`,
      })
      .returning({ id: commitments.id });
    if (!raceSource) throw new Error('race source was not created');
    expect(await resolveCommitment(db, agentId, raceSource.id, 'Closed')).toBe(true);
    const [raceClosed] = await db
      .select()
      .from(commitments)
      .where(eq(commitments.id, raceSource.id));
    if (!raceClosed) throw new Error('race source was not found after closure');
    const attempts = await Promise.all([
      reopenCommitment(db, agentId, raceSource.id, raceClosed.updatedAt, randomUUID()),
      reopenCommitment(db, agentId, raceSource.id, raceClosed.updatedAt, randomUUID()),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(
      await db
        .select({ id: commitments.id })
        .from(commitments)
        .where(
          and(eq(commitments.agentId, agentId), eq(commitments.reopenedFromId, raceSource.id)),
        ),
    ).toHaveLength(1);

    const [currentEvidence] = await db
      .insert(commitments)
      .values({
        agentId,
        conversationId,
        kind: 'promise',
        title: `${title} current`,
        contentHash: `${MARKER}-current`,
      })
      .returning({ id: commitments.id });
    if (!currentEvidence) throw new Error('current evidence fixture was not created');
    expect(await resolveCommitment(db, agentId, currentEvidence.id, 'Closed')).toBe(true);
    const [currentClosed] = await db
      .select()
      .from(commitments)
      .where(eq(commitments.id, currentEvidence.id));
    if (!currentClosed) throw new Error('current evidence was not found after closure');
    const [activeEvidence] = await db
      .insert(commitments)
      .values({
        agentId,
        conversationId,
        kind: 'promise',
        title: `${title} newly active evidence`,
        contentHash: `${MARKER}-current`,
      })
      .returning({ id: commitments.id });
    if (!activeEvidence) throw new Error('active evidence fixture was not created');
    expect(
      await reopenCommitment(
        db,
        agentId,
        currentEvidence.id,
        currentClosed.updatedAt,
        randomUUID(),
      ),
    ).toBeNull();

    const privacyMarker = `privacy-erasure-result:${agentId}`;
    await db.insert(maintenanceCursors).values({ name: privacyMarker, cursor: 'active' });
    try {
      await expect(
        reopenCommitment(db, agentId, currentEvidence.id, currentClosed.updatedAt, randomUUID()),
      ).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await db.delete(maintenanceCursors).where(eq(maintenanceCursors.name, privacyMarker));
    }
  });
});

/**
 * The sweep runs against its own agent so it cannot retire rows the lifecycle
 * cases above are still asserting on, whatever order vitest picks.
 */
describe('keeping unresolved obligations actionable', () => {
  const now = new Date('2026-09-13T12:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 3600 * 1000);
  let sweepAgentId: string;
  let sweepConversationId: string;

  beforeAll(async () => {
    if (!dbUp) return;
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Sweep Test',
        email: `${MARKER}-sweep@example.com`,
        workspacePrefix: `${MARKER}-sweep`,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('sweep test agent was not created');
    sweepAgentId = agent.id;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId: sweepAgentId, channel: 'chat', trust: 'owner', title: `${MARKER}-sweep` })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('sweep test conversation was not created');
    sweepConversationId = conversation.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    // conversations.agent_id has no cascade, so the agent cannot go first.
    await db.delete(messages).where(eq(messages.conversationId, sweepConversationId));
    await db.delete(conversations).where(eq(conversations.id, sweepConversationId));
    await db.delete(agents).where(eq(agents.id, sweepAgentId));
  });

  async function seed(
    rows: Array<{
      key: string;
      kind: string;
      idleDays: number;
      status?: string;
      snoozedUntil?: Date | null;
      dueAt?: Date | null;
    }>,
  ) {
    await db.delete(commitments).where(eq(commitments.agentId, sweepAgentId));
    for (const item of rows) {
      await db.insert(commitments).values({
        agentId: sweepAgentId,
        conversationId: sweepConversationId,
        kind: item.kind,
        title: `${MARKER} ${item.key}`,
        status: item.status ?? 'open',
        snoozedUntil: item.snoozedUntil ?? null,
        dueAt: item.dueAt ?? null,
        contentHash: `${MARKER}-${item.key}`,
        updatedAt: daysAgo(item.idleDays),
      });
    }
  }

  async function statuses(): Promise<Record<string, string>> {
    const rows = await db
      .select({ title: commitments.title, status: commitments.status })
      .from(commitments)
      .where(eq(commitments.agentId, sweepAgentId));
    return Object.fromEntries(rows.map((row) => [row.title.replace(`${MARKER} `, ''), row.status]));
  }

  it('routes the direct database path through fixture-safe owner context', async () => {
    if (!dbUp) throw new Error('fixture-safe commitment integration requires PostgreSQL');
    await seed([]);
    const [fixtureConversation] = await db
      .insert(conversations)
      .values({
        agentId: sweepAgentId,
        channel: 'chat',
        trust: 'owner',
        title: `${MARKER}-direct-fixture`,
        metadata: { visualQaRunId: randomUUID() },
      })
      .returning({ id: conversations.id });
    if (!fixtureConversation) throw new Error('fixture conversation was not created');
    const fixtureCommitmentId = randomUUID();
    try {
      await db.insert(commitments).values([
        {
          id: randomUUID(),
          agentId: sweepAgentId,
          conversationId: sweepConversationId,
          kind: 'promise',
          title: `${MARKER} ordinary source-free loop`,
          contentHash: `${MARKER}-ordinary-source-free`,
        },
        {
          id: fixtureCommitmentId,
          agentId: sweepAgentId,
          conversationId: fixtureConversation.id,
          kind: 'promise',
          title: `${MARKER} direct fixture loop`,
          contentHash: `${MARKER}-direct-fixture`,
        },
      ]);
      await expect(listOpenCommitments(db, { agentId: sweepAgentId, now })).resolves.toMatchObject([
        { title: `${MARKER} ordinary source-free loop` },
      ]);
    } finally {
      await db.delete(commitments).where(eq(commitments.agentId, sweepAgentId));
      await db.delete(conversations).where(eq(conversations.id, fixtureConversation.id));
    }
  });

  it('keeps fixture commitments out of recently closed owner controls', async () => {
    if (!dbUp) throw new Error('closed commitment integration requires PostgreSQL');
    await seed([]);
    const [fixtureConversation] = await db
      .insert(conversations)
      .values({
        agentId: sweepAgentId,
        channel: 'chat',
        trust: 'owner',
        title: `${MARKER}-closed-fixture`,
        metadata: { visualQaRunId: randomUUID() },
      })
      .returning({ id: conversations.id });
    if (!fixtureConversation) throw new Error('closed fixture conversation was not created');
    const ordinaryId = randomUUID();
    const fixtureId = randomUUID();
    const closedAt = new Date();
    try {
      await db.insert(commitments).values([
        {
          id: ordinaryId,
          agentId: sweepAgentId,
          conversationId: sweepConversationId,
          kind: 'promise',
          title: `${MARKER} ordinary closed loop`,
          status: 'resolved',
          resolvedAt: closedAt,
          contentHash: `${MARKER}-ordinary-closed`,
        },
        {
          id: fixtureId,
          agentId: sweepAgentId,
          conversationId: fixtureConversation.id,
          kind: 'promise',
          title: `${MARKER} fixture closed loop`,
          status: 'dismissed',
          resolvedAt: closedAt,
          contentHash: `${MARKER}-fixture-closed`,
        },
      ]);
      const closed = await listRecentlyClosedCommitments(db, { agentId: sweepAgentId, limit: 12 });
      expect(closed.map((row) => row.id)).toEqual([ordinaryId]);
    } finally {
      await db.delete(commitments).where(inArray(commitments.id, [ordinaryId, fixtureId]));
      await db.delete(conversations).where(eq(conversations.id, fixtureConversation.id));
    }
  });

  it('does not let an ordinary transcript resolve a direct fixture commitment by title', async () => {
    if (!dbUp) throw new Error('fixture-resolution integration requires PostgreSQL');
    const transcriptMarker = `owner-context-resolution-${randomUUID()}`;
    const fixtureTitle = `${transcriptMarker} direct fixture-only loop`;
    const ordinaryConversationRow = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: `${transcriptMarker}-ordinary`,
        metadata: {},
      })
      .returning({ id: conversations.id });
    const fixtureConversation = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: `${transcriptMarker}-fixture`,
        metadata: { visualQaRunId: randomUUID() },
      })
      .returning({ id: conversations.id });
    const ordinaryConversation = ordinaryConversationRow[0];
    const fixtureConversationRow = fixtureConversation[0];
    if (!ordinaryConversation || !fixtureConversationRow)
      throw new Error('resolution conversations were not created');
    const ordinaryMessageId = randomUUID();
    const fixtureId = randomUUID();
    const ordinaryId = randomUUID();
    try {
      await db.insert(messages).values({
        id: ordinaryMessageId,
        conversationId: ordinaryConversation.id,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: `${transcriptMarker}: I am confirming that this loop is complete after reviewing it.`,
      });
      await db.insert(commitments).values([
        {
          id: ordinaryId,
          agentId,
          conversationId: ordinaryConversation.id,
          kind: 'promise',
          title: fixtureTitle,
          status: 'open',
          contentHash: `${transcriptMarker}-ordinary-resolution`,
        },
        {
          id: fixtureId,
          agentId,
          conversationId: fixtureConversationRow.id,
          kind: 'promise',
          title: fixtureTitle,
          status: 'open',
          contentHash: `${transcriptMarker}-fixture-resolution`,
        },
      ]);
      extractedCommitments = [];
      resolvedTitles = [fixtureTitle];
      extractionPromptMarker = transcriptMarker;
      extractionModelCalls = 0;
      await extractCommitments({ db, router: fakeRouter }, { agentId });
      expect(extractionModelCalls).toBeGreaterThan(0);
      const statuses = await db
        .select({ id: commitments.id, status: commitments.status })
        .from(commitments)
        .where(inArray(commitments.id, [ordinaryId, fixtureId]));
      expect(statuses).toEqual(
        expect.arrayContaining([
          { id: ordinaryId, status: 'resolved' },
          { id: fixtureId, status: 'open' },
        ]),
      );
    } finally {
      resolvedTitles = [];
      extractionPromptMarker = MARKER;
      await db.delete(commitments).where(inArray(commitments.id, [ordinaryId, fixtureId]));
      await db.delete(messages).where(eq(messages.id, ordinaryMessageId));
      await db
        .delete(conversations)
        .where(inArray(conversations.id, [ordinaryConversation.id, fixtureConversationRow.id]));
    }
  });

  it('preserves unresolved obligations of every kind beyond every legacy idle window', async () => {
    if (!dbUp) return;
    await seed([
      { key: 'fresh-question', kind: 'question', idleDays: 10 },
      { key: 'cold-question', kind: 'question', idleDays: 31 },
      { key: 'waiting', kind: 'waiting_on', idleDays: 31 },
      { key: 'promise-inside-window', kind: 'promise', idleDays: 31 },
      { key: 'cold-promise', kind: 'promise', idleDays: 46 },
      { key: 'decision-inside-window', kind: 'decision', idleDays: 46 },
      { key: 'cold-decision', kind: 'decision', idleDays: 91 },
    ]);

    expect(await maintainCommitments(db, sweepAgentId, now)).toEqual({ woken: 0, restored: 0 });
    expect(await statuses()).toEqual({
      'fresh-question': 'open',
      'cold-question': 'open',
      waiting: 'open',
      'promise-inside-window': 'open',
      'cold-promise': 'open',
      'decision-inside-window': 'open',
      'cold-decision': 'open',
    });
  });

  it('preserves recently confirmed overdue promises and future due obligations', async () => {
    if (!dbUp) return;
    await seed([
      { key: 'just-overdue', kind: 'promise', idleDays: 1, dueAt: daysAgo(13) },
      { key: 'long-overdue', kind: 'promise', idleDays: 1, dueAt: daysAgo(15) },
      ...['promise', 'question', 'waiting_on', 'decision'].map((kind) => ({
        key: `future-${kind}`,
        kind,
        idleDays: 200,
        dueAt: new Date(now.getTime() + 180 * 24 * 3600 * 1000),
      })),
    ]);

    expect(await maintainCommitments(db, sweepAgentId, now)).toEqual({ woken: 0, restored: 0 });
    expect(await statuses()).toEqual({
      'just-overdue': 'open',
      'long-overdue': 'open',
      'future-promise': 'open',
      'future-question': 'open',
      'future-waiting_on': 'open',
      'future-decision': 'open',
    });
  });

  it('wakes a long snooze into a fresh review window and survives repeated cleanup', async () => {
    if (!dbUp) return;
    await seed([
      {
        key: 'snoozed-until-tomorrow',
        kind: 'question',
        idleDays: 60,
        status: 'snoozed',
        snoozedUntil: new Date(now.getTime() + 24 * 3600 * 1000),
      },
      {
        key: 'snooze-expired',
        kind: 'question',
        idleDays: 60,
        status: 'snoozed',
        snoozedUntil: daysAgo(2),
      },
    ]);

    const before = await listOpenCommitments(db, { agentId: sweepAgentId, now });
    expect(before.map((row) => row.title)).toEqual([`${MARKER} snooze-expired`]);
    expect(await maintainCommitments(db, sweepAgentId, now)).toEqual({ woken: 1, restored: 0 });
    expect(await statuses()).toEqual({
      'snoozed-until-tomorrow': 'snoozed',
      'snooze-expired': 'open',
    });
    const after = await listOpenCommitments(db, { agentId: sweepAgentId, now });
    expect(after.map((row) => row.title)).toEqual(before.map((row) => row.title));
    expect(after[0]?.updatedAt.getTime()).toBe(now.getTime());
    expect(after[0]?.snoozedUntil).toBeNull();
    expect(await maintainCommitments(db, sweepAgentId, now)).toEqual({ woken: 0, restored: 0 });
  });

  it('never reopens a loop the owner already closed', async () => {
    if (!dbUp) return;
    await seed([
      { key: 'resolved', kind: 'question', idleDays: 200, status: 'resolved' },
      { key: 'dismissed', kind: 'question', idleDays: 200, status: 'dismissed' },
    ]);

    expect(await maintainCommitments(db, sweepAgentId, now)).toEqual({ woken: 0, restored: 0 });
    expect(await statuses()).toEqual({ resolved: 'resolved', dismissed: 'dismissed' });
  });

  it('makes legacy stale obligations actionable before and after recovery, without reopening owner closures', async () => {
    if (!dbUp) return;
    await seed([{ key: 'legacy', kind: 'promise', idleDays: 200, status: 'stale' }]);
    const before = await listOpenCommitments(db, { agentId: sweepAgentId, now });
    expect(before).toHaveLength(1);
    expect(await maintainCommitments(db, sweepAgentId, now)).toEqual({ woken: 0, restored: 1 });
    expect(await maintainCommitments(db, sweepAgentId, now)).toEqual({ woken: 0, restored: 0 });
    const legacy = before[0];
    if (!legacy) throw new Error('Missing legacy obligation');
    expect(await resolveCommitment(db, sweepAgentId, legacy.id, 'Owner confirmed done')).toBe(true);
    expect(await maintainCommitments(db, sweepAgentId, now)).toEqual({ woken: 0, restored: 0 });
    expect(await listOpenCommitments(db, { agentId: sweepAgentId, now })).toEqual([]);
  });

  it('does not let re-extraction of the same loop reset its idle clock', async () => {
    if (!dbUp) return;
    await db.delete(commitments).where(eq(commitments.agentId, sweepAgentId));
    await db.insert(messages).values({
      conversationId: sweepConversationId,
      role: 'user',
      origin: 'owner',
      parts: [],
      text: `${MARKER}: the nightly pass keeps noticing this one.`,
    });
    const regenerated = {
      kind: 'question' as const,
      title: `${MARKER} a loop the nightly pass keeps regenerating`,
      details: '',
      nextAction: 'first reading',
      dueAt: '',
      confidence: 0.95,
    };
    extractedCommitments = [regenerated];
    resolvedTitles = [];
    await extractCommitments({ db, router: fakeRouter }, { agentId: sweepAgentId });

    const stale = daysAgo(45);
    await db
      .update(commitments)
      .set({ updatedAt: stale })
      .where(eq(commitments.agentId, sweepAgentId));

    // Same loop, newer detail: the row learns the detail, the clock does not move.
    extractedCommitments = [{ ...regenerated, nextAction: 'second reading' }];
    await extractCommitments({ db, router: fakeRouter }, { agentId: sweepAgentId });

    const [row] = await db
      .select({ nextAction: commitments.nextAction, updatedAt: commitments.updatedAt })
      .from(commitments)
      .where(eq(commitments.agentId, sweepAgentId));
    expect(row?.nextAction).toBe('second reading');
    expect(row?.updatedAt.getTime()).toBe(stale.getTime());
    expect(await maintainCommitments(db, sweepAgentId, now)).toEqual({ woken: 0, restored: 0 });

    extractedCommitments = [];
  });
});

describe('what extraction is allowed to see', () => {
  it('ignores the assistant talking to itself in a machinery thread', async () => {
    if (!dbUp) return;
    // Scheduled runs, the Notifications thread and document processing all get
    // trust 'assistant'. A schedule named daily-briefing becomes a task title
    // there, and used to come back as the owner's promise to complete it.
    const [machinery] = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'chat',
        trust: 'assistant',
        title: `${MARKER}-machinery`,
      })
      .returning({ id: conversations.id });
    if (!machinery) throw new Error('machinery conversation was not created');
    await db.insert(messages).values({
      conversationId: machinery.id,
      role: 'assistant',
      origin: 'assistant',
      parts: [],
      text: `${MARKER}: running the daily-briefing schedule and preparing the owner's morning brief.`,
    });
    extractedCommitments = [
      {
        kind: 'question',
        title: `${MARKER} Complete daily-briefing`,
        details: '',
        nextAction: '',
        dueAt: '',
        confidence: 0.95,
      },
    ];
    resolvedTitles = [];

    await extractCommitments({ db, router: fakeRouter }, { agentId });

    const rows = await db
      .select({ conversationId: commitments.conversationId })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.conversationId, machinery.id)));
    expect(rows).toEqual([]);

    extractedCommitments = [];
    await db.delete(messages).where(eq(messages.conversationId, machinery.id));
    await db.delete(conversations).where(eq(conversations.id, machinery.id));
  });
});

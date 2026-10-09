import { randomUUID } from 'node:crypto';
import {
  agents,
  createDb,
  type Db,
  maintenanceCursors,
  skills,
  tasks,
  toolCalls,
} from '@assistant/db';
import { eq, inArray, like, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { enqueueTask } from '../workflow/machine.js';
import { runSkillReflection } from './skill-reflect.js';
import {
  deleteSkill,
  listSkills,
  recallSkills,
  renderSkillsBlock,
  saveSkill,
  setSkillDeprecated,
  updateSkill,
} from './skills.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const skillEmbed = vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.02)));
const fakeRouter = {
  async embeddingSpace() {
    return { provider: 'test', model: 'skills', dimensions: 1536, revision: '1' };
  },
  embed: skillEmbed,
  async object(_role: string, opts: { prompt?: string }) {
    const worth = (opts.prompt ?? '').includes('XTEST_SKILL_GOAL');
    return {
      ok: true as const,
      modelId: 'fake',
      degraded: false,
      object: worth
        ? {
            worthSkill: true,
            name: 'xtest-reflected-skill',
            preconditions: 'when testing reflection',
            steps: 'do the xtest thing carefully',
            gotchas: '',
          }
        : { worthSkill: false, name: '', preconditions: '', steps: '', gotchas: '' },
    };
  },
} as unknown as ModelRouter;

describe('skill library', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  const createdTaskIds: string[] = [];
  const createdForeignAgentIds: string[] = [];

  async function doneTask(instruction: string, tainted: boolean): Promise<string> {
    const { task } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'assistant', payload: { instruction } },
      type: 'adhoc',
    });
    createdTaskIds.push(task.id);
    await db
      .update(tasks)
      .set({
        status: 'done',
        ...(tainted ? { state: { ...(task.state ?? {}), untrustedContext: true } } : {}),
      })
      .where(eq(tasks.id, task.id));
    for (let i = 0; i < 2; i++) {
      await db.insert(toolCalls).values({
        taskId: task.id,
        step: i,
        toolName: 'web.fetch',
        args: {},
        risk: 'autonomous',
        status: 'succeeded',
      });
    }
    return task.id;
  }

  async function cleanupSkills(): Promise<void> {
    await db
      .delete(skills)
      .where(
        or(
          like(skills.name, 'xtest%'),
          createdTaskIds.length ? inArray(skills.sourceTaskId, createdTaskIds) : undefined,
        ),
      );
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanupSkills();
    } catch {
      console.warn('skills.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) {
      await cleanupSkills();
      if (createdTaskIds.length) {
        await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
        await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
      }
      if (createdForeignAgentIds.length) {
        await db.delete(skills).where(inArray(skills.agentId, createdForeignAgentIds));
        await db.delete(agents).where(inArray(agents.id, createdForeignAgentIds));
      }
    }
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('saves, recalls, refuses tainted origin, and preserves owner authorship', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const first = await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-book-flights',
      preconditions: 'booking a flight',
      steps: 'check seat maps before paying',
      originTrust: 'assistant',
    });
    expect(first.saved).toBe(true);

    // recall finds it; render produces an advice block
    const found = await recallSkills(db, fakeRouter, agentId, 'how do I book a flight?');
    expect(found.some((s) => s.name === 'xtest-book-flights')).toBe(true);
    expect(renderSkillsBlock(found)).toContain('xtest-book-flights');

    // an untrusted origin can never write a skill
    await expect(
      saveSkill(db, fakeRouter, {
        agentId,
        name: 'xtest-evil',
        steps: 'do sketchy thing',
        originTrust: 'unknown',
      }),
    ).rejects.toThrow(/owner\/assistant/);

    // owner hand-authors the same-named skill; a later assistant revision must not clobber it
    await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-book-flights',
      steps: 'ALWAYS check seat maps and prices on two sites first',
      originTrust: 'owner',
      ownerAuthored: true,
    });
    const afterOwner = await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-book-flights',
      steps: 'assistant tries to overwrite',
      originTrust: 'assistant',
    });
    expect(afterOwner.skill?.ownerAuthored).toBe(true);
    expect(afterOwner.skill?.steps).toContain('two sites'); // owner wording kept

    // deprecated skills drop out of recall
    const [row] = await db.select().from(skills).where(eq(skills.name, 'xtest-book-flights'));
    await expect(
      updateSkill(db, fakeRouter, row?.id ?? '', '00000000-0000-4000-8000-000000000001', {
        name: 'foreign edit',
        preconditions: '',
        steps: 'foreign instruction',
        gotchas: '',
      }),
    ).rejects.toThrow('Skill not found');
    await setSkillDeprecated(db, row?.id ?? '', true, agentId);
    const afterDeprecate = await recallSkills(db, fakeRouter, agentId, 'book a flight');
    expect(afterDeprecate.some((s) => s.name === 'xtest-book-flights')).toBe(false);
    await deleteSkill(db, row?.id ?? '', agentId);
  });

  it('rejects a real foreign-owner edit before requesting an embedding', async () => {
    if (!dbUp)
      throw new Error('PostgreSQL test database is required for this owner-isolation regression');
    const marker = `xtest-foreign-skill-${randomUUID()}`;
    const [foreign] = await db
      .insert(agents)
      .values({ name: marker, email: `${marker}@example.test`, workspacePrefix: marker })
      .returning({ id: agents.id });
    if (!foreign) throw new Error('foreign fixture owner was not created');
    createdForeignAgentIds.push(foreign.id);
    const saved = await saveSkill(db, fakeRouter, {
      agentId: foreign.id,
      name: `${marker}-procedure`,
      steps: 'Foreign owner procedure',
      originTrust: 'owner',
      ownerAuthored: true,
    });
    if (!saved.skill) throw new Error('foreign fixture skill was not saved');
    const before = await db.select().from(skills).where(eq(skills.id, saved.skill.id));
    skillEmbed.mockClear();

    await expect(
      updateSkill(db, fakeRouter, saved.skill.id, agentId, {
        name: 'Overwritten procedure',
        preconditions: '',
        steps: 'foreign instruction made owner-authored',
        gotchas: '',
      }),
    ).rejects.toThrow('Skill not found');

    expect(skillEmbed).not.toHaveBeenCalled();
    expect(await db.select().from(skills).where(eq(skills.id, saved.skill.id))).toEqual(before);
  });

  it('reflection drafts a skill from an eligible task, and a tainted task cannot', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const goodTaskId = await doneTask('XTEST_SKILL_GOAL solve the hard vendor form', false);
    const r = await runSkillReflection({ db, router: fakeRouter });
    expect(r.skillsDrafted).toBeGreaterThanOrEqual(1);
    const [drafted] = await db.select().from(skills).where(eq(skills.sourceTaskId, goodTaskId));
    expect(drafted?.name).toBe('xtest-reflected-skill');
    expect(drafted?.originTrust).toBe('assistant');

    // a tainted task with the same profitable goal produces NO skill
    const taintedTaskId = await doneTask('XTEST_SKILL_GOAL do the same but tainted', true);
    await runSkillReflection({ db, router: fakeRouter });
    const fromTainted = await db
      .select()
      .from(skills)
      .where(eq(skills.sourceTaskId, taintedTaskId));
    expect(fromTainted).toHaveLength(0);
  });

  it.each(['create', 'rename', 'deprecate'] as const)(
    'does not apply a stale draft after the owner %s a same-name skill',
    async (change) => {
      if (!dbUp) return;
      const name = `xtest-stale-${change}`;
      const taskId = await doneTask(`XTSTALE_${change} solve a non-obvious workflow`, false);
      const isolatedSince = new Date(
        Date.now() + 30 * 60_000 + ['create', 'rename', 'deprecate'].indexOf(change) * 60_000,
      );
      await db.update(tasks).set({ createdAt: isolatedSince }).where(eq(tasks.id, taskId));
      let entered!: () => void;
      let release!: () => void;
      const modelEntered = new Promise<void>((resolve) => (entered = resolve));
      const blocked = new Promise<void>((resolve) => (release = resolve));
      const slowRouter = {
        ...fakeRouter,
        async object() {
          entered();
          await blocked;
          return {
            ok: true as const,
            modelId: 'fake',
            degraded: false,
            object: {
              worthSkill: true,
              name,
              preconditions: 'before doing this',
              steps: `stale ${change} draft`,
              gotchas: '',
            },
          };
        },
      } as unknown as ModelRouter;

      let existingId: string | undefined;
      if (change !== 'create') {
        await saveSkill(db, fakeRouter, {
          agentId,
          name,
          steps: 'existing assistant procedure',
          originTrust: 'assistant',
        });
        const [existing] = await db.select().from(skills).where(eq(skills.name, name));
        existingId = existing?.id;
      }

      const run = runSkillReflection({ db, router: slowRouter }, { since: isolatedSince });
      await modelEntered;
      if (change === 'create') {
        await saveSkill(db, fakeRouter, {
          agentId,
          name,
          steps: 'owner-created procedure',
          originTrust: 'owner',
          ownerAuthored: true,
        });
      } else if (change === 'rename' && existingId) {
        await updateSkill(db, fakeRouter, existingId, agentId, {
          name: `${name}-owner-renamed`,
          preconditions: '',
          steps: 'owner-renamed procedure',
          gotchas: '',
        });
      } else if (change === 'deprecate' && existingId) {
        await setSkillDeprecated(db, existingId, true, agentId);
      }
      release();
      await run;

      const after = await db.select().from(skills).where(eq(skills.agentId, agentId));
      if (change === 'create') {
        expect(after.find((row) => row.name === name)?.steps).toBe('owner-created procedure');
        expect(after.find((row) => row.name === name)?.ownerAuthored).toBe(true);
      } else if (change === 'rename') {
        expect(after.some((row) => row.name === name)).toBe(false);
        expect(after.find((row) => row.name === `${name}-owner-renamed`)?.steps).toBe(
          'owner-renamed procedure',
        );
      } else {
        expect(after.find((row) => row.name === name)?.deprecated).toBe(true);
      }
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(
        (task?.state as { skillReflectionReceipt?: { status?: string } })?.skillReflectionReceipt
          ?.status,
      ).toBe('superseded');
    },
  );

  it('keeps the original source task and checkpoints a reflected revision exactly once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const firstTaskId = await doneTask('XTSTABLE first workflow', false);
    const firstTaskDate = new Date(Date.now() + 4 * 60 * 60_000);
    await db.update(tasks).set({ createdAt: firstTaskDate }).where(eq(tasks.id, firstTaskId));
    await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-stable-revision',
      steps: 'first version',
      originTrust: 'assistant',
      sourceTaskId: firstTaskId,
    });
    const secondTaskId = await doneTask('XTSTABLE second workflow', false);
    const secondTaskDate = new Date(firstTaskDate.getTime() + 60_000);
    await db.update(tasks).set({ createdAt: secondTaskDate }).where(eq(tasks.id, secondTaskId));
    let objectCalls = 0;
    const router = {
      ...fakeRouter,
      async object() {
        objectCalls += 1;
        return {
          ok: true as const,
          modelId: 'fake',
          degraded: false,
          object: {
            worthSkill: true,
            name: 'xtest-stable-revision',
            preconditions: '',
            steps: 'revised reusable procedure',
            gotchas: '',
          },
        };
      },
    } as unknown as ModelRouter;
    const since = secondTaskDate;
    await runSkillReflection({ db, router }, { since });
    const [revised] = await db
      .select()
      .from(skills)
      .where(eq(skills.name, 'xtest-stable-revision'));
    expect(revised?.steps).toBe('revised reusable procedure');
    expect(revised?.sourceTaskId).toBe(firstTaskId);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, secondTaskId));
    expect(
      (task?.state as { skillReflectionReceipt?: unknown })?.skillReflectionReceipt,
    ).toBeTruthy();
    const beforeRetry = objectCalls;
    await runSkillReflection({ db, router }, { since: new Date(Date.now() - 10_000) });
    expect(objectCalls).toBe(beforeRetry);
  });

  it('does not publish a draft observed before a completed privacy erasure', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const taskId = await doneTask('XTPRIVACY stale private procedure', false);
    const since = new Date(Date.now() + 8 * 60 * 60_000);
    await db.update(tasks).set({ createdAt: since }).where(eq(tasks.id, taskId));
    let entered!: () => void;
    let release!: () => void;
    const modelEntered = new Promise<void>((resolve) => (entered = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const slowRouter = {
      ...fakeRouter,
      async object() {
        entered();
        await blocked;
        return {
          ok: true as const,
          modelId: 'fake',
          degraded: false,
          object: {
            worthSkill: true,
            name: 'xtest-erased-draft',
            preconditions: '',
            steps: 'must not be published',
            gotchas: '',
          },
        };
      },
    } as unknown as ModelRouter;
    const run = runSkillReflection({ db, router: slowRouter }, { since });
    await modelEntered;
    await db
      .insert(maintenanceCursors)
      .values({
        name: `privacy-erasure-generation:${agentId}`,
        cursor: `test-${randomUUID()}`,
      })
      .onConflictDoUpdate({
        target: maintenanceCursors.name,
        set: { cursor: `test-${randomUUID()}`, updatedAt: new Date() },
      });
    release();
    await run;
    expect(
      await db.select().from(skills).where(eq(skills.name, 'xtest-erased-draft')),
    ).toHaveLength(0);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(
      (task?.state as { skillReflectionReceipt?: unknown })?.skillReflectionReceipt,
    ).toBeUndefined();
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));
  });

  it('listSkills returns owner-authored first', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-learned',
      steps: 'a',
      originTrust: 'assistant',
    });
    await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-mine',
      steps: 'b',
      originTrust: 'owner',
      ownerAuthored: true,
    });
    const list = (await listSkills(db, agentId)).filter((s) => s.name.startsWith('xtest-'));
    expect(list[0]?.ownerAuthored).toBe(true);
  });
});

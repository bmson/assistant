import { createDb, type Db, importSources, tasks, writingSamples } from '@assistant/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { loadConfig } from '../config.js';
import type { ModelRouter } from '../model-router/router.js';
import type { DispatcherPort } from '../workflow/executor.js';
import { executeTask } from '../workflow/executor.js';
import type { WorkspaceReader } from './import.js';
import {
  extractOwnerSamples,
  isVoiceImportSource,
  ownerAuthoredMatcher,
  purgeVoiceSamples,
  registerForFilename,
  startVoiceIngest,
  UPLOAD_SAMPLE_PREFIX,
  voiceImportSourceTag,
  voiceSampleStats,
} from './voice-ingest.js';

// ── Pure logic: owner-authored filtering, quote/forward skipping ──────────────

describe('registerForFilename', () => {
  it('maps a file-name prefix to a register, defaulting to casual email', () => {
    expect(registerForFilename('sms-mom.txt')).toBe('sms');
    expect(registerForFilename('chat-log.md')).toBe('chat');
    expect(registerForFilename('email-pro-clients.txt')).toBe('email_professional');
    expect(registerForFilename('professional-notes.txt')).toBe('email_professional');
    expect(registerForFilename('Sent.mbox')).toBe('email_casual');
  });
});

describe('voiceImportSourceTag / isVoiceImportSource', () => {
  it('normalises a label into a voice-prefixed source tag without doubling', () => {
    expect(voiceImportSourceTag('Sent Mail 2024')).toBe('voice-samples-sent-mail-2024');
    expect(voiceImportSourceTag('')).toBe('voice-samples');
    expect(voiceImportSourceTag('voice-samples-sent')).toBe('voice-samples-sent');
  });
  it('recognises voice import sources', () => {
    expect(isVoiceImportSource('voice-samples-sent')).toBe(true);
    expect(isVoiceImportSource('takeout-mail-2021')).toBe(false);
  });
});

describe('ownerAuthoredMatcher', () => {
  const isOwner = ownerAuthoredMatcher({ emails: ['bmson@bmson.com'] });
  it('matches the exact RFC mailbox identity, independent of display name', () => {
    expect(isOwner('Baldvin <bmson@bmson.com>')).toBe(true);
    expect(isOwner('"Baldvin <bmson@bmson.com>" <attacker@other.com>')).toBe(false);
    expect(isOwner('Baldvin <b@other.com>')).toBe(false);
  });
  it('does not match a third party who merely mentions the owner in a display name', () => {
    expect(isOwner('Alice <alice@example.com>')).toBe(false);
    expect(isOwner('Baldvin <team@corp.com>')).toBe(false);
  });
});

const OWNER_MATCHER = ownerAuthoredMatcher({ emails: ['bmson@bmson.com'] });

const MBOX = [
  'From bmson@bmson.com Fri Jul 04 12:00:00 2026',
  'From: Baldvin <bmson@bmson.com>',
  'Date: Fri, 04 Jul 2026 12:00:00 +0000',
  'Subject: lunch plans',
  '',
  'Hey — lunch on Friday at noon works great, see you at Loki. Bring the signed contract please.',
  '',
  'From alice@example.com Sat Jul 05 09:00:00 2026',
  'From: Alice <alice@example.com>',
  'Date: Sat, 05 Jul 2026 09:00:00 +0000',
  'Subject: quick question',
  '',
  'Hi Baldvin, are you free next week for a short call to go over the quarterly numbers together?',
  '',
  'From bmson@bmson.com Sun Jul 06 08:00:00 2026',
  'From: Baldvin <bmson@bmson.com>',
  'Date: Sun, 06 Jul 2026 08:00:00 +0000',
  'Subject: interesting article',
  '',
  '---------- Forwarded message ---------',
  'From: News <news@promo.example>',
  'Date: Sat, 05 Jul 2026 07:00:00 +0000',
  'Subject: Weekend sale',
  'To: Baldvin <bmson@bmson.com>',
  '',
  'Big sale this weekend, act now on these deals before they expire on Sunday night for sure.',
  '',
  'From bmson@bmson.com Mon Jul 07 20:00:00 2026',
  'From: Baldvin <bmson@bmson.com>',
  'Date: Mon, 07 Jul 2026 20:00:00 +0000',
  'Subject: Re: dinner',
  '',
  "Sounds perfect — I'll book the table for 8pm on Saturday for the four of us then.",
  '',
  'On Mon, Jul 7, 2026 at 10:00 Alice <alice@example.com> wrote:',
  '> where should we all go for dinner this coming weekend after work?',
  '',
].join('\n');

describe('extractOwnerSamples', () => {
  it('keeps only the owner mailbox-authored, non-quoting messages from an mbox', async () => {
    const samples = (
      await extractOwnerSamples('mbox', MBOX, OWNER_MATCHER, { ownerConfirmedArchive: true })
    ).samples;
    expect(samples).toEqual([
      'Hey — lunch on Friday at noon works great, see you at Loki. Bring the signed contract please.',
      "Sounds perfect — I'll book the table for 8pm on Saturday for the four of us then.",
    ]);
  });

  it('drops received mail and keeps only the owner mailbox side of a JSON chat export', async () => {
    const json = JSON.stringify([
      {
        from: 'Baldvin <bmson@bmson.com>',
        text: 'Running five minutes late — grab us a table near the window please.',
      },
      {
        from: 'Alice <alice@example.com>',
        text: 'No worries at all, I already grabbed the corner booth by the window.',
      },
      {
        from: 'Baldvin <bmson@bmson.com>',
        text: "On second thought, let's just meet at the office lobby at nine tomorrow.",
      },
    ]);
    const samples = (
      await extractOwnerSamples('json', json, OWNER_MATCHER, { ownerConfirmedArchive: true })
    ).samples;
    expect(samples).toEqual([
      'Running five minutes late — grab us a table near the window please.',
      "On second thought, let's just meet at the office lobby at nine tomorrow.",
    ]);
  });

  it('accepts raw text only in explicit owner-confirmed mode and skips quoted blocks', async () => {
    const clean =
      'I think we should ship the beta this week and gather feedback from the first cohort.';
    expect((await extractOwnerSamples('text', clean, OWNER_MATCHER)).samples).toEqual([]);
    expect(
      (await extractOwnerSamples('text', clean, OWNER_MATCHER, { ownerConfirmedRawText: true }))
        .samples,
    ).toEqual([clean]);

    const quoted =
      'My reply about the schedule here.\n\n> someone quoted this whole line in the middle.';
    expect(
      (await extractOwnerSamples('text', quoted, OWNER_MATCHER, { ownerConfirmedRawText: true }))
        .samples,
    ).toEqual([]);
  });

  it('dedupes identical messages within one archive', async () => {
    const dupes = JSON.stringify([
      {
        from: 'Baldvin <bmson@bmson.com>',
        text: 'Thanks so much for handling that for me today, I really appreciate it.',
      },
      {
        from: 'Baldvin <bmson@bmson.com>',
        text: 'Thanks so much for handling that for me today, I really appreciate it.',
      },
    ]);
    expect(
      (await extractOwnerSamples('json', dupes, OWNER_MATCHER, { ownerConfirmedArchive: true }))
        .samples,
    ).toHaveLength(1);
  });

  it('rejects same-name third-party mailbox and nested HTML quote content', async () => {
    const mailbox = JSON.stringify([
      {
        from: 'Baldvin Person <attacker@example.com>',
        text: 'This message is long enough to look like the owner wrote this sentence.',
      },
    ]);
    expect(
      (await extractOwnerSamples('json', mailbox, OWNER_MATCHER, { ownerConfirmedArchive: true }))
        .samples,
    ).toEqual([]);
    const nested = [
      'From owner@example.com Tue Jan 02 10:00:00 2024',
      'From: Owner <bmson@bmson.com>',
      'Date: Tue, 02 Jan 2024 10:00:00 +0000',
      'Subject: reply',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>New owner-authored words should be retained without the quoted material.</p><blockquote><p>Third-party material</p><blockquote>Nested forwarded words.</blockquote></blockquote>',
      '',
    ].join('\r\n');
    expect(
      (await extractOwnerSamples('mbox', nested, OWNER_MATCHER, { ownerConfirmedArchive: true }))
        .samples,
    ).toEqual(['New owner-authored words should be retained without the quoted material.']);
  });
});

// ── Job execution (integration) ──────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('voice ingest job (integration)', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  const label = 'xtest-voice-ingest';
  const source = voiceImportSourceTag(label);
  const uploadContext = `${UPLOAD_SAMPLE_PREFIX}${source}`;
  const seedContext = 'xtest-voice-seedfile.txt';
  const createdTaskIds: string[] = [];

  const fakeRouter = {
    async embeddingSpace() {
      return {
        provider: 'synthetic',
        model: 'voice-ingest-fixture',
        dimensions: 1536,
        revision: '1',
      };
    },
    async embed(texts: string[]) {
      return texts.map(() => new Array(1536).fill(0.01));
    },
  } as unknown as ModelRouter;

  const fakeWorkspace: WorkspaceReader = {
    async read(relPath: string) {
      if (relPath === 'import/uploads/voice.mbox') {
        return MBOX.replaceAll('bmson@bmson.com', loadConfig().OWNER_EMAIL);
      }
      throw new Error(`no such file: ${relPath}`);
    },
    async write() {
      return undefined;
    },
    async list() {
      return [];
    },
  };

  const noopDispatcher: DispatcherPort = {
    toolDefs: () => {
      throw new Error('voice ingest must not build tools');
    },
    resultIsUntrusted: () => false,
    dispatch: async () => {
      throw new Error('voice ingest must not dispatch tools');
    },
    executeApproved: async () => {
      throw new Error('voice ingest must not execute approvals');
    },
  };

  async function cleanup() {
    await db
      .delete(writingSamples)
      .where(inArray(writingSamples.context, [uploadContext, seedContext, 'auto:xtest-voice']));
    await db.delete(importSources).where(eq(importSources.source, source));
    if (createdTaskIds.length) await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
    } catch {
      console.warn('voice-ingest.test: database unreachable — skipping integration');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('ingests the owner’s own mail as writing samples and dedupes on re-run', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const deps = { db, router: fakeRouter, dispatcher: noopDispatcher, workspace: fakeWorkspace };

    const { taskId } = await startVoiceIngest(db, {
      agentId,
      source: label,
      workspacePath: 'import/uploads/voice.mbox',
      kind: 'mbox',
      register: 'email_casual',
    });
    createdTaskIds.push(taskId);

    const run = await executeTask(deps, taskId);
    expect(run.outcome).toBe('done');

    const samples = await db
      .select()
      .from(writingSamples)
      .where(eq(writingSamples.context, uploadContext));
    expect(samples.map((s) => s.text).sort()).toEqual(
      [
        'Hey — lunch on Friday at noon works great, see you at Loki. Bring the signed contract please.',
        "Sounds perfect — I'll book the table for 8pm on Saturday for the four of us then.",
      ].sort(),
    );
    expect(samples.every((s) => s.register === 'email_casual')).toBe(true);
    expect(samples.every((s) => s.embedding?.length === 1536)).toBe(true);

    const [src] = await db.select().from(importSources).where(eq(importSources.source, source));
    expect(src?.status).toBe('done');
    expect(src?.memoriesSaved).toBe(2);
    expect(src?.itemsTotal).toBe(2);

    // Re-run the same upload: dedupe-by-text means nothing new is inserted.
    const rerun = await startVoiceIngest(db, {
      agentId,
      source: label,
      workspacePath: 'import/uploads/voice.mbox',
      kind: 'mbox',
      register: 'email_casual',
    });
    createdTaskIds.push(rerun.taskId);
    expect((await executeTask(deps, rerun.taskId)).outcome).toBe('done');
    const afterRerun = await db
      .select()
      .from(writingSamples)
      .where(eq(writingSamples.context, uploadContext));
    expect(afterRerun).toHaveLength(2);
  });

  it('counts and purges auto + uploaded samples, sparing seed-script samples', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Seed one auto and one seed-file sample alongside the two uploaded ones.
    const [embedding] = (await fakeRouter.embed(['x'])) as number[][];
    await db.insert(writingSamples).values([
      {
        register: 'sms',
        text: 'xtest auto sample kept short but over the minimum length ok',
        context: 'auto:xtest-voice',
        embedding,
      },
      {
        register: 'chat',
        text: 'xtest seed-file sample that must survive a voice purge entirely',
        context: seedContext,
        embedding,
      },
    ]);

    const stats = await voiceSampleStats(db);
    expect(stats.uploaded).toBeGreaterThanOrEqual(2);
    expect(stats.auto).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBeGreaterThanOrEqual(stats.uploaded + stats.auto);

    await purgeVoiceSamples(db);

    // Uploaded + auto gone; seed-file sample survives; import husk removed.
    expect(
      await db
        .select()
        .from(writingSamples)
        .where(like(writingSamples.context, `${UPLOAD_SAMPLE_PREFIX}%`)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(writingSamples)
        .where(and(eq(writingSamples.context, seedContext))),
    ).toHaveLength(1);
    expect(
      await db.select().from(importSources).where(eq(importSources.source, source)),
    ).toHaveLength(0);
  });
});

import { createDb, type Db } from '@assistant/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../chat.js';
import { runGoldenTask } from './golden/harness.js';

let db: Db;
let agentId: string;
beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL ?? '');
  agentId = (await getAgent(db)).id;
});
afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('new artifact request action boundaries in the real executor', () => {
  it('creates and reads back the new document without re-asking its supplied title or heading', async () => {
    const request =
      'Create a new private Google Doc titled "QA — Assistant briefing test — 2026-10-13". This is a fictional test document, not my personal information. Include a heading "Project Aurora", exactly three bullets (Budget €240; Deadline Friday; No taxi travel), and a two-column table with Task and Owner, containing Research/Alex and Review/Sam. Keep it under 150 words. Read the document back to verify those details, then give me the document link and a short confirmation. Do not send messages, share it with anyone except me, or edit any existing file.';
    const title = 'QA — Assistant briefing test — 2026-10-13';
    const content =
      '# Project Aurora\n\n- Budget €240\n- Deadline Friday\n- No taxi travel\n\n| Task | Owner |\n|---|---|\n| Research | Alex |\n| Review | Sam |';
    const url = 'https://docs.google.com/document/d/DocumentQA12345/edit';
    const result = await runGoldenTask(db, agentId, {
      name: 'qa-new-doc-with-no-existing-edit',
      event: { source: 'chat', trust: 'owner', payload: { text: request } },
      taskType: 'adhoc',
      script: [
        { toolCalls: [{ toolName: 'docs.create', input: { title, content } }] },
        { toolCalls: [{ toolName: 'docs.get', input: { documentId: 'DocumentQA12345' } }] },
        {
          text: `Created the document and read it back to check the heading, three bullets, and Task/Owner table. [Open document](${url})`,
        },
      ],
      tools: {
        'docs.create': {
          schema: z.object({ title: z.string(), content: z.string() }),
          execute: async (args) => {
            expect(args).toEqual({ title, content });
            return { documentId: 'DocumentQA12345', url, title };
          },
        },
        'docs.get': {
          schema: z.object({ documentId: z.string() }),
          execute: async (args) => {
            expect(args).toEqual({ documentId: 'DocumentQA12345' });
            return { documentId: 'DocumentQA12345', title, content, url };
          },
        },
      },
    });
    expect(result.toolNames).toEqual(['docs.create', 'docs.get']);
    expect(result.objectRoles).not.toContain('plan');
    expect(result.finalText).toContain(url);
    expect(result.finalText).not.toContain('What title');
    expect(result.status).toBe('done');
  });
});

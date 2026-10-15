import { createDb, type Db } from '@assistant/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
    const structure = {
      complete: true,
      headings: [{ text: 'Project Aurora', style: 'HEADING_1' }],
      bullets: ['Budget €240', 'Deadline Friday', 'No taxi travel'],
      tables: [
        {
          rows: [
            ['Task', 'Owner'],
            ['Research', 'Alex'],
            ['Review', 'Sam'],
          ],
        },
      ],
    };
    const url = 'https://docs.google.com/document/d/DocumentQA12345/edit';
    const result = await runGoldenTask(db, agentId, {
      name: 'qa-new-doc-with-no-existing-edit',
      event: { source: 'chat', trust: 'owner', payload: { text: request } },
      taskType: 'adhoc',
      script: [
        { toolCalls: [{ toolName: 'docs.create', input: { title, content } }] },
        {
          text: `Created the document and read it back to check the heading, three bullets, and Task/Owner table. [Open document](${url})`,
        },
      ],
      tools: {
        'docs.create': {
          schema: z.object({ title: z.string(), content: z.string() }),
          execute: async (args) => {
            expect(args).toEqual({ title, content });
            return { documentId: 'DocumentQA12345', url, title, contentStructure: structure };
          },
        },
        'docs.get': {
          schema: z.object({
            documentId: z.string(),
            startOffset: z.number(),
            maxChars: z.number(),
          }),
          execute: async (args) => {
            expect(args).toEqual({
              documentId: 'DocumentQA12345',
              startOffset: 0,
              maxChars: 50_000,
            });
            return {
              documentId: 'DocumentQA12345',
              title,
              text: content,
              url,
              complete: true,
              structure,
            };
          },
        },
      },
    });
    expect(result.toolNames).toEqual(['docs.create', 'docs.get']);
    expect(result.objectRoles).not.toContain('plan');
    expect(result.finalText).toContain(url);
    expect(result.finalText).not.toContain('What title');
    expect(result.finalText).toContain('3 native bullets');
    expect(result.finalText).toContain('native table with 2 data rows');
    expect(result.status).toBe('done');
  });

  it('reports an exact existing private title and never invokes create', async () => {
    const title = 'Conditional duplicate QA';
    const request = `Create a private Google Doc titled "${title}". If the exact title already exists, verify and report it instead of duplicating. Make it accessible only to me.`;
    const create = vi.fn(async () => {
      throw new Error('create must be blocked when the exact title exists');
    });
    const search = vi.fn(async (input: unknown) => {
      expect(input).toEqual({
        query: title,
        exactTitle: title,
        verifyOwnerOnly: true,
        maxResults: 20,
      });
      return {
        lookupMode: 'exact-title',
        exactTitle: title,
        coverage: 'complete',
        files: [
          {
            fileId: 'ExistingDocId12345',
            name: title,
            mimeType: 'application/vnd.google-apps.document',
            url: 'https://docs.google.com/document/d/ExistingDocId12345/edit',
          },
        ],
        sharingVerification: 'verified_owner_only',
      };
    });
    const result = await runGoldenTask(db, agentId, {
      name: 'conditional-doc-duplicate-stops-before-write',
      event: { source: 'chat', trust: 'owner', payload: { text: request } },
      taskType: 'adhoc',
      script: [{ text: 'The runtime must stop before this model response.' }],
      tools: {
        'drive.search': {
          schema: z.object({
            query: z.string(),
            exactTitle: z.string().optional(),
            verifyOwnerOnly: z.boolean().optional(),
            maxResults: z.number().optional(),
          }),
          execute: search,
        },
        'docs.create': {
          schema: z.object({ title: z.string(), content: z.string() }),
          execute: create,
        },
      },
    });
    expect(result.toolNames).toEqual(['drive.search']);
    expect(search).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(result.finalText).toContain('did not create a duplicate');
    expect(result.finalText).toContain('drive.google.com/open?id=ExistingDocId12345');
  });

  it('creates only after complete exact-title absence evidence', async () => {
    const title = 'Conditional new QA';
    const request = `Create a Google Doc titled "${title}" if the exact title already exists, report it instead of creating a duplicate.`;
    const sequence: string[] = [];
    const content = '# Status\n\n- Ready';
    const structure = {
      complete: true,
      headings: [{ text: 'Status', style: 'HEADING_1' }],
      bullets: ['Ready'],
      tables: [],
    };
    const result = await runGoldenTask(db, agentId, {
      name: 'conditional-doc-creates-after-complete-absence',
      event: { source: 'chat', trust: 'owner', payload: { text: request } },
      taskType: 'adhoc',
      script: [
        { toolCalls: [{ toolName: 'docs.create', input: { title, content } }] },
        { text: 'Created the requested document and read it back.' },
      ],
      tools: {
        'drive.search': {
          schema: z.object({
            query: z.string(),
            exactTitle: z.string().optional(),
            verifyOwnerOnly: z.boolean().optional(),
            maxResults: z.number().optional(),
          }),
          execute: async (args) => {
            sequence.push('drive.search');
            expect(args).toEqual({
              query: title,
              exactTitle: title,
              verifyOwnerOnly: false,
              maxResults: 20,
            });
            return {
              lookupMode: 'exact-title',
              exactTitle: title,
              coverage: 'complete',
              files: [],
            };
          },
        },
        'docs.create': {
          schema: z.object({ title: z.string(), content: z.string() }),
          execute: async (args) => {
            sequence.push('docs.create');
            expect(args).toEqual({ title, content });
            return {
              documentId: 'CreatedDocId12345',
              title,
              url: 'https://docs.google.com/document/d/CreatedDocId12345/edit',
              sharingVerification: 'verified_owner_only',
              contentStructure: structure,
            };
          },
        },
        'docs.get': {
          schema: z.object({
            documentId: z.string(),
            startOffset: z.number(),
            maxChars: z.number(),
          }),
          execute: async () => {
            sequence.push('docs.get');
            return {
              documentId: 'CreatedDocId12345',
              title,
              text: content,
              url: 'https://docs.google.com/document/d/CreatedDocId12345/edit',
              complete: true,
              structure,
            };
          },
        },
      },
    });
    expect(sequence).toEqual(['drive.search', 'docs.create', 'docs.get']);
    expect(result.toolNames).toEqual(['drive.search', 'docs.create', 'docs.get']);
    expect(result.status).toBe('done');
  });

  it('does not create if the exact-title search fails', async () => {
    const title = 'Conditional blocked QA';
    const request = `Create a Google Doc titled "${title}" if the exact title already exists, report it instead of creating a duplicate.`;
    const create = vi.fn();
    const result = await runGoldenTask(db, agentId, {
      name: 'conditional-doc-failed-search-stops-before-write',
      event: { source: 'chat', trust: 'owner', payload: { text: request } },
      taskType: 'adhoc',
      script: [{ text: 'The runtime must not create after a failed search.' }],
      tools: {
        'drive.search': {
          schema: z.object({
            query: z.string(),
            exactTitle: z.string().optional(),
            verifyOwnerOnly: z.boolean().optional(),
            maxResults: z.number().optional(),
          }),
          execute: async () => {
            throw new Error('Drive unavailable');
          },
        },
        'docs.create': {
          schema: z.object({ title: z.string(), content: z.string() }),
          execute: create,
        },
      },
    });
    expect(result.toolNames).toEqual(['drive.search']);
    expect(create).not.toHaveBeenCalled();
    expect(result.status).toBe('needs_attention');
    expect(result.finalText).toContain('did not complete successfully');
  });

  it('rejects a model title that differs from the exact title checked in Drive', async () => {
    const title = 'Conditional exact title QA';
    const create = vi.fn();
    const result = await runGoldenTask(db, agentId, {
      name: 'conditional-doc-title-must-match-preflight',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: {
          text: `Create a Google Doc titled "${title}" if the exact title already exists, report it instead of creating a duplicate.`,
        },
      },
      taskType: 'adhoc',
      script: [
        {
          toolCalls: [
            { toolName: 'docs.create', input: { title: 'Different title', content: 'text' } },
          ],
        },
      ],
      tools: {
        'drive.search': {
          schema: z.object({
            query: z.string(),
            exactTitle: z.string().optional(),
            verifyOwnerOnly: z.boolean().optional(),
            maxResults: z.number().optional(),
          }),
          execute: async () => ({
            lookupMode: 'exact-title',
            exactTitle: title,
            coverage: 'complete',
            files: [],
          }),
        },
        'docs.create': {
          schema: z.object({ title: z.string(), content: z.string() }),
          execute: create,
        },
      },
    });
    expect(result.toolNames).toEqual(['drive.search']);
    expect(create).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.finalText).toContain('requested exact title was not used');
  });
});

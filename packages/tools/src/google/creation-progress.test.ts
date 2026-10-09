import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import type { GoogleClient } from './client.js';
import { registerDocsTools } from './docs.js';
import { PartialGoogleArtifactError } from './effect-progress.js';
import { registerGmailTools } from './gmail.js';
import { registerSheetsTools } from './sheets.js';
import { registerSlidesTools } from './slides.js';

function registry(api: ReturnType<typeof vi.fn>) {
  const tools = new ToolRegistry();
  const deps = {
    client: { api } as unknown as GoogleClient,
    botEmail: 'assistant@example.com',
    ownerEmail: 'owner@example.com',
  };
  registerDocsTools(tools, deps);
  registerSheetsTools(tools, deps);
  registerSlidesTools(tools, deps);
  registerGmailTools(tools, deps);
  return tools;
}
const creations = [
  {
    name: 'docs.create',
    args: { title: 'Same title', content: 'Exact approved body' },
    created: { documentId: 'DOC-one' },
  },
  {
    name: 'sheets.create',
    args: { title: 'Same title', sheetName: 'Sheet1', rows: [['Exact']] },
    created: { spreadsheetId: 'SHEET-one' },
  },
  {
    name: 'slides.create',
    args: { title: 'Same title', slides: [{ title: 'One', body: 'Exact' }] },
    created: { presentationId: 'SLIDES-one' },
  },
];
const context = { agentId: 'owner', taskId: 'task', operationId: 'call-1' } as ToolContext;
describe('creation operation and partial completion receipts', () => {
  it.each([
    ...creations,
    { name: 'gmail.send', args: { to: ['owner@example.com'], subject: 'Same title', body: 'one' } },
    {
      name: 'gmail.create_draft',
      args: { to: ['owner@example.com'], subject: 'Same title', body: 'one' },
    },
  ])(
    'uses durable operation identity for $name rather than display/content equality',
    ({ name, args }) => {
      const tool = registry(vi.fn()).get(name)?.tool;
      const parsed = tool?.inputSchema.parse(args) as Record<string, unknown>;
      const first = tool?.idempotencyKey?.(parsed, context);
      expect(first).toContain(':operation:');
      expect(
        tool?.idempotencyKey?.(
          {
            ...parsed,
            title: 'Changed draft',
            subject: 'Other',
            body: 'Rewritten',
            content: 'Different',
          },
          context,
        ),
      ).toBe(first);
      expect(tool?.idempotencyKey?.(parsed, { ...context, operationId: 'call-2' })).not.toBe(first);
      expect(tool?.idempotencyKey?.(parsed, { ...context, agentId: 'foreign' })).not.toBe(first);
    },
  );
  it.each(creations)(
    'retains the created object on a later share rejection for $name',
    async ({ name, args, created }) => {
      const api = vi
        .fn()
        .mockResolvedValueOnce(created)
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('share rejected'));
      const tool = registry(api).get(name)?.tool;
      const stages: unknown[] = [];
      const ctx = {
        ...context,
        checkpointExternalEffect: async (progress: unknown) => {
          stages.push(progress);
        },
      } as ToolContext;
      const error = await tool
        ?.execute(tool.inputSchema.parse(args), ctx)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(PartialGoogleArtifactError);
      expect((error as PartialGoogleArtifactError).progress.stage).toBe('filled');
      expect((error as PartialGoogleArtifactError).progress.objectId).toBe(
        Object.values(created)[0],
      );
      expect(stages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: 'created' }),
          expect.objectContaining({ stage: 'filled' }),
        ]),
      );
      expect(api).toHaveBeenCalledTimes(3);
    },
  );
  it.each(creations)(
    'stops after creation when its durable receipt cannot be saved for $name',
    async ({ name, args, created }) => {
      const api = vi.fn().mockResolvedValue(created);
      const tool = registry(api).get(name)?.tool;
      const ctx = {
        ...context,
        checkpointExternalEffect: async () => {
          throw new Error('lost persistence');
        },
      } as ToolContext;
      const error = await tool
        ?.execute(tool.inputSchema.parse(args), ctx)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(PartialGoogleArtifactError);
      expect((error as PartialGoogleArtifactError).progress.stage).toBe('created');
      expect(api).toHaveBeenCalledOnce();
    },
  );
});

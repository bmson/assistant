import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { GoogleClient } from './client.js';
import { buildSlideRequests, registerSlidesTools } from './slides.js';

const DEPS = { ownerEmail: 'owner@example.com' };

function toolsWith(api: ReturnType<typeof vi.fn>) {
  const registry = new ToolRegistry();
  registerSlidesTools(registry, { client: { api } as unknown as GoogleClient, ...DEPS });
  return registry;
}

describe('Google Slides tools', () => {
  it('builds a readable title/body slide and removes the blank default slide', () => {
    const requests = buildSlideRequests([{ title: 'Plan', body: 'First\nSecond' }], {
      deleteSlideId: 'default-slide',
    });
    expect(requests[0]).toEqual({ deleteObject: { objectId: 'default-slide' } });
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ createSlide: expect.any(Object) }),
        expect.objectContaining({ createShape: expect.any(Object) }),
        expect.objectContaining({ insertText: expect.objectContaining({ text: 'Plan' }) }),
        expect.objectContaining({ insertText: expect.objectContaining({ text: 'First\nSecond' }) }),
      ]),
    );
  });

  it('inserts created slides in order but leaves append position to the provider', () => {
    const created = buildSlideRequests(
      [
        { title: 'One', body: '' },
        { title: 'Two', body: '' },
      ],
      { deleteSlideId: 'default-slide', insertionIndex: 0 },
    ).filter((request) => 'createSlide' in request);
    expect(
      created.map((request) => (request.createSlide as { insertionIndex: number }).insertionIndex),
    ).toEqual([0, 1]);

    const appended = buildSlideRequests([
      { title: 'Three', body: '' },
      { title: 'Four', body: '' },
    ]).filter((request) => 'createSlide' in request);
    expect(appended).toHaveLength(2);
    expect(
      appended.every((request) => !('insertionIndex' in (request.createSlide as object))),
    ).toBe(true);
  });

  it('creates, fills, and shares a presentation', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        presentationId: 'SLIDES-123_abc',
        title: 'Briefing',
        slides: [{ objectId: 'default-slide' }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const tool = toolsWith(api).get('slides.create')?.tool;
    const result = (await tool?.execute(
      { title: 'Briefing', slides: [{ title: 'Summary', body: 'Three points' }] },
      {} as never,
    )) as { presentationId: string; url: string; sharedWith: string; slideCount: number };

    expect(result).toEqual({
      presentationId: 'SLIDES-123_abc',
      title: 'Briefing',
      url: 'https://docs.google.com/presentation/d/SLIDES-123_abc/edit',
      slideCount: 1,
      sharedWith: 'owner@example.com',
    });
    expect(api.mock.calls[1]?.[0]).toBe(
      'https://slides.googleapis.com/v1/presentations/SLIDES-123_abc:batchUpdate',
    );
  });

  it('offers presentation creation only to trusted owner work', () => {
    const registry = toolsWith(vi.fn());
    expect(registry.toolsForTask('unknown').map((tool) => tool.name)).not.toContain(
      'slides.create',
    );
    expect(registry.toolsForTask('owner').map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['slides.create', 'slides.append']),
    );
  });

  it('appends a batch at the presentation tail and keeps retries under one operation key', async () => {
    const api = vi.fn().mockResolvedValue({});
    const tool = toolsWith(api).get('slides.append')?.tool;
    const args = {
      presentationId: 'SLIDES-123_abc',
      slides: [{ title: 'Third' }, { title: 'Fourth' }],
    };
    await tool?.execute(args, {} as never);

    const request = JSON.parse(api.mock.calls[0]?.[1]?.body as string) as {
      requests: Array<Record<string, unknown>>;
    };
    const created = request.requests.filter((item) => 'createSlide' in item);
    expect(created).toHaveLength(2);
    expect(created.every((item) => !('insertionIndex' in (item.createSlide as object)))).toBe(true);
    expect(tool?.idempotencyKey?.(args, { taskId: 'task-1' } as never)).toBe(
      tool?.idempotencyKey?.(args, { taskId: 'task-1' } as never),
    );
    expect(tool?.idempotencyKey?.(args, { taskId: 'task-1' } as never)).not.toBe(
      tool?.idempotencyKey?.(args, { taskId: 'task-2' } as never),
    );
  });
});

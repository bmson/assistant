import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: vi.fn(), list: vi.fn(), detail: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: state.owner }));
vi.mock('@/lib/task-activity', () => ({
  listTaskActivity: state.list,
  getTaskActivityDetail: state.detail,
}));

vi.mock('@/lib/audit-investigation', () => ({ getAuditInvestigation: state.detail }));

import AuditDetailPage from './[id]/page';
import AuditPage from './page';

beforeEach(() => {
  vi.resetAllMocks();
  state.owner.mockResolvedValue({});
});
describe('owner audit console', () => {
  it('distinguishes an empty history from a search with no matching records', async () => {
    state.list.mockResolvedValue({ items: [], archivedCount: 0 });
    const empty = renderToStaticMarkup(await AuditPage({ searchParams: Promise.resolve({}) }));
    expect(empty).toContain('No work recorded yet.');
    expect(empty).not.toContain('Clear filters');
    const filtered = renderToStaticMarkup(
      await AuditPage({ searchParams: Promise.resolve({ q: 'meeting', filter: 'working' }) }),
    );
    expect(filtered).toContain('No records match these filters.');
    expect(filtered).toContain('Clear filters');
    expect(filtered).toContain('0 records');
  });

  it('searches a bounded view and links to audit records', async () => {
    const id = randomUUID();
    state.list.mockResolvedValue({
      items: [
        {
          id,
          title: 'Email failure',
          type: 'chat',
          status: 'failed',
          progress: 'Provider timed out',
          updatedAt: new Date(),
          spentUsd: '0.03',
        },
      ],
      archivedCount: 0,
    });
    const html = renderToStaticMarkup(
      await AuditPage({
        searchParams: Promise.resolve({ q: id, view: 'archived', filter: 'completed' }),
      }),
    );
    expect(state.list).toHaveBeenCalledWith({ archived: true, filter: 'completed', limit: 100 });
    expect(html).toContain(`/audit/${id}`);
    expect(html).toContain('Provider timed out');
    expect(html).not.toContain('/chat');
  });
  it('requires owner authentication before reading any records', async () => {
    state.owner.mockRejectedValue(new Error('sign in required'));
    await expect(AuditPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'sign in required',
    );
    await expect(
      AuditDetailPage({
        params: Promise.resolve({ id: randomUUID() }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('sign in required');
    expect(state.list).not.toHaveBeenCalled();
    expect(state.detail).not.toHaveBeenCalled();
  });
  it('shows failure context, investigation request, and section-specific pagination', async () => {
    const id = randomUUID();
    state.detail.mockResolvedValue({
      task: {
        title: 'Failed send',
        status: 'failed',
        progress: 'Check provider',
        attempt: 2,
        spentUsd: '0.03',
      },
      investigationPrompt: `Investigate audit record ${id}`,
      evidenceNotes: ['Missing capture is not proof of no call.'],
      sections: [
        {
          name: 'toolCalls',
          entries: [
            {
              id: randomUUID(),
              at: '2026-09-30T01:00:00Z',
              fields: {
                toolName: { text: 'gmail.send', hasMore: false },
                error: { text: 'Provider unavailable', hasMore: false },
              },
            },
          ],
          nextCursor: 'stable-cursor',
        },
      ],
    });
    const html = renderToStaticMarkup(
      await AuditDetailPage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({ section: 'toolCalls' }),
      }),
    );
    expect(html).toContain('Provider unavailable');
    expect(html).toContain('Investigate with the assistant');
    expect(html).toContain('Attempt 2');
    expect(html).toContain('cursor=stable-cursor');
    expect(html).toContain('Download records');
    expect(html).not.toContain('Retry task');
  });
  it('retains secondary identity evidence while using one identity as the record heading', async () => {
    const id = randomUUID();
    state.detail.mockResolvedValue({
      task: { title: 'Inspect evidence', status: 'done', attempt: 1, spentUsd: '0.01' },
      investigationPrompt: 'Inspect this evidence',
      evidenceNotes: [],
      sections: [
        {
          name: 'modelCallAudit',
          entries: [
            {
              id: 'context-record',
              at: '2026-10-03T01:00:00Z',
              fields: {
                toolName: { text: 'calendar.list_events' },
                model: { text: 'fixture-provider/model' },
                role: { text: 'assistant' },
                status: { text: 'succeeded' },
              },
            },
          ],
          nextCursor: null,
        },
      ],
    });
    const html = renderToStaticMarkup(
      await AuditDetailPage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('calendar.list_events');
    expect(html).toMatch(/<dt[^>]*>Model<\/dt>/);
    expect(html).toContain('fixture-provider/model');
    expect(html).toMatch(/<dt[^>]*>Role<\/dt>/);
    expect(html).toContain('assistant');
    expect(html).toContain('context-record');
    expect(html).toContain('2026-10-03 01:00:00 UTC');
  });
  it('keeps the selected field download and continuation bound to the exact section and record', async () => {
    const id = randomUUID();
    state.detail.mockResolvedValue({
      task: { title: 'Inspect context', status: 'done', attempt: 1, spentUsd: '0.01' },
      investigationPrompt: 'Inspect this context',
      evidenceNotes: ['Only a bounded slice is shown.'],
      sections: [
        {
          name: 'modelCallAudit',
          entries: [
            {
              id: 'context-record',
              at: '2026-10-03T01:00:00Z',
              fields: {
                input: { text: 'next slice', hasMore: true, offset: 100, totalChars: 500 },
              },
            },
          ],
          nextCursor: 'next-page',
        },
      ],
    });
    const html = renderToStaticMarkup(
      await AuditDetailPage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({
          section: 'modelCallAudit',
          entry: 'context-record',
          field: 'input',
          offset: '100',
        }),
      }),
    );
    expect(state.detail).toHaveBeenCalledWith(id, {
      section: 'modelCallAudit',
      cursor: undefined,
      entryId: 'context-record',
      field: 'input',
      offset: 100,
      limit: 10,
    });
    expect(html).toContain(
      `/api/audit/${id}?section=modelCallAudit&amp;entry=context-record&amp;field=input&amp;offset=100`,
    );
    expect(html).toContain(
      `/audit/${id}?section=modelCallAudit&amp;entry=context-record&amp;field=input&amp;offset=110`,
    );
    expect(html).toContain('Continue this field (110 of');
    expect(html).toContain('cursor=next-page');
  });
});

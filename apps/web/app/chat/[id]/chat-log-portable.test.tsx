import type { UIMessage } from 'ai';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/cards/actions', () => ({ refreshSavedCardInline: vi.fn() }));
vi.mock('@/app/tasks/actions', () => ({ cancelTask: vi.fn(), raiseTaskBudgetAndRetry: vi.fn() }));
vi.mock('@/app/suggestions/actions', () => ({
  decideSuggestionInline: vi.fn(),
  snoozeSuggestionInline: vi.fn(),
}));
vi.mock('@/app/approvals/actions', () => ({ resolveApprovalInline: vi.fn() }));
vi.mock('../actions', () => ({ recordRecallFeedbackAction: vi.fn() }));

import { ChatLog } from './chat-log';

const messages = [
  {
    id: 'assistant-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Here is context for the request.' },
      { type: 'recall', sources: [{ date: '2026-09-01', label: 'Earlier discussion' }] },
      {
        type: 'approval',
        approvalId: 'approval-1',
        shortCode: 'AB12',
        summary: 'Send the invoice',
        status: 'pending',
      },
      {
        type: 'budget-request',
        taskId: 'task-1',
        currentBudgetUsd: 2,
        proposedBudgetUsd: 5,
        spentUsd: 2,
        status: 'pending',
      },
      {
        type: 'suggestion',
        suggestionId: 'suggestion-1',
        summary: 'Review the plan?',
        proposedAction: 'Review the plan',
        status: 'pending',
      },
    ],
    metadata: { createdAt: '2026-09-22T12:00:00.000Z' },
  },
] as unknown as UIMessage[];

function render(log = messages, notificationMode = false, streaming = false) {
  return renderToStaticMarkup(
    <ChatLog
      log={log}
      formSessionScope="verified-browser-session"
      busy={streaming}
      streaming={streaming}
      notificationMode={notificationMode}
      agentTimezone="UTC"
      renderedNow={new Date('2026-09-22T12:01:00.000Z')}
      initialMessageIds={new Set(['assistant-1'])}
      onSend={() => {}}
      onRunForReal={() => {}}
    />,
  );
}

// Every inline control is backed by a Server Action with a PostgreSQL and a
// Firestore path, so the transcript offers the same controls in both drivers.
describe('chat transcript controls', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T12:01:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it.each([false, true])(
    'retains inspectable recall provenance and feedback in notification mode %s',
    (notificationMode) => {
      const recalled = [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Sam prefers an easy walk.' },
            {
              type: 'recall',
              sources: [
                {
                  date: '2026-09-12',
                  label: 'Weekend preferences',
                  kind: 'knowledge_graph',
                  hops: 2,
                },
                { date: '2026-09-20', label: 'Earlier trip chat', kind: 'chat' },
              ],
            },
          ],
          metadata: { createdAt: '2026-09-22T12:00:00.000Z' },
        },
      ] as unknown as UIMessage[];
      const html = render(recalled, notificationMode);
      expect(html).toContain('Sam prefers an easy walk.');
      if (notificationMode) {
        expect(html).toContain('Drawing on knowledge graph and earlier chats');
        expect(html).toContain('Sep 12 — Weekend preferences');
        expect(html).toContain('From 2026-09-12 · 2-hop connection — Weekend preferences');
        expect(html).toContain('Sep 20 — Earlier trip chat');
        expect(html).toContain('This recalled context was useful');
        expect(html).toContain('This recalled context was not useful');
        expect(html).toContain('data-decision-card="true"');
        expect(html).not.toContain('data-reply-context-footer');
      } else {
        expect(html).toContain('Context for this reply');
        expect(html).toContain('2 items');
        expect(html).not.toContain('Weekend preferences');
        expect(html).not.toContain('Earlier trip chat');
        expect(html).not.toContain('Helpful');
      }
    },
  );

  it('offers decision controls and closed recall disclosure', () => {
    const html = render();
    expect(html).toContain('Send the invoice');
    expect(html).toContain('Context for this reply');
    expect(html).not.toContain('Earlier discussion');
    expect(html).not.toContain('Helpful');
    expect(html).toContain('Stop task');
    expect(html).toContain('Start task');
    expect(html).toContain('Review all');
    expect(html).not.toContain('Decision controls are unavailable');
  });

  it('attaches once inside the final rendered prose paper, after its complete text', () => {
    const split = structuredClone(messages);
    split[0].parts.unshift({ type: 'text', text: 'First paper.' }, { type: 'text', text: '   ' });
    const html = render(split);
    const marker = 'data-reply-context-footer="true"';
    expect(html.split(marker)).toHaveLength(2);
    expect(html.indexOf(marker)).toBeGreaterThan(html.indexOf('Here is context for the request.'));
    const paperStart = html.lastIndexOf('<div class="bubble-assistant', html.indexOf(marker));
    const openDivs = [
      ...html.slice(paperStart, html.indexOf(marker)).matchAll(/<div\b[^>]*>|<\/div>/g),
    ].reduce((depth, [tag]) => depth + (tag.startsWith('</') ? -1 : 1), 0);
    expect(paperStart).toBeGreaterThan(-1);
    expect(openDivs).toBe(1); // Final prose paper remains open; Markdown's own wrapper is closed.
  });

  it('does not infer durable provenance ownership from an arbitrary message id', () => {
    const provisional = structuredClone(messages);
    provisional[0].metadata = undefined;
    expect(render(provisional)).not.toContain('data-reply-context-footer');
  });

  it('does not mount the durable footer on the currently streamed reply', () => {
    expect(render(messages, false, true)).not.toContain('data-reply-context-footer');
  });

  it('offers refresh on a refreshable saved card', () => {
    const card = [
      {
        id: 'assistant-card',
        role: 'assistant',
        metadata: { createdAt: '2026-09-22T12:00:00Z' },
        parts: [
          { type: 'text', text: 'Your saved card.' },
          { type: 'recall', sources: [{ date: '2026-09-01', label: 'Private card context' }] },
          {
            type: 'data-card',
            data: {
              kind: 'generated-card',
              id: 'card-1',
              spec: {
                version: 1,
                title: 'Travel card',
                refreshable: true,
                facts: [{ id: 'hotel', label: 'Hotel', value: 'Grand Hotel', source: 'mail' }],
                blocks: [{ type: 'hero', titleFact: 'hotel' }],
                actions: [],
              },
            },
          },
        ],
      },
    ] as unknown as UIMessage[];
    const html = render(card);
    expect(html).toContain('Grand Hotel');
    expect(html).toContain('>Refresh</button>');
    expect(html).not.toContain('data-reply-context-footer');
  });
});

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

function render(log = messages, notificationMode = false) {
  return renderToStaticMarkup(
    <ChatLog
      log={log}
      busy={false}
      streaming={false}
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
      expect(html).toContain('Drawing on knowledge graph and earlier chats');
      expect(html).toContain('Sep 12 — Weekend preferences');
      expect(html).toContain('From 2026-09-12 · 2-hop connection — Weekend preferences');
      expect(html).toContain('Sep 20 — Earlier trip chat');
      expect(html).toContain('This recalled context was useful');
      expect(html).toContain('This recalled context was not useful');
      if (notificationMode) expect(html).toContain('data-decision-card="true"');
    },
  );

  it('offers decision controls and recall feedback', () => {
    const html = render();
    expect(html).toContain('Send the invoice');
    expect(html).toContain('Earlier discussion');
    expect(html).toContain('Helpful');
    expect(html).toContain('Stop task');
    expect(html).toContain('Start task');
    expect(html).toContain('Review all');
    expect(html).not.toContain('Decision controls are unavailable');
  });

  it('offers refresh on a refreshable saved card', () => {
    const card = [
      {
        id: 'assistant-card',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Your saved card.' },
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
  });
});

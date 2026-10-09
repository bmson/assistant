import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/suggestions/actions', () => ({
  decideSuggestionInline: vi.fn(),
  snoozeSuggestionInline: vi.fn(),
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => ({ PERSISTENCE_DRIVER: 'postgres' }) }));

import { proxy } from '../../../proxy';
import { type InlineSuggestionPart, SuggestionCard } from './inline-suggestion';

const taskId = '00000000-0000-4000-8000-000000000001';

const part: InlineSuggestionPart = {
  type: 'suggestion',
  suggestionId: 's1',
  summary: 'Review the progress report?',
  proposedAction: 'Read the email',
  actionLabel: 'Review email',
  status: 'pending',
  contextCard: {
    kind: 'proactive-alert',
    id: 'mail:1',
    category: 'email',
    title: 'Progress report',
    urgencyLabel: 'Needs attention',
    details: [{ label: 'From', value: 'School' }],
  },
};

describe('SuggestionCard', () => {
  it('presents the subject and specific action together, without restating the suggestion', () => {
    const html = renderToStaticMarkup(<SuggestionCard parts={[part]} />);
    expect(html.match(/data-decision-card="true"/g)).toHaveLength(1);
    expect(html).toContain('Review email');
    expect(html).toContain('Progress report');
    expect(html).not.toContain('Review the progress report?');
    expect(html).not.toContain('Yes, do it');
  });

  it('settles into a named collapsed receipt and preserves its result inside disclosure', () => {
    const html = renderToStaticMarkup(
      <SuggestionCard
        parts={[
          {
            ...part,
            status: 'accepted',
            acceptedTaskStatus: 'done',
            acceptedTaskId: taskId,
            acceptedTaskSummary: 'No reply is needed.',
          },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Progress report — Completed"');
    expect(html).not.toContain('<details open');
    expect(html).not.toContain('data-decision-card="true"');
    expect(html).toContain('No reply is needed.');
    expect(html).toContain(`href="/audit/${taskId}"`);
    expect(html).toContain('View task evidence');
    expect(html).not.toContain('href="/tasks/');
    expect(proxy(new NextRequest(`https://assistant.test/audit/${taskId}`)).status).toBe(200);
  });

  it('does not crash on malformed persisted snooze timestamps', () => {
    const html = renderToStaticMarkup(
      <SuggestionCard parts={[{ ...part, status: 'snoozed', snoozedUntil: 'not a date' }]} />,
    );
    expect(html).toContain('Snoozed');
    expect(html).not.toContain('Invalid Date');
  });

  it('renders an unknown future terminal status as a closed receipt for an older client', () => {
    const html = renderToStaticMarkup(
      <SuggestionCard parts={[{ ...part, status: 'superseded' as never }]} />,
    );
    expect(html).toContain('Progress report — No longer available');
    expect(html).not.toContain('data-decision-card="true"');
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatTurnFeedback } from './chat-turn-feedback';

function renderFeedback({
  showError = false,
  error = null,
  note = null,
  canRetry = false,
}: {
  showError?: boolean;
  error?: string | null;
  note?: { text: string; retryable: boolean } | null;
  canRetry?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <ChatTurnFeedback
      showError={showError}
      error={error}
      note={note}
      pollTrouble={null}
      canRetry={canRetry}
      onRetry={vi.fn()}
    />,
  );
}

describe('chat turn feedback', () => {
  it('renders an unknown-stop alert even when no durable note exists', () => {
    const html = renderFeedback({
      showError: true,
      error: 'Stop is unconfirmed. Retry Stop to check the same message.',
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain('Stop is unconfirmed. Retry Stop to check the same message.');
    expect(html).not.toContain('role="status"');
  });

  it('keeps a nonretryable cancellation notice unique and offers no retry', () => {
    const message = 'This message was stopped before it was admitted. No task started.';
    const html = renderFeedback({
      note: { text: message, retryable: false },
      canRetry: true,
    });

    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html.match(/This message was stopped before it was admitted/g)).toHaveLength(1);
    expect(html).toContain('href="/tasks"');
    expect(html).not.toContain('Try again');
  });

  it('offers retry only when the note and current turn both allow it', () => {
    const blocked = renderFeedback({
      note: { text: 'The task paused.', retryable: true },
      canRetry: false,
    });
    const allowed = renderFeedback({
      note: { text: 'The task paused.', retryable: true },
      canRetry: true,
    });

    expect(blocked).not.toContain('Try again');
    expect(allowed.match(/Try again/g)).toHaveLength(1);
  });
});

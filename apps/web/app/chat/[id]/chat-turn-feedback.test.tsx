import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatTurnFeedback } from './chat-turn-feedback';

function renderWithTranscript(log: string[], note: string) {
  return renderToStaticMarkup(
    <div>
      {log.length === 0 ? <p>What should we move forward?</p> : <p>{log.join('')}</p>}
      <ChatTurnFeedback
        showError
        error="Stop is unconfirmed. Retry Stop to check the same message."
        note={{ text: note, retryable: false }}
        pollTrouble={null}
        canRetry={false}
        onRetry={vi.fn()}
      />
    </div>,
  );
}

describe('chat turn feedback placement', () => {
  it.each([
    { description: 'an empty transcript', log: [] },
    { description: 'a populated transcript', log: ['Earlier message'] },
  ])('keeps status and alert visible with $description', ({ log }) => {
    const html = renderWithTranscript(
      log,
      'This message was stopped before it was admitted. No task started.',
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('This message was stopped before it was admitted. No task started.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Stop is unconfirmed. Retry Stop to check the same message.');
    expect(html).toContain('href="/tasks"');
    expect(html.match(/This message was stopped before it was admitted/g)).toHaveLength(1);
  });
});

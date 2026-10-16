import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatCardPresentation } from '@/lib/chat-notices';
import fixtures from './fixtures/partial-answer-notices.json';
import { NoticeCard } from './message-view';

describe('partial answer notices', () => {
  // Captured from the real producer, including flattened/clipped diagnostics.
  // The client test consumes its wire shape without importing runtime services.
  const text = fixtures.short.text;

  it('keeps the full partial answer, warning, lists and usable source links', () => {
    const html = renderToStaticMarkup(
      <NoticeCard
        kind="response-contract"
        text={text}
        presentation={fixtures.short.presentation as ChatCardPresentation}
      />,
    );
    expect(html).toContain('Result not confirmed');
    expect(html).toContain('<strong');
    expect(html).toContain('href="https://example.com/booking"');
    expect(html).toContain('duration unverified');
    expect(html).not.toContain('**Flight:**');
    expect(html).not.toContain('[Booking](');
    expect(html.match(/duration unverified/g)).toHaveLength(1);
    expect(html).not.toContain('Nothing was sent or changed');
  });

  it('does not duplicate a long answer as a clipped diagnostic', () => {
    const long = fixtures.long.text;
    const presentation = fixtures.long.presentation as ChatCardPresentation;
    expect(presentation.diagnostics?.[0]).toContain('…');
    const html = renderToStaticMarkup(
      <NoticeCard kind="response-contract" text={long} presentation={presentation} />,
    );
    expect(html.match(/duration unverified/g)).toHaveLength(1);
    expect(html).not.toContain('Verification details');
  });

  it('keeps technical errors and retracted content literal', () => {
    const html = renderToStaticMarkup(
      <NoticeCard kind="turn-failed" text="**provider failure** [raw](https://example.com)" />,
    );
    expect(html).toContain('**provider failure** [raw](https://example.com)');
    expect(html).not.toContain('href="https://example.com"');
    const retracted = renderToStaticMarkup(
      <NoticeCard kind="retracted" text="Removed" originalText={text} />,
    );
    expect(retracted).toContain('**Flight:**');
    expect(retracted).not.toContain('href="https://example.com/booking"');
  });
});

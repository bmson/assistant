import { describe, expect, it } from 'vitest';
import { selectSmokeExtractQuotes } from './firestore-chat-smoke.js';

describe('Firestore chat smoke extract fixture', () => {
  it('returns only relevant exact owner quotes from the supplied source envelope', () => {
    const ownerQuote = 'The owner observed coastal rainbows by the sea.';
    const prompt = JSON.stringify({
      request: 'What did I tell you about a rainbow?',
      sources: [
        { key: 'message:rainbow', body: ownerQuote, speaker: 'Recorded owner message' },
        {
          key: 'message:unrelated',
          body: 'I prefer concise meeting summaries.',
          speaker: 'Recorded owner message',
        },
        {
          key: 'memory:commitment',
          body: 'The open commitment is to compare Rainbow observation notes.',
          speaker: 'Saved fact marked owner-confirmed',
        },
      ],
    });

    const result = selectSmokeExtractQuotes(prompt);
    expect(result).toEqual({
      selections: [{ sourceKey: 'message:rainbow', quote: ownerQuote }],
    });
    const suppliedSources = JSON.parse(prompt) as {
      sources: Array<{ key: string; body: string }>;
    };
    for (const selection of result?.selections ?? []) {
      const source = suppliedSources.sources.find(
        (candidate) => candidate.key === selection.sourceKey,
      );
      expect(source).toBeDefined();
      expect(source?.body).toContain(selection.quote);
    }
  });

  it('does not turn a related rainbow note into evidence about open commitments', () => {
    const prompt = JSON.stringify({
      request: 'What did I tell you about open commitments for rainbow observation notes?',
      sources: [
        {
          key: 'message:rainbow',
          body: 'The owner prepared rainbow notes by the sea.',
          speaker: 'Recorded owner message',
        },
      ],
    });

    expect(selectSmokeExtractQuotes(prompt)).toEqual({ selections: [] });
  });

  it('fails closed when the selector prompt does not contain the expected envelope', () => {
    expect(selectSmokeExtractQuotes('{"request":"What did I tell you?"}')).toBeNull();
    expect(selectSmokeExtractQuotes('{')).toBeNull();
  });
});

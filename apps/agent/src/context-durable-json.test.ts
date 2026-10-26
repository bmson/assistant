import { describe, expect, it } from 'vitest';
import { normalizeExpectedDurableJson } from './context-durable-json.js';

describe('durable receipt JSON comparison', () => {
  it('normalizes only expected Date values to their JSON wire strings', () => {
    const instant = '2026-10-26T00:13:41.007Z';
    const expected = {
      matches: [
        {
          messageId: 'synthetic-message',
          conversationId: 'synthetic-conversation',
          text: 'Exact synthetic owner passage.',
          sourceRevision: 'source-revision-sha',
          speakerRevision: 'speaker-revision-sha',
          createdAt: new Date(instant),
        },
      ],
      mode: 'semantic',
    };
    const durableWireValue = {
      matches: [
        {
          messageId: 'synthetic-message',
          conversationId: 'synthetic-conversation',
          text: 'Exact synthetic owner passage.',
          sourceRevision: 'source-revision-sha',
          speakerRevision: 'speaker-revision-sha',
          createdAt: instant,
        },
      ],
      mode: 'semantic',
    };

    expect(normalizeExpectedDurableJson(expected)).toEqual(durableWireValue);
  });

  it('keeps source identity, provenance revisions, content, and non-date values exact', () => {
    const expected = {
      messageId: 'synthetic-message',
      text: 'Exact synthetic owner passage.',
      sourceRevision: 'source-revision-sha',
      speakerRevision: 'speaker-revision-sha',
      createdAt: new Date('2026-10-26T00:13:41.007Z'),
    };
    const normalized = normalizeExpectedDurableJson(expected);

    expect(
      normalizeExpectedDurableJson({
        ...expected,
        messageId: 'different-message',
      }),
    ).not.toEqual(normalized);
    expect(
      normalizeExpectedDurableJson({
        ...expected,
        text: 'Different owner passage.',
      }),
    ).not.toEqual(normalized);
    expect(
      normalizeExpectedDurableJson({
        ...expected,
        sourceRevision: 'different-source-revision',
      }),
    ).not.toEqual(normalized);
    expect(
      normalizeExpectedDurableJson({
        ...expected,
        speakerRevision: 'different-speaker-revision',
      }),
    ).not.toEqual(normalized);
  });
});

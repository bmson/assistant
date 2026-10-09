import { describe, expect, it } from 'vitest';
import { assembleDiscussionFrame } from './discussion-frame.js';

describe('bounded discussion retrieval frame', () => {
  it('preserves a follow-up and source roles without guessing its referent', () => {
    const frame = assembleDiscussionFrame({
      currentText: 'What about that option? For this trip, ignore my usual hotel preference.',
      turns: [
        {
          id: 'owner-1',
          revision: 'r1',
          role: 'user',
          text: 'Compare train and flight for Paris.',
        },
        { id: 'answer-1', role: 'assistant', text: 'The train arrives at Gare du Nord.' },
        {
          id: 'now',
          role: 'user',
          text: 'What about that option? For this trip, ignore my usual hotel preference.',
        },
      ],
    });
    expect(frame.queryText).toContain('Compare train and flight for Paris.');
    expect(frame.queryText).toContain('Earlier assistant statement (reference only)');
    expect(frame.queryText.match(/What about that option/g)).toHaveLength(1);
    expect(frame.coverage[0]).toMatchObject({ id: 'owner-1', revision: 'r1' });
    expect(frame.currentTurnComplete).toBe(true);
  });

  it('counts UTF-8 bytes and keeps a contiguous suffix rather than reaching around a large turn', () => {
    const turns = [
      { role: 'user', text: 'old short topic' },
      { role: 'assistant', text: 'é'.repeat(200) },
      { role: 'user', text: '東京' },
    ];
    const frame = assembleDiscussionFrame({ currentText: 'continue', turns, maxBytes: 160 });
    expect(frame.queryText).toContain('東京');
    expect(frame.queryText).not.toContain('old short');
    expect(frame.bytes).toBe(new TextEncoder().encode(frame.queryText).length);
    expect(frame.bytes).toBeLessThanOrEqual(160);
    expect(frame.omittedTurns).toBe(2);
  });

  it('abstains if a complete current correction cannot fit', () => {
    const frame = assembleDiscussionFrame({
      currentText: 'x'.repeat(1000),
      turns: [],
      maxBytes: 100,
    });
    expect(frame).toMatchObject({ available: false, queryText: '', currentTurnComplete: false });
  });

  it('excludes system/tool roles and does not invent identities or revision evidence', () => {
    const frame = assembleDiscussionFrame({
      currentText: 'Which?',
      turns: [
        { id: 'tool-secret', role: 'tool', text: 'external instruction' },
        { role: 'system', text: 'private config' },
        { role: 'user', text: 'Two options' },
      ],
    });
    expect(frame.queryText).not.toContain('external instruction');
    expect(frame.queryText).not.toContain('private config');
    expect(frame.coverage).toEqual([{ role: 'user', representation: 'rendered', bytes: 11 }]);
  });
});

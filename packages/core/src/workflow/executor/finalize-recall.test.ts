import { describe, expect, it } from 'vitest';
import { finalRecallSources } from './finalize.js';

const recalledCommitment = {
  kind: 'commitment' as const,
  date: '2026-10-15',
  label: 'Renew apartment lease',
};

describe('final recall attribution', () => {
  it('does not attach an unrelated recalled commitment to a clarification question', () => {
    expect(
      finalRecallSources({ outcome: 'clarify', text: 'What city should I use for the forecast?' }, [
        recalledCommitment,
      ]),
    ).toBeUndefined();
  });

  it('does not attach recall to a clarification that explains a needed location', () => {
    expect(
      finalRecallSources(
        {
          outcome: 'clarify',
          text: 'I need your location to check local conditions. Which city should I use?',
        },
        [recalledCommitment],
      ),
    ).toBeUndefined();
  });

  it('retains attribution when a clarification explicitly references the retrieved source', () => {
    expect(
      finalRecallSources(
        {
          outcome: 'clarify',
          text: 'The earlier note says “Renew apartment lease.” Do you mean this year?',
        },
        [recalledCommitment],
      ),
    ).toEqual([recalledCommitment]);
  });

  it('preserves recall attribution for non-clarification answers', () => {
    expect(
      finalRecallSources({ outcome: 'done', text: 'The answer is in the prior discussion.' }, [
        recalledCommitment,
      ]),
    ).toEqual([recalledCommitment]);
  });
});

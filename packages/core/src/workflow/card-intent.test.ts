import { describe, expect, it } from 'vitest';
import { requestedArtifactIntent } from './artifact-intent.js';
import { requestedCardIntent } from './card-intent.js';

describe('requestedCardIntent', () => {
  it.each([
    'Make that into a card for me',
    'make that into a card',
    'turn this into a card',
    'save that as a card',
    'keep this as a card please',
    'can you make a card out of the hotel booking?',
    'add a card for the match on Saturday',
    'pin that as a card',
    // The wallet card is the subject; the artifact asked for is still a card.
    'save my boarding card as a card',
  ])('recognizes %s as a card request', (text) => {
    expect(requestedCardIntent(text)).toBe(true);
  });

  it.each([
    'how do cards work?',
    'why did you make a card?',
    'what cards do I have?',
    'can it make cards?',
    "don't make a card for this",
    'show me my cards',
    'the credit card expires next month',
    'save my credit card and debit card numbers',
    'save my gift card and library card',
    'Translate: “make a card”',
    'make a doc summarizing the booking',
    'what is on my calendar today',
  ])('does not treat %s as a card request', (text) => {
    expect(requestedCardIntent(text)).toBe(false);
  });
});

describe('a card request never routes to a Google artifact', () => {
  it.each([
    'Make that into a card for me',
    'turn this into a card',
    // "card document" must not resolve to docs.create on the stray DOC match.
    'save that as a card document',
  ])('leaves %s unrouted', (text) => {
    expect(requestedArtifactIntent(text)).toBeUndefined();
  });

  it('still routes a genuine document request', () => {
    expect(requestedArtifactIntent('Create a Google Document for the project plan')?.toolName).toBe(
      'docs.create',
    );
  });
});

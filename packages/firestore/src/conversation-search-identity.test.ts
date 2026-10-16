import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validConversationSearchUuid } from './conversation-search.js';

describe('conversation search source identity', () => {
  it('accepts canonical UUIDs with all five groups', () => {
    expect(validConversationSearchUuid(randomUUID())).toBe(true);
    expect(validConversationSearchUuid('A1B2C3D4-E5F6-4789-ABCD-0123456789AB')).toBe(true);
  });

  it('rejects malformed UUIDs before a Firestore lookup', () => {
    expect(validConversationSearchUuid('a1b2c3d4-e5f6-4789-0123456789ab')).toBe(false);
    expect(validConversationSearchUuid('a1b2c3d4-e5f6-4789-abcd-0123456789a')).toBe(false);
    expect(validConversationSearchUuid(null)).toBe(false);
  });
});

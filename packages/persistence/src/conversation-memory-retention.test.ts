import { describe, expect, it } from 'vitest';
import {
  isOwnerTaskMemoryEphemeral,
  OWNER_TASK_MEMORY_RETENTION,
  ownerTurnReferencesEphemeralContext,
  ownerTurnRequestsEphemeralMemory,
} from './conversation-memory-retention.js';

describe('owner-turn memory retention', () => {
  it('marks direct no-save and clearly fictional, non-personal source turns', () => {
    expect(
      ownerTurnRequestsEphemeralMemory('Do not save fictional facts as personal memories.'),
    ).toBe(true);
    expect(
      ownerTurnRequestsEphemeralMemory(
        'This is a fictional test document, not personal information.',
      ),
    ).toBe(true);
    expect(
      ownerTurnRequestsEphemeralMemory('For this hypothetical exercise, plan a pretend workday.'),
    ).toBe(true);
    expect(
      ownerTurnRequestsEphemeralMemory("Don't remember anything from this conversation."),
    ).toBe(true);
    expect(
      ownerTurnRequestsEphemeralMemory(
        'Using the project details I just gave you in this conversation, do not save anything from that fictional exercise.',
      ),
    ).toBe(true);
    expect(
      ownerTurnRequestsEphemeralMemory(
        'Using the project details I just gave you in this conversation, do not invent details or save anything.',
      ),
    ).toBe(true);
    expect(ownerTurnRequestsEphemeralMemory('Don’t save this as a memory.')).toBe(true);
  });

  it('does not treat quoted content or action limits as a retention policy', () => {
    expect(
      ownerTurnRequestsEphemeralMemory(
        'The document says “do not save fictional facts as memories.”',
      ),
    ).toBe(false);
    expect(
      ownerTurnRequestsEphemeralMemory(
        "The document says 'do not save fictional facts as memories.'",
      ),
    ).toBe(false);
    expect(
      ownerTurnRequestsEphemeralMemory(
        'The document says do not save fictional facts as memories.',
      ),
    ).toBe(false);
    expect(ownerTurnRequestsEphemeralMemory('Do not send or edit anything.')).toBe(false);
    expect(ownerTurnRequestsEphemeralMemory('Do not invent details or send anything.')).toBe(false);
    expect(ownerTurnRequestsEphemeralMemory('Remember that I prefer concise notes.')).toBe(false);
  });

  it('recognizes only a bounded explicit follow-up to fictional context', () => {
    expect(
      ownerTurnReferencesEphemeralContext(
        'Using the project details I just gave you in this conversation, do not save anything from the fictional exercise.',
      ),
    ).toBe(true);
    expect(ownerTurnReferencesEphemeralContext('I moved to Oslo last month.')).toBe(false);
    expect(
      isOwnerTaskMemoryEphemeral({
        source: 'chat',
        trust: 'owner',
        agentId: 'agent',
        conversationId: 'conversation',
        payload: { memoryRetention: OWNER_TASK_MEMORY_RETENTION },
      }),
    ).toBe(true);
    expect(isOwnerTaskMemoryEphemeral({ payload: { memoryRetention: 'other' } })).toBe(false);
    expect(
      isOwnerTaskMemoryEphemeral({
        source: 'scheduled',
        trust: 'assistant',
        agentId: 'agent',
        conversationId: 'conversation',
        payload: { memoryRetention: OWNER_TASK_MEMORY_RETENTION },
      }),
    ).toBe(false);
    expect(
      isOwnerTaskMemoryEphemeral({
        source: 'scheduled',
        trust: 'assistant',
        payload: { text: 'This is a fictional exercise, not personal information.' },
      }),
    ).toBe(false);
  });
});

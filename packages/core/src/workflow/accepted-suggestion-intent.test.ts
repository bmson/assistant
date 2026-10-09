import type { TaskRow } from '@assistant/db';
import type { SuggestionRecord } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { acceptedKnownSenderReplyIntent } from './accepted-suggestion-intent.js';

const task = {
  id: 'task-1',
  agentId: 'agent-1',
  type: 'adhoc',
  trust: 'owner',
  trigger: {
    source: 'internal',
    payload: {
      suggestionId: 'suggestion-1',
      instruction: 'Reply to the sender with this exact draft.',
      taintedOrigin: true,
    },
  },
} as unknown as TaskRow;

const proposal = {
  id: 'suggestion-1',
  agentId: 'agent-1',
  acceptedTaskId: 'task-1',
  status: 'accepted',
  origin: 'known_sender_reply',
  sourceRef: 'known-sender-reply:parent-1',
  proposedAction: 'Reply to the sender with this exact draft.',
} as unknown as SuggestionRecord;

describe('accepted known-sender reply intent', () => {
  it('requires a stored accepted proposal bound to the exact task and instruction', () => {
    expect(acceptedKnownSenderReplyIntent({ task, proposal })).toMatchObject({
      sourceActor: 'owner',
      requestKind: 'new_request',
      authorizedScopes: ['external_send'],
      separation: 'clear',
      externalText: proposal.proposedAction,
    });
  });

  it.each([
    ['missing stored proposal', null],
    ['different accepted task', { ...proposal, acceptedTaskId: 'task-2' }],
    ['foreign owner', { ...proposal, agentId: 'agent-2' }],
    ['unaccepted row', { ...proposal, status: 'pending' }],
    ['other origin', { ...proposal, origin: 'briefing' }],
    ['unrelated source reference', { ...proposal, sourceRef: 'forged-source' }],
    ['changed proposal text', { ...proposal, proposedAction: 'Different reply.' }],
  ])('rejects %s', (_label, row) => {
    expect(
      acceptedKnownSenderReplyIntent({
        task,
        proposal: row as SuggestionRecord | null,
      }),
    ).toBeNull();
  });

  it('rejects assistant tasks and triggers that do not bind the stored suggestion', () => {
    expect(
      acceptedKnownSenderReplyIntent({
        task: { ...task, trust: 'assistant' },
        proposal,
      }),
    ).toBeNull();
    expect(
      acceptedKnownSenderReplyIntent({
        task: {
          ...task,
          trigger: {
            source: 'email',
            payload: {
              suggestionId: proposal.id,
              instruction: proposal.proposedAction,
              taintedOrigin: true,
            },
          },
        },
        proposal,
      }),
    ).toBeNull();
  });
});

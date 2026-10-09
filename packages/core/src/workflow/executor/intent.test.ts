import type { TaskRow } from '@assistant/db';
import type { ExecutionEvidenceRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { unreadSharedDocumentIntent } from './intent.js';

function makeEvidence(alreadyRead = false) {
  const hasConversationToolCall = vi.fn().mockResolvedValue(alreadyRead);
  return {
    evidence: { hasConversationToolCall } as unknown as Pick<
      ExecutionEvidenceRepository,
      'hasConversationToolCall'
    >,
    hasConversationToolCall,
  };
}

describe('unreadSharedDocumentIntent', () => {
  const task = {
    id: 'task-1',
    agentId: 'agent-1',
    trust: 'owner',
    conversationId: 'conv-1',
  } as Pick<TaskRow, 'id' | 'agentId' | 'trust' | 'conversationId'>;

  it('only auto-reads a document from the latest user turn', async () => {
    const { evidence, hasConversationToolCall } = makeEvidence();
    const intent = await unreadSharedDocumentIntent(evidence, task as TaskRow, [
      { role: 'user', content: 'https://docs.google.com/document/d/doc-old-12345/edit' },
      { role: 'assistant', content: 'I can help with that.' },
      { role: 'user', content: 'Please create a new one instead.' },
    ]);

    expect(intent).toBeUndefined();
    expect(hasConversationToolCall).not.toHaveBeenCalled();
  });

  it('returns the latest document URL when no matching tool call exists', async () => {
    const { evidence, hasConversationToolCall } = makeEvidence();
    const intent = await unreadSharedDocumentIntent(evidence, task as TaskRow, [
      {
        role: 'user',
        content: 'https://docs.google.com/document/d/doc-1234567890/edit',
      },
    ]);

    expect(intent).toEqual({
      toolName: 'docs.get',
      documentId: 'doc-1234567890',
    });
    expect(hasConversationToolCall).toHaveBeenCalledWith({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolName: 'docs.get',
      documentId: 'doc-1234567890',
    });
  });

  it('does not re-trigger a document that already has a matching tool call', async () => {
    const { evidence } = makeEvidence(true);
    const intent = await unreadSharedDocumentIntent(evidence, task as TaskRow, [
      {
        role: 'user',
        content: 'https://docs.google.com/document/d/doc-1234567890/edit',
      },
    ]);

    expect(intent).toBeUndefined();
  });
  it('requires a current read for an explicit renewed request after earlier success or failure', async () => {
    const { evidence, hasConversationToolCall } = makeEvidence(true);
    expect(
      await unreadSharedDocumentIntent(evidence, task as TaskRow, [
        {
          role: 'user',
          content:
            'Please reread this updated document: https://docs.google.com/document/d/doc-1234567890/edit',
        },
      ]),
    ).toEqual({ toolName: 'docs.get', documentId: 'doc-1234567890' });
    expect(hasConversationToolCall).not.toHaveBeenCalled();
  });
});

/** An owner or assistant turn; null vectors are retained as explicit coverage gaps. */
export interface SegmentableMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: Date;
  embedding: number[] | null;
  embeddingSpaceKey: string | null;
}

export interface ConversationSegmentInput {
  agentId: string;
  conversationId: string;
  startMessageId: string;
  endMessageId: string;
  summary: string;
  /** Null when the summary could not be embedded; recall then never matches the segment. */
  embedding: number[] | null;
  embeddingSpaceKey: string | null;
  messageCount: number;
  startedAt: Date;
  endedAt: Date;
}

/**
 * Reads and writes for topic segmentation of long-running chats (the
 * `chat.segment` job). Grouping, summarizing and embedding stay in core.
 */
export interface ConversationSegmentationRepository {
  readonly kind: 'conversation-segmentation-repository';
  /** The owner's and assistant's own threads, most recently active first. */
  recentConversations(agentId: string, limit: number): Promise<Array<{ id: string }>>;
  /**
   * Non-empty owner and assistant turns, oldest first, strictly after the
   * latest segment's stable (timestamp, message ID) boundary. Rows without a
   * current vector are returned with `embedding: null`, never skipped, so the
   * caller cannot advance coverage past a repairable gap.
   */
  unsegmentedMessages(
    agentId: string,
    conversationId: string,
    limit: number,
    embeddingSpaceKey: string,
  ): Promise<SegmentableMessage[]>;
  /**
   * Record a segment unless one already starts at `startMessageId` in this
   * conversation. True when this call created it.
   */
  commitSegment(input: ConversationSegmentInput): Promise<boolean>;
}

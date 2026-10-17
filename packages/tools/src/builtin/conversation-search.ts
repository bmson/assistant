import { Buffer } from 'node:buffer';
import {
  type ConversationSearchRepository,
  type ConversationSearchSourceRef,
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
  validConversationSpeaker,
} from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

const MAX_CONTEXT_MATCHES = 10;
const MAX_CONTEXT_TEXT_BYTES = 32_000;
const MAX_CONTEXT_RESULT_BYTES = 48_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `conversations.search` over a message search repository instead of SQL. */
export function registerPortableConversationSearchTool(
  registry: ToolRegistry,
  deps: {
    embed: (texts: string[]) => Promise<{
      embeddings: number[][];
      embeddingSpaceKey: string;
    }>;
    conversations: ConversationSearchRepository;
    webUrl?: string;
  },
): ToolRegistry {
  const sourceLink = <T extends { conversationId: string; messageId: string }>(match: T) => {
    if (!deps.webUrl) return match;
    try {
      const url = new URL(
        `/chat/${encodeURIComponent(match.conversationId)}#message-${encodeURIComponent(match.messageId)}`,
        deps.webUrl,
      );
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return match;
      return { ...match, sourceUrl: url.href };
    } catch {
      return match;
    }
  };
  register(
    registry,
    {
      name: 'conversations.search',
      description: 'Search past conversations semantically or by an explicit name or phrase.',
      inputSchema: z.object({
        query: z.string().min(2).max(500),
        limit: z.number().int().min(1).max(20).default(5),
        mode: z.enum(['semantic', 'text']).optional(),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        if (args.mode === 'text') {
          const matches = await deps.conversations.text({
            agentId: ctx.agentId,
            query: args.query,
            limit: args.limit,
            ...(ctx.conversationId ? { currentConversationId: ctx.conversationId } : {}),
          });
          return { matches: matches.map(sourceLink), mode: 'text' };
        }
        const result = await deps.embed([args.query]);
        if (result.embeddings.length !== 1)
          throw new Error('conversation search requires exactly one query embedding');
        const [embedding] = result.embeddings;
        if (!embedding) throw new Error('embedding unavailable');
        if (!/^[a-f0-9]{64}$/.test(result.embeddingSpaceKey))
          throw new Error('embedding space identity unavailable');
        const semantic = await deps.conversations.semantic({
          agentId: ctx.agentId,
          embedding,
          embeddingSpaceKey: result.embeddingSpaceKey,
          limit: args.limit,
          ...(ctx.conversationId ? { currentConversationId: ctx.conversationId } : {}),
        });
        if (semantic.length > 0) return { matches: semantic.map(sourceLink), mode: 'semantic' };
        const text = await deps.conversations.text({
          agentId: ctx.agentId,
          query: args.query,
          limit: args.limit,
          ...(ctx.conversationId ? { currentConversationId: ctx.conversationId } : {}),
        });
        return { matches: text.map(sourceLink), mode: 'text' };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );
  register(
    registry,
    {
      name: 'conversations.context',
      description:
        'Read a bounded window around 1–2 exact messages returned by conversations.search. Include each message ID, conversation ID, source revision, and speaker revision exactly as returned. This reads only the cited message context, not the whole conversation history.',
      inputSchema: z
        .object({
          anchors: z
            .array(
              z
                .object({
                  messageId: z.string().uuid(),
                  conversationId: z.string().uuid(),
                  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
                  speakerRevision: z.string().regex(/^[a-f0-9]{64}$/),
                })
                .strict(),
            )
            .min(1)
            .max(2),
        })
        .strict(),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        if (typeof deps.conversations.context !== 'function')
          throw new Error('Conversation context is unavailable');
        const distinctIds = new Set(args.anchors.map((anchor) => anchor.messageId));
        if (distinctIds.size !== args.anchors.length)
          throw new Error('Conversation context anchors must be distinct');
        const anchors: ConversationSearchSourceRef[] = args.anchors.map((anchor) => ({
          messageId: anchor.messageId,
          conversationId: anchor.conversationId,
          sourceRevision: anchor.sourceRevision,
          speakerRevision: anchor.speakerRevision,
        }));
        const anchorConversationIds = new Set(anchors.map((anchor) => anchor.conversationId));
        const result = await deps.conversations.context({
          agentId: ctx.agentId,
          ...(ctx.conversationId ? { currentConversationId: ctx.conversationId } : {}),
          anchors,
        });
        if (
          !Array.isArray(result.matches) ||
          result.matches.length > MAX_CONTEXT_MATCHES ||
          (result.observationGeneration !== null &&
            (typeof result.observationGeneration !== 'string' ||
              result.observationGeneration.length > 200))
        )
          throw new Error('Conversation context repository returned malformed evidence');
        const matchIds = new Set<string>();
        let textBytes = 0;
        for (const match of result.matches) {
          if (
            !match ||
            Object.keys(match).some(
              (key) =>
                ![
                  'messageId',
                  'conversationId',
                  'sourceRevision',
                  'speakerRevision',
                  'role',
                  'origin',
                  'text',
                  'createdAt',
                ].includes(key),
            ) ||
            typeof match.messageId !== 'string' ||
            !UUID.test(match.messageId) ||
            typeof match.conversationId !== 'string' ||
            !UUID.test(match.conversationId) ||
            !anchorConversationIds.has(match.conversationId) ||
            typeof match.text !== 'string' ||
            typeof match.createdAt?.getTime !== 'function' ||
            !Number.isFinite(match.createdAt.getTime()) ||
            !/^[a-f0-9]{64}$/.test(match.sourceRevision) ||
            typeof match.speakerRevision !== 'string' ||
            typeof match.role !== 'string' ||
            typeof match.origin !== 'string' ||
            !validConversationSpeaker(match as unknown as Record<string, unknown>) ||
            conversationMessageSourceRevision(match.messageId, match.text) !==
              match.sourceRevision ||
            conversationMessageSpeakerRevision(
              match.messageId,
              match.text,
              match.role,
              match.origin,
            ) !== match.speakerRevision ||
            matchIds.has(match.messageId)
          )
            throw new Error('Conversation context repository returned malformed evidence');
          textBytes += Buffer.byteLength(match.text);
          if (textBytes > MAX_CONTEXT_TEXT_BYTES)
            throw new Error('Conversation context repository exceeded the text bound');
          matchIds.add(match.messageId);
        }
        for (const anchor of anchors) {
          const found = result.matches.find((match) => match.messageId === anchor.messageId);
          if (
            !found ||
            found.conversationId !== anchor.conversationId ||
            found.sourceRevision !== anchor.sourceRevision ||
            found.speakerRevision !== anchor.speakerRevision
          )
            throw new Error('Conversation context did not retain every exact anchor');
        }
        const output = {
          mode: 'context',
          matches: result.matches.map(sourceLink),
          anchors,
          window: { before: 3, after: 1 },
          observationGeneration: result.observationGeneration,
        };
        if (Buffer.byteLength(JSON.stringify(output)) > MAX_CONTEXT_RESULT_BYTES)
          throw new Error('Conversation context repository exceeded the output bound');
        return output;
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );
  return registry;
}

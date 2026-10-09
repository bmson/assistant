import { CHAT_ADMISSION_PROTOCOL } from '@assistant/persistence';
import { sql } from 'drizzle-orm';
import { tasks } from './schema.js';

/** Excludes only the canonical, content-free pre-admission cancellation namespace. */
export function notChatAdmissionCancellationSql() {
  const operationId = sql`(${tasks.trigger}->'payload'->'chatAdmissionCancellation'->>'clientOperationId')`;
  const expectedTrigger = sql`jsonb_build_object(
    'source', 'chat',
    'agentId', ${tasks.agentId},
    'conversationId', ${tasks.conversationId},
    'trust', 'owner',
    'payload', jsonb_build_object(
      'chatAdmissionCancellation', jsonb_build_object(
        'protocol', ${CHAT_ADMISSION_PROTOCOL}::text,
        'clientOperationId', ${operationId}
      )
    )
  )`;
  const marker = sql`(
    ${tasks.status} = 'cancelled'
    AND ${tasks.type} = 'chat_turn'
    AND ${tasks.trust} = 'owner'
    AND ${tasks.conversationId} IS NOT NULL
    AND ${tasks.externalEventId} = 'chat-admission:' || ${tasks.agentId} || ':' || ${tasks.conversationId} || ':' || ${operationId}
    AND ${operationId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND ${tasks.trigger} = ${expectedTrigger}
  )`;
  return sql`NOT COALESCE(${marker}, false)`;
}

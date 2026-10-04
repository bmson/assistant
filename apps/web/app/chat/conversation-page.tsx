import { notFound } from 'next/navigation';
import { requireOwner } from '@/auth';
import { chatNoticeMessage } from '@/lib/chat-notices';
import { getChatApplication } from '@/lib/server';
import { ChatClient } from './[id]/chat-client';
import '../conversation.css';

export interface ChatPageQuery {
  task?: string;
  cursor?: string;
  notice?: string;
  ask?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function renderChatConversation(id: string, query: ChatPageQuery) {
  await requireOwner();
  if (!UUID_RE.test(id)) notFound();

  const view = await getChatApplication().getChatConversation(id, {
    taskId: query.task,
    cursor: query.cursor,
  });
  if (!view) notFound();
  const { conversation } = view;

  return (
    <ChatClient
      conversationId={conversation.id}
      title={conversation.title || 'Untitled'}
      agentName={view.agentName}
      agentTimezone={view.agentTimezone}
      renderedAt={new Date().toISOString()}
      initialMessages={view.messages}
      models={view.models}
      modelOverride={conversation.modelOverride}
      goalTitle={view.goalTitle}
      archived={conversation.archivedAt !== null}
      isPrimary={conversation.isPrimary}
      canArchive={view.canArchive}
      initialNotice={chatNoticeMessage(query.notice)}
      initialInput={typeof query.ask === 'string' ? query.ask.slice(0, 500) : undefined}
      initialAsyncTurn={view.asyncTurn}
      initialCursor={view.cursor}
    />
  );
}

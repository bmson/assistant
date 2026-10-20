import { requireOwner } from '@/auth';
import { getChatApplication } from '@/lib/server';
import { type ChatPageQuery, renderChatConversation } from './conversation-page';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Chat' };

/**
 * The single long-running thread is the default chat experience (Phase 3 of the
 * long-running-chat design): /chat renders the one canonical primary thread at
 * a clean, stable URL. The full list of threads stays reachable at /chat/all.
 */
export default async function ChatIndexPage({
  searchParams,
}: {
  searchParams: Promise<ChatPageQuery>;
}) {
  await requireOwner();
  return renderChatConversation(
    await getChatApplication().getPrimaryConversationId(),
    await searchParams,
  );
}

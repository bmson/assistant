import { type ChatPageQuery, renderChatConversation } from '../conversation-page';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Chat' };

export default async function ChatConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<ChatPageQuery>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return renderChatConversation(id, query);
}

import { projectMobileCardCapabilities } from '@/lib/mobile-card-capabilities';
import { getAgentIdentity, getChatApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** One cold-launch request: identity, badges, and the primary conversation. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();

  const application = getChatApplication();
  const identity = await getAgentIdentity();
  if (!identity.id) return mobileJson({ error: 'assistant not configured' }, { status: 503 });

  const [shell, conversationId] = await Promise.all([
    application.getShellStatus(identity.id),
    application.getPrimaryConversationId(),
  ]);
  const conversation = await application.getChatConversation(conversationId, {});
  if (!conversation) return mobileJson({ error: 'conversation not found' }, { status: 404 });

  return mobileJson({
    generatedAt: new Date().toISOString(),
    identity,
    shell,
    conversation: projectMobileCardCapabilities(conversation, request),
  });
}

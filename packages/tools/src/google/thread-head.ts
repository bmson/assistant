import type { EmailThreadHeadReader } from '@assistant/persistence';
import type { GoogleClient } from './client.js';

/** Read only thread identity/order metadata. Oversized or incomplete identity is unknown. */
export function gmailThreadHeadReader(client: GoogleClient): EmailThreadHeadReader {
  return async ({ threadId, signal }) => {
    if (!client.configured() || !/^[A-Za-z0-9_-]{1,256}$/.test(threadId)) return null;
    const query = new URLSearchParams({
      format: 'metadata',
      fields: 'id,messages(id,threadId,internalDate,labelIds)',
    });
    const thread = await client.api<{
      id?: unknown;
      messages?: Array<{
        id?: unknown;
        threadId?: unknown;
        internalDate?: unknown;
        labelIds?: unknown;
      }>;
    }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?${query}`,
      { signal },
    );
    if (
      thread.id !== threadId ||
      !Array.isArray(thread.messages) ||
      thread.messages.length === 0 ||
      thread.messages.length > 200
    )
      return null;
    const messages = [];
    for (const message of thread.messages) {
      if (
        !message ||
        typeof message.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(message.id) ||
        message.threadId !== threadId ||
        typeof message.internalDate !== 'string' ||
        !/^\d{1,16}$/.test(message.internalDate) ||
        !Array.isArray(message.labelIds) ||
        message.labelIds.some((label) => typeof label !== 'string')
      )
        return null;
      const received = new Date(Number(message.internalDate));
      if (!Number.isFinite(received.getTime())) return null;
      messages.push({ id: message.id, received, labels: message.labelIds as string[] });
    }
    messages.sort(
      (a, b) => b.received.getTime() - a.received.getTime() || b.id.localeCompare(a.id),
    );
    const latest = messages[0];
    if (!latest || latest.labels.includes('TRASH') || latest.labels.includes('SPAM')) return null;
    // Equal provider timestamps do not establish which distinct message is newest.
    if (
      messages.some(
        (message) =>
          message.id !== latest.id && message.received.getTime() === latest.received.getTime(),
      )
    )
      return null;
    return { threadId, latestMessageId: latest.id, latestReceivedAt: latest.received };
  };
}

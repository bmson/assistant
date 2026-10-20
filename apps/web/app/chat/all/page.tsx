import { MessageSquareText } from 'lucide-react';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getChatApplication } from '@/lib/server';
import {
  Badge,
  btn,
  cardShellClass,
  cardTitleClass,
  EmptyState,
  PageHeader,
  PageShell,
} from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import {
  archiveConversation,
  archiveInactiveConversations,
  newConversation,
  restoreConversation,
} from '../actions';

export const metadata = { title: 'All chats' };

export const dynamic = 'force-dynamic';

export default async function ChatListPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  await requireOwner();
  const { view } = await searchParams;
  const archived = view === 'archived';
  const {
    conversations: chatRows,
    archivedCount,
    totalInScope,
    activeConversationIds: activeIds,
  } = await getChatApplication().listChatHistory(archived);
  const activeConversationIds = new Set(activeIds);
  const now = new Date();

  return (
    <PageShell size="reading">
      {/* The primary action rides with the title; the housekeeping ones sit in
          their own row beneath. All three in one wrapping row put "New chat"
          wherever the long "Archive inactive chats" label happened to leave a
          gap, which on a phone was its own ragged third line. */}
      <PageHeader
        back={
          archived ? { href: '/chat/all', label: 'All chats' } : { href: '/chat', label: 'Chat' }
        }
        title={archived ? 'Archived chats' : 'All chats'}
        intro={
          archived
            ? 'Archived chats stay intact and can be restored at any time.'
            : 'Your main thread brings older topics back when they become relevant.'
        }
        actions={
          <form action={newConversation}>
            <SubmitButton variant="primary" pendingLabel="Creating…">
              New chat
            </SubmitButton>
          </form>
        }
      />
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Link href="/chat" className={btn.outline}>
          Main thread
        </Link>
        {archived ? (
          <Link href="/chat/all" className={btn.outline}>
            Current chats
          </Link>
        ) : (
          <>
            {archivedCount > 0 ? (
              <Link href="/chat/all?view=archived" className={btn.outline}>
                Archived ({archivedCount})
              </Link>
            ) : null}
            <form action={archiveInactiveConversations}>
              <SubmitButton variant="outline" pendingLabel="Archiving…">
                Archive inactive chats (30+ days)
              </SubmitButton>
            </form>
          </>
        )}
      </div>
      {chatRows.length === 0 ? (
        <EmptyState>
          {archived ? 'No archived chats.' : 'No chats yet — start one with “New chat”.'}
        </EmptyState>
      ) : (
        <>
          {totalInScope > chatRows.length ? (
            <p className="mt-6 text-xs text-muted">
              Showing the {chatRows.length} most recent of {totalInScope} chats. Archiving inactive
              chats trims this list.
            </p>
          ) : null}
          {/* One card holding divided rows, the same shape the Activity list
              uses — fifty separate slabs made a plain list of chats look far
              heavier than it is, and gave the scroll-reveal fifty animations to
              drive instead of one. */}
          {/* Use available inline space relative to text size: enlarged type
              needs a full text row before the housekeeping action. */}
          <ul className={`${cardShellClass} mt-6 @container/history`}>
            {chatRows.map((conversation, index) => {
              // Unread = activity since the owner last opened the thread (the
              // read stamp lives on the conversation). A never-opened thread
              // falls back to its creation time so history doesn't light up at
              // once.
              const unread =
                !archived &&
                conversation.updatedAt > (conversation.lastReadAt ?? conversation.createdAt);
              return (
                <li
                  key={conversation.id}
                  className={`grid min-w-0 grid-cols-1 items-center gap-[min(0.5rem,8px)] p-[min(0.5rem,8px)] @min-[16rem]/history:grid-cols-[minmax(0,1fr)_auto] @min-[16rem]/history:gap-2 @min-[16rem]/history:p-2 ${
                    index > 0 ? 'border-t border-edge' : ''
                  }`}
                >
                  <Link
                    href={`/chat/${conversation.id}`}
                    data-mobile-touch-target="true"
                    className={`mobile-touch-target flex min-w-0 items-start gap-[min(0.75rem,12px)] rounded-xl p-[min(0.5rem,8px)] @min-[16rem]/history:items-center @min-[16rem]/history:gap-3 @min-[16rem]/history:p-2 motion-safe:transition-colors hover:bg-sunken/65 ${
                      conversation.isPrimary ? '@min-[16rem]/history:col-span-2' : ''
                    }`}
                  >
                    <span className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-sunken text-muted [--spacing:min(0.25rem,4px)] @min-[16rem]/history:[--spacing:0.25rem]">
                      <MessageSquareText className="size-4" aria-hidden="true" />
                      {unread ? (
                        <span
                          role="img"
                          aria-label="Unread activity"
                          title="Unread activity"
                          className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-accent ring-2 ring-raised"
                        />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-[min(0.5rem,8px)] @min-[16rem]/history:flex-nowrap @min-[16rem]/history:gap-2">
                        <span
                          className={`min-w-0 max-w-full hyphens-auto [overflow-wrap:anywhere] @min-[16rem]/history:truncate @min-[16rem]/history:[overflow-wrap:normal] ${cardTitleClass}`}
                        >
                          {conversation.title && conversation.title !== 'Untitled'
                            ? conversation.title
                            : 'New conversation'}
                        </span>
                        {conversation.isPrimary ? (
                          <Badge tone="neutral" size="xs" uppercase>
                            Main
                          </Badge>
                        ) : activeConversationIds.has(conversation.id) ? (
                          // Same word and tone the goal cards use for live work.
                          <Badge tone="accent" size="xs">
                            Working
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        Last active {relativeTime(conversation.updatedAt, now)}
                      </span>
                    </span>
                  </Link>
                  {conversation.isPrimary ? null : archived ? (
                    <form
                      action={restoreConversation.bind(null, conversation.id)}
                      className="min-w-0 max-w-full justify-self-start [--spacing:min(0.25rem,4px)] @min-[16rem]/history:[--spacing:0.25rem]"
                    >
                      <SubmitButton variant="outline" size="sm" pendingLabel="Restoring…">
                        Restore
                      </SubmitButton>
                    </form>
                  ) : activeConversationIds.has(conversation.id) ? null : (
                    <form
                      action={archiveConversation.bind(null, conversation.id)}
                      className="min-w-0 max-w-full justify-self-start [--spacing:min(0.25rem,4px)] @min-[16rem]/history:[--spacing:0.25rem]"
                    >
                      <SubmitButton variant="outline" size="sm" pendingLabel="Archiving…">
                        Archive
                      </SubmitButton>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </PageShell>
  );
}

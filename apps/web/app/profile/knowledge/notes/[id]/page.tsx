import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MemoryNavigation } from '@/app/profile/memory-navigation';
import { requireOwner } from '@/auth';
import { memoryNoteReturnTo } from '@/lib/memory-note-context';
import { ownerEditorAvailability } from '@/lib/owner-editor-availability';
import {
  loadOwnerMemoryEditorRecoverySession,
  loadOwnerMemoryEditorView,
} from '@/lib/owner-memory-editor-server';
import { ownerMemoryReadOnlyMessage } from '@/lib/owner-memory-editor-view';
import { Badge, btn, cardShellClass, PageHeader, PageShell } from '@/lib/ui';
import { MissingSavedNoteRecovery, OwnerMemoryEditor } from './owner-memory-editor';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Saved note' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function verifiedSourceHref(value: string | undefined) {
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  return ['/tasks/', '/emails/', '/imports/'].some((prefix) => value.startsWith(prefix))
    ? value
    : null;
}
export default async function SavedNotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const session = await requireOwner();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const back =
    memoryNoteReturnTo((await searchParams).returnTo) ?? '/profile/knowledge?view=library';
  let view: Awaited<ReturnType<typeof loadOwnerMemoryEditorView>>;
  try {
    view = await loadOwnerMemoryEditorView(id, session.formSessionScope);
  } catch {
    return (
      <PageShell size="reading">
        <PageHeader back={{ href: back, label: 'Memory' }} title="Saved note" />
        <MemoryNavigation current="notes" />
        <p role="status" className="mt-4 text-sm text-muted">
          This saved note could not be checked. Return to Memory and try again.
        </p>
        <Link href={back} className={`${btn.outline} mt-4`}>
          Return to Memory
        </Link>
      </PageShell>
    );
  }
  if (!view) {
    let recoverySession: Awaited<ReturnType<typeof loadOwnerMemoryEditorRecoverySession>> = null;
    try {
      recoverySession = await loadOwnerMemoryEditorRecoverySession(session.formSessionScope);
    } catch {
      // The missing-note shell remains useful even when receipt lookup is unavailable.
    }
    return (
      <PageShell size="reading">
        <PageHeader back={{ href: back, label: 'Memory' }} title="Saved note unavailable" />
        <MemoryNavigation current="notes" />
        <section className={`${cardShellClass} mt-5 grid gap-3 p-4 sm:p-5`}>
          <p className="text-sm text-muted">This saved note could not be found.</p>
          <MissingSavedNoteRecovery memoryId={id} session={recoverySession} returnHref={back} />
        </section>
      </PageShell>
    );
  }
  const { snapshot } = view;
  const editorAvailability = ownerEditorAvailability({
    formSessionScope: session.formSessionScope,
    editorAvailable: Boolean(view.grant),
    currentPath: `/profile/knowledge/notes/${id}`,
  });
  const sourceHref = verifiedSourceHref(snapshot.sourceHref);
  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: back, label: 'Memory' }}
        title="Saved note"
        intro="Review the saved information and its source before making a correction."
      />
      <MemoryNavigation current="notes" />
      <article className={`${cardShellClass} mt-5 p-4 sm:p-5`}>
        {snapshot.ownerCorrection ? (
          <Badge tone="accent" size="xs">
            Owner-corrected saved note
          </Badge>
        ) : null}
        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-strong">
          {snapshot.content}
        </p>
        <p className="mt-3 text-sm text-muted">{snapshot.sourceLabel}</p>
        {snapshot.ownerCorrection ? (
          <p className="mt-2 text-sm text-muted">
            The saved provenance records where this note came from. It does not mean the original
            source contains your corrected wording.
          </p>
        ) : null}
        {sourceHref ? (
          <Link href={sourceHref} className="mt-3 inline-block text-sm text-accent underline">
            Open source
          </Link>
        ) : (
          <p className="mt-3 text-sm text-muted">
            A direct source link is unavailable for this saved note.
          </p>
        )}
        {!view.grant ? (
          <p role="status" className="mt-4 text-sm text-muted">
            {editorAvailability.kind === 'sign_in_again'
              ? editorAvailability.message
              : ownerMemoryReadOnlyMessage(view.unavailableReason)}
          </p>
        ) : null}
        <OwnerMemoryEditor
          key={`${snapshot.ownerId}:${snapshot.memoryId}`}
          view={view}
          returnHref={back}
        />
      </article>
    </PageShell>
  );
}

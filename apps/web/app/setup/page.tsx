import { notFound, redirect } from 'next/navigation';
import { authMode, isAuthed } from '@/auth';
import { PageHeader, PageShell } from '@/lib/ui';
import { SetupClient } from './setup-client';

export const metadata = { title: 'Secure your assistant' };
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  if (authMode !== 'passkey') notFound();
  if (await isAuthed()) redirect('/security');
  return (
    <PageShell size="reading">
      <div className="grid min-w-0 w-full max-w-lg grid-cols-[minmax(0,1fr)] gap-6">
        <PageHeader
          title="Secure your assistant"
          intro="Your one-time setup link lets you become the owner of this installation."
        />
        <SetupClient />
      </div>
    </PageShell>
  );
}

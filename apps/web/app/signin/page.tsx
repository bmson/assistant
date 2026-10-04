import { notFound, redirect } from 'next/navigation';
import { authMode, isAuthed } from '@/auth';
import { PageHeader, PageShell } from '@/lib/ui';
import { SignInClient } from './signin-client';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  if (authMode !== 'passkey') notFound();
  if (await isAuthed()) redirect('/settings');
  return (
    <PageShell size="reading">
      <div className="grid min-w-0 w-full max-w-lg grid-cols-[minmax(0,1fr)] gap-6">
        <PageHeader
          title="Sign in"
          intro="Use your owner passkey to open this private assistant."
        />
        <SignInClient />
      </div>
    </PageShell>
  );
}

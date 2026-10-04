import { loadConfig } from '@assistant/config';
import { notFound } from 'next/navigation';
import { authMode, requireOwner } from '@/auth';
import { PageHeader, PageShell } from '@/lib/ui';
import { SecurityClient } from './security-client';

export const metadata = { title: 'Security' };
export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  if (authMode !== 'passkey') notFound();
  await requireOwner();
  return (
    <PageShell size="reading" className="grid gap-6">
      <PageHeader
        title="Security"
        intro="Control who can access your assistant and how you get back in."
        back={{ href: '/settings', label: 'Settings' }}
      />
      <SecurityClient serverUrl={loadConfig().AUTH_URL} />
    </PageShell>
  );
}

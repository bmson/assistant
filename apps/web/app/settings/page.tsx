import { existsSync } from 'node:fs';
import { envFile, loadConfig } from '@assistant/config';
import { headers } from 'next/headers';
import Link from 'next/link';
import { SecurityClient } from '@/app/security/security-client';
import { authMode, requireOwner } from '@/auth';
import { getMobileAccessToken } from '@/lib/mobile-access-token';
import { btn, Card, PageHeader, PageShell, SectionHeading } from '@/lib/ui';
import { MobileTokenPanel } from './mobile-token';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await requireOwner();
  const config = loadConfig();
  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
  const proto = requestHeaders.get('x-forwarded-proto') ?? 'http';
  const serverUrl = host ? `${proto}://${host}` : config.AUTH_URL;
  const token = authMode === 'passkey' ? '' : await getMobileAccessToken();
  return (
    <PageShell size="reading" className="grid gap-8">
      <PageHeader
        title="Settings"
        intro="Connect the mobile app, then manage your assistant from your phone."
      />
      {authMode === 'passkey' ? (
        <>
          <SecurityClient serverUrl={serverUrl} mode="pairing" />
          <section className="grid gap-4 border-t border-edge/70 pt-8 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="grid gap-2">
              <SectionHeading title="Access and recovery" />
              <p className="max-w-[60ch] text-sm leading-6 text-muted">
                Manage your passkeys, save a recovery code, or sign out of browser sessions.
              </p>
            </div>
            <div>
              <Link href="/security" className={btn.outline}>
                Manage security
              </Link>
            </div>
          </section>
        </>
      ) : (
        <section>
          <SectionHeading title="Mobile app connection" />
          <Card className="mt-4">
            <MobileTokenPanel
              maskedToken={token ? `${token.slice(0, 6)}…${token.slice(-4)}` : null}
              serverUrl={serverUrl}
              canRotate={existsSync(envFile) || Boolean(config.GCP_PROJECT)}
            />
          </Card>
        </section>
      )}
    </PageShell>
  );
}

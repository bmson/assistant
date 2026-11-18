import { existsSync } from 'node:fs';
import { envFile, loadConfig } from '@assistant/config';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ComponentProps } from 'react';
import { SecurityClient } from '@/app/security/security-client';
import { authMode, requireOwner } from '@/auth';
import { getMobileAccessToken, hasMobileTokenRotationCapability } from '@/lib/mobile-access-token';
import { getWorkspaceSettings, listOwnerMcpConnections } from '@/lib/server';
import { projectStandingApprovalPolicy } from '@/lib/standing-approval-view';
import { btn, Card, PageHeader, PageShell, SectionHeading } from '@/lib/ui';
import { McpConnectionsPanel } from './mcp-connections';
import { MobileTokenPanel } from './mobile-token';
import { StandingApprovals } from './standing-approvals';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const owner = await requireOwner();
  const config = loadConfig();
  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
  const proto = requestHeaders.get('x-forwarded-proto') ?? 'http';
  const serverUrl = host ? `${proto}://${host}` : config.AUTH_URL;
  const token = authMode === 'passkey' ? '' : await getMobileAccessToken();
  const settings = await getWorkspaceSettings();
  let mcpConnections: ComponentProps<typeof McpConnectionsPanel>['connections'] | null = null;
  try {
    mcpConnections = await listOwnerMcpConnections();
  } catch {
    // An unreadable inventory must not be presented as an empty connection list.
  }
  const standingPolicies = settings.policies.map((policy) =>
    projectStandingApprovalPolicy(policy, config.PHONE_CALL_TO_OWNER_GRANT_ENABLED),
  );
  return (
    <PageShell size="reading" className="grid gap-8">
      <PageHeader title="Settings" intro="Connect your iPhone and manage your assistant account." />
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
              canRotate={existsSync(envFile) || hasMobileTokenRotationCapability(config)}
            />
          </Card>
        </section>
      )}
      <section id="connected-tools" className="grid gap-4">
        <SectionHeading title="Connected tools" />
        {mcpConnections ? (
          <McpConnectionsPanel key={owner.user?.email} connections={mcpConnections} />
        ) : (
          <p role="alert" className="text-sm text-muted">
            Couldn’t load connected tools. Refresh this page to check them before making changes.
          </p>
        )}
      </section>
      <StandingApprovals policies={standingPolicies} />
    </PageShell>
  );
}

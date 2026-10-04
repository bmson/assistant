import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

/** Every isolated hydration root keeps the server's useId prefix. */
function ClientFixture({
  name,
  children,
  ...attributes
}: { name: string; children: ReactNode } & { [key: `data-${string}`]: string }) {
  return (
    <div
      {...attributes}
      data-qa-client={name}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: synthetic markup rendered by React in this test
      dangerouslySetInnerHTML={{
        __html: renderToString(children, { identifierPrefix: `qa-${name}-` }),
      }}
    />
  );
}

// Entirely synthetic owner-console pages. Never use live records or credentials.
const fixture = vi.hoisted(() => ({ path: '/settings', mode: 'passkey', canRotate: false }));
vi.mock('@/auth', () => ({
  get authMode() {
    return fixture.mode;
  },
  requireOwner: async () => ({}),
  isAuthed: async () => !['/signin', '/setup'].includes(fixture.path),
}));
vi.mock('next/navigation', () => ({ usePathname: () => fixture.path }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'assistant.example', 'x-forwarded-proto': 'https' }),
}));
vi.mock('@assistant/config', () => ({
  envFile: '/tmp/assistant-qa-no-secrets',
  loadConfig: () => ({
    AUTH_URL: 'https://assistant.example',
    ...(fixture.canRotate ? { GCP_PROJECT: 'synthetic-preview' } : {}),
  }),
}));
vi.mock('@/lib/mobile-access-token', () => ({
  getMobileAccessToken: async () => 'synthetic-token',
}));
vi.mock('@/app/settings/actions', () => ({
  rotateMobileToken: async () => ({ error: 'Synthetic preview only.' }),
}));
vi.mock('@/lib/task-activity', () => ({
  listTaskActivity: async () => ({
    items: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Prepare the family trip',
        type: 'chat',
        status: 'running',
        progress:
          'Comparing the dates you gave me with the hotel availability. I will bring you two options.',
        updatedAt: new Date('2026-10-02T17:30:00Z'),
        spentUsd: '0.018',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        title: 'Send the revised meeting agenda',
        type: 'chat',
        status: 'waiting_approval',
        progress: 'The draft is ready for you to review before I send it.',
        updatedAt: new Date('2026-10-02T16:30:00Z'),
        spentUsd: '0.005',
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        title: 'Find the receipt for the replacement headphones',
        type: 'chat',
        status: 'done',
        progress: 'Filed the receipt with your order card.',
        updatedAt: new Date('2026-10-02T15:30:00Z'),
        spentUsd: '0.002',
      },
    ],
  }),
}));
vi.mock('@/lib/audit-investigation', () => ({
  getAuditInvestigation: async () => ({
    task: {
      title: 'Prepare the family trip',
      type: 'chat',
      status: 'running',
      attempt: 2,
      spentUsd: '0.018',
      progress: 'Comparing hotel availability.',
    },
    investigationPrompt:
      'Investigate this synthetic trip-planning record and explain the evidence behind the result.',
    evidenceNotes: [
      'This preview contains synthetic records only.',
      'Missing capture does not prove that no call occurred.',
    ],
    sections: [
      {
        name: 'toolCalls',
        entries: [
          {
            id: 'preview-tool-1',
            at: '2026-10-02T17:30:00Z',
            fields: {
              toolName: { text: 'calendar.list_events' },
              status: { text: 'succeeded' },
              result: { text: '{ "events": [], "timeZone": "America/Los_Angeles" }' },
            },
          },
        ],
        nextCursor: null,
      },
    ],
  }),
}));
vi.mock('@/app/security/security-client', async () => {
  const actual = await vi.importActual<typeof import('./security/security-client')>(
    './security/security-client',
  );
  return {
    SecurityClient: (props: { serverUrl: string; mode?: 'all' | 'pairing' }) => (
      <ClientFixture
        name="security"
        data-server-url={props.serverUrl}
        data-security-mode={props.mode ?? 'all'}
      >
        <actual.SecurityClient {...props} />
      </ClientFixture>
    ),
  };
});
vi.mock('./appearance-control', async () => {
  const actual =
    await vi.importActual<typeof import('./appearance-control')>('./appearance-control');
  return {
    ...actual,
    AppearanceMenu: () => (
      <ClientFixture name="appearance">
        <actual.AppearanceMenu />
      </ClientFixture>
    ),
  };
});
vi.mock('@/app/settings/mobile-token', async () => {
  const actual =
    await vi.importActual<typeof import('./settings/mobile-token')>('./settings/mobile-token');
  return {
    MobileTokenPanel: (props: {
      maskedToken: string | null;
      serverUrl: string;
      canRotate: boolean;
    }) => (
      <ClientFixture
        name="mobile-token"
        data-server-url={props.serverUrl}
        data-masked-token={props.maskedToken ?? ''}
        data-can-rotate={String(props.canRotate)}
      >
        <actual.MobileTokenPanel {...props} />
      </ClientFixture>
    ),
  };
});
vi.mock('@/app/signin/signin-client', async () => {
  const actual =
    await vi.importActual<typeof import('./signin/signin-client')>('./signin/signin-client');
  return {
    SignInClient: () => (
      <ClientFixture name="signin">
        <actual.SignInClient />
      </ClientFixture>
    ),
  };
});
vi.mock('@/app/setup/setup-client', async () => {
  const actual =
    await vi.importActual<typeof import('./setup/setup-client')>('./setup/setup-client');
  return {
    SetupClient: () => (
      <ClientFixture name="setup">
        <actual.SetupClient />
      </ClientFixture>
    ),
  };
});

vi.mock('@/app/audit/[id]/investigation-brief', async () => {
  const actual = await vi.importActual<typeof import('./audit/[id]/investigation-brief')>(
    './audit/[id]/investigation-brief',
  );
  return {
    InvestigationBrief: (props: { prompt: string }) => (
      <ClientFixture name="investigation" data-prompt={props.prompt}>
        <actual.InvestigationBrief {...props} />
      </ClientFixture>
    ),
  };
});

import { Badge, btn, InfoGrid, InfoItem, PageHeader, Panel } from '@/lib/ui';
import AuditDetailPage from './audit/[id]/page';
import AuditPage from './audit/page';
import RouteError from './error';
import GlobalError from './global-error';
import RootLayout from './layout';
import NotFound from './not-found';
import SecurityPage from './security/page';
import SettingsPage from './settings/page';
import SetupPage from './setup/page';
import SignInPage from './signin/page';

it('renders the six reachable console surfaces from isolated synthetic data', async () => {
  const directory = process.env.WEB_EXPERIENCE_QA_DIR;
  const pages = [
    { name: 'settings', path: '/settings', render: () => SettingsPage() },
    { name: 'settings-token', path: '/settings', mode: 'google', render: () => SettingsPage() },
    {
      name: 'settings-token-rotate',
      path: '/settings',
      mode: 'google',
      canRotate: true,
      render: () => SettingsPage(),
    },
    { name: 'security', path: '/security', render: () => SecurityPage() },
    { name: 'signin', path: '/signin', render: () => SignInPage() },
    { name: 'setup', path: '/setup', render: () => SetupPage() },
    { name: 'not-found', path: '/preview/not-found', render: () => NotFound() },
    {
      name: 'route-error',
      path: '/preview/route-error',
      render: () => (
        <ClientFixture name="route-error">
          <RouteError error={new Error('Synthetic error')} retry={() => {}} />
        </ClientFixture>
      ),
    },
    {
      name: 'audit',
      path: '/audit',
      render: () => AuditPage({ searchParams: Promise.resolve({}) }),
    },
    {
      name: 'audit-detail',
      path: '/audit/00000000-0000-4000-8000-000000000001',
      render: () =>
        AuditDetailPage({
          params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }),
          searchParams: Promise.resolve({ section: 'toolCalls' }),
        }),
    },
  ];
  for (const page of pages) {
    fixture.path = page.path;
    fixture.mode = 'mode' in page ? String(page.mode) : 'passkey';
    fixture.canRotate = 'canRotate' in page && page.canRotate === true;
    const html = renderToString(await RootLayout({ children: await page.render() }));
    expect(html).toContain('id="main-content"');
    expect(html).toContain('Skip to content');
    expect(html).toContain('<h1');
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, `${page.name}.html`), `<!doctype html>${html}`);
    }
  }
  const fallback = renderToString(
    <GlobalError error={new Error('Synthetic error')} retry={() => {}} />,
  );
  expect(fallback).toContain('Couldn’t load the assistant');
  if (directory)
    writeFileSync(path.join(directory, 'global-error.html'), `<!doctype html>${fallback}`);
  if (directory) {
    fixture.path = '/preview/long-content';
    fixture.mode = 'passkey';
    const stress = renderToString(
      await RootLayout({
        children: (
          <div className="grid gap-6">
            <PageHeader
              title="Review the travel arrangements for our October family reunion"
              intro="Keep the important details readable, even when names are long and text is enlarged."
              actions={
                <button type="button" className={btn.primary}>
                  Review proposed arrangements
                </button>
              }
            />
            <Panel className="grid gap-4">
              <Badge tone="amber">Needs a decision about the revised arrival time</Badge>
              <InfoGrid columns={3}>
                <InfoItem label="Reservation">
                  FAMILYREUNIONOCTOBER2026RESERVATIONREFERENCE
                </InfoItem>
                <InfoItem label="Location">
                  A hotel with a long name near the central railway station
                </InfoItem>
                <InfoItem label="Next step">Confirm the details before booking</InfoItem>
              </InfoGrid>
            </Panel>
          </div>
        ),
      }),
    );
    writeFileSync(path.join(directory, 'long-content.html'), `<!doctype html>${stress}`);
  }
});

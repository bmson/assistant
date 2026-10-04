import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { authMode, isAuthed } from '@/auth';
import { appearanceScript } from '@/lib/appearance';
import { focusRing } from '@/lib/ui';
import { AdminNavigation } from './admin-navigation';
import { AppearanceMenu } from './appearance-control';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Assistant settings', template: '%s · Assistant' },
  description: 'Mobile access and diagnostics for your assistant.',
  icons: { icon: '/icon.svg' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const owner = await isAuthed();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static no-flash theme script */}
        <script dangerouslySetInnerHTML={{ __html: appearanceScript }} />
      </head>
      <body className="min-h-dvh bg-surface font-sans text-strong antialiased">
        <a
          href="#main-content"
          className={`sr-only fixed left-4 top-4 z-50 rounded-lg bg-raised px-4 py-3 text-sm font-medium focus:not-sr-only ${focusRing}`}
        >
          Skip to content
        </a>
        {authMode === 'dev-bypass' ? (
          <p className="bg-amber-100 p-2 text-center text-xs text-amber-900">
            Development mode — authentication disabled
          </p>
        ) : null}
        <header className="border-b border-edge bg-raised/50">
          <div className="page-gutter mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-8 gap-y-1 py-2 sm:py-3">
            <Link
              href="/settings"
              className={`inline-flex min-h-11 items-center gap-2.5 rounded-lg text-lg font-semibold tracking-tight ${focusRing}`}
            >
              <svg aria-hidden="true" viewBox="0 0 1024 1024" className="size-7 shrink-0">
                <rect rx="224" width="1024" height="1024" fill="#217A4B" />
                <path
                  d="M628 304V484C628 584 568 652 480 652C384 652 316 580 316 484C316 388 384 316 480 316C568 316 628 384 628 484V606Q628 652 658 652"
                  fill="none"
                  stroke="#F4FAF5"
                  strokeWidth="94"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  transform="translate(512 546) scale(1.24) translate(-486 -512)"
                />
              </svg>
              Assistant
            </Link>
            {owner ? (
              <div className="order-3 min-w-0 w-full sm:order-none sm:w-auto sm:flex-1">
                <AdminNavigation passkey={authMode === 'passkey'} />
              </div>
            ) : null}
            <AppearanceMenu />
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="page-gutter mx-auto min-w-0 max-w-4xl py-7 sm:py-10"
        >
          {children}
        </main>
      </body>
    </html>
  );
}

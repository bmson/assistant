'use client';

import { useEffect } from 'react';
import { appearanceScript, applyAppearance, readAppearance } from '@/lib/appearance';
import { btn, PageHeader } from '@/lib/ui';
import './globals.css';

/** The page boundary cannot catch a failure in the root authentication/layout. */
export default function GlobalError({ retry }: { error: Error; retry: () => void }) {
  useEffect(() => applyAppearance(readAppearance()), []);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Assistant unavailable</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static shared no-flash theme script */}
        <script dangerouslySetInnerHTML={{ __html: appearanceScript }} />
      </head>
      <body className="min-h-dvh bg-surface font-sans text-strong antialiased">
        <main className="page-gutter mx-auto grid min-h-dvh max-w-xl content-center gap-6 py-12">
          <PageHeader
            title="Couldn’t load the assistant"
            intro="The server could not load this page. Check the connection and try again."
          />
          <div>
            <button type="button" className={btn.primary} onClick={retry}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}

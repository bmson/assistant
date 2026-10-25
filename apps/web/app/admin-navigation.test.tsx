import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const path = vi.hoisted(() => ({ value: '/chat' }));
vi.mock('next/navigation', () => ({ usePathname: () => path.value }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...props }: Record<string, unknown>) =>
      React.createElement('a', { href, ...props }, children as never),
  };
});

import { AdminNavigation } from './admin-navigation';

describe('owner browser navigation', () => {
  it('exposes Chat and marks the current conversation as active', () => {
    const html = renderToStaticMarkup(createElement(AdminNavigation, { passkey: false }));
    expect(html).toContain('aria-label="Main navigation"');
    expect(html).toContain('href="/chat"');
    expect(html).toMatch(/href="\/chat" aria-current="page"[^>]*>Chat<\/a>/);
    expect(html).toContain('href="/settings"');
    expect(html).toContain('href="/audit"');
    expect(html).not.toContain('href="/security"');
  });

  it('keeps passkey security visible alongside Chat', () => {
    const html = renderToStaticMarkup(createElement(AdminNavigation, { passkey: true }));
    expect(html).toContain('href="/chat"');
    expect(html).toContain('href="/security"');
  });
  it.each([
    '/profile',
    '/profile/knowledge',
    '/people',
    '/people/00000000-0000-4000-8000-000000000001',
  ])('marks only Memory active for %s', (pathname) => {
    path.value = pathname;
    const html = renderToStaticMarkup(createElement(AdminNavigation, { passkey: false }));
    expect(html).toMatch(/href="\/profile" aria-current="page"/);
    expect(html).not.toMatch(/href="\/chat" aria-current/);
    path.value = '/chat';
  });
});

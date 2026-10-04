import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// This repo is also checked out as git worktrees, so Next sees several
// lockfiles and guesses which one is the workspace root — landing on the main
// checkout even when the build is running inside a worktree. Point it at this
// app's own monorepo root instead of leaving it to inference.
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: workspaceRoot,
  transpilePackages: [
    '@assistant/application',
    '@assistant/config',
    '@assistant/db',
    '@assistant/core',
    '@assistant/tools',
  ],
  // unauthorized() in auth.ts renders app/unauthorized.tsx with a real 401 status.
  //
  // Deliberately NOT setting experimental.viewTransition: it only takes effect
  // in Next's experimental app-page runtime, which requires React's experimental
  // channel. On React 19.2 stable the flag is accepted but the router never
  // calls document.startViewTransition, so it buys nothing. Route entry stays
  // with the CSS animation in template.tsx.
  experimental: { authInterrupts: true },
  async redirects() {
    return [{ source: '/', destination: '/settings', permanent: false }];
  },
  async headers() {
    // The one non-self origin is jelly-ui.com, the nav-widget script loaded in
    // app/layout.tsx. Everything else the page executes or fetches is served
    // from this deployment, and this policy is what enforces that: a script
    // tag injected from anywhere else simply will not run.
    //
    // 'unsafe-inline' for scripts is required by Next's app-router bootstrap
    // (inline flight-data pushes) plus the two no-flash <script> blocks in the
    // layout; for styles it covers Tailwind's style attributes. Tightening to
    // nonces needs per-request middleware — revisit if the threat model grows.
    const contentSecurityPolicy = [
      "default-src 'self'",
      // Next's dev server serves webpack's eval-based module wrappers and React
      // Refresh; without 'unsafe-eval' in development no client JS runs at all,
      // so the page never hydrates. Production keeps the tighter policy.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''} https://jelly-ui.com`,
      "style-src 'self' 'unsafe-inline' https://jelly-ui.com",
      // Auth.js renders the Google provider's official icon from its CDN.
      "img-src 'self' data: blob: https://authjs.dev",
      "font-src 'self' data:",
      // script-src covers jelly-ui's module imports; connect-src covers any
      // fetch() the widget makes back to its own origin for assets.
      "connect-src 'self' https://jelly-ui.com",
      "object-src 'none'",
      "base-uri 'self'",
      // Auth.js posts to this app and then redirects that form navigation to
      // Google's OAuth endpoint. form-action applies across that redirect, so
      // both origins must be allowed for Google sign-in to work.
      "form-action 'self' https://bot.bmson.com https://accounts.google.com",
      "frame-ancestors 'none'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
          },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
  // Workspace packages are NodeNext TS sources with `.js` specifiers — map them
  // back to .ts. This is also why the build stays on webpack (`next build
  // --webpack`): verified 2026-07 that Turbopack fails on every workspace
  // import ("Can't resolve '../chat.js'") because it has no extensionAlias
  // equivalent — turbopack.resolveAlias maps names, not extensions. Re-try
  // when Turbopack learns extension aliasing or the packages ship built JS.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default nextConfig;

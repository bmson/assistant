import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { refreshRepairSourceSnapshot } from './repair-source-snapshot.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const base = `${JSON.stringify(
  {
    format: 1,
    purpose: 'trusted evidence',
    runtimeSources: { 'apps/web/lib/server.ts': digest('old') },
    webApiRouteCount: 1,
    routes: {
      'apps/web/app/api/example/route.ts': { methods: ['GET'], sha256: digest('old route') },
    },
    releaseContracts: { mustStay: 'unchanged' },
  },
  null,
  2,
).replace('"methods": [\n        "GET"\n      ]', '"methods": ["GET"]')}\n`;

it('updates only the actual source digest in the real repository snapshot and preserves its exact formatting', () => {
  const current = readFileSync(
    new URL('../../../../docs/runtime-support-matrix.generated.json', import.meta.url),
    'utf8',
  );
  const old = JSON.parse(current).runtimeSources['apps/web/lib/server.ts'];
  expect(
    refreshRepairSourceSnapshot(current, [
      { path: 'apps/web/lib/server.ts', text: 'synthetic changed source' },
    ]),
  ).toBe(current.replace(old, digest('synthetic changed source')));
});
it('derives route methods, digests, ordering and counts for additions, edits and removals', () => {
  const text = 'export async function POST() {}\nexport const GET = () => {};';
  const updated = refreshRepairSourceSnapshot(base, [
    { path: 'apps/web/app/api/example/route.ts', text: null },
    { path: 'apps/web/app/api/new/route.ts', text },
    { path: 'apps/web/app/api/another/route.ts', text: 'export function DELETE() {}' },
  ]);
  if (!updated) throw new Error('Expected updated route evidence');
  const result = JSON.parse(updated);
  expect(result.routes).toEqual({
    'apps/web/app/api/another/route.ts': {
      methods: ['DELETE'],
      sha256: digest('export function DELETE() {}'),
    },
    'apps/web/app/api/new/route.ts': { methods: ['GET', 'POST'], sha256: digest(text) },
  });
  expect(result.webApiRouteCount).toBe(2);
  expect(result.releaseContracts).toEqual({ mustStay: 'unchanged' });
});
it('does not create metadata changes for unrelated source or identical bytes', () => {
  expect(
    refreshRepairSourceSnapshot(base, [
      { path: 'apps/web/lib/server.ts', text: 'old' },
      { path: 'packages/application/src/example.ts', text: 'source' },
    ]),
  ).toBeNull();
});
it('refuses deletion of a required runtime source or invalid evidence', () => {
  expect(() =>
    refreshRepairSourceSnapshot(base, [{ path: 'apps/web/lib/server.ts', text: null }]),
  ).toThrow('cannot be deleted');
  expect(() => refreshRepairSourceSnapshot('{}', [])).toThrow();
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { proxy } from './proxy';

const config = vi.hoisted(() => ({ PERSISTENCE_DRIVER: 'firestore', RESTORE_REHEARSAL: false }));
vi.mock('@assistant/config', () => ({ loadConfig: () => config }));

const app = fileURLToPath(new URL('./app/api/mobile/v1/', import.meta.url));
const ios = fileURLToPath(new URL('../ios/Assistant/', import.meta.url));
const client = readFileSync(join(ios, 'Networking/APIClient.swift'), 'utf8');
const models = readFileSync(join(ios, 'Models/APIModels.swift'), 'utf8');
const id = 'bbbbaaaa-0000-5000-8000-bbbbaaaabbbb';
const digest = 'c'.repeat(64);
const sections = models.match(/enum WorkspacePageSection[^{]*\{([^}]+)\}/)?.[1] ?? '';
const sectionNames = [...sections.matchAll(/^\s*case (.+)$/gm)].flatMap(([, entries]) =>
  entries.split(',').map((entry) => entry.match(/"([^"]+)"/)?.[1] ?? entry.trim()),
);

const paths = new Set([
  ...[...client.matchAll(/"api\/mobile\/v1\/([^"]+)"/g)].map((match) => match[1]),
  ...[
    ...client.matchAll(/(?:postWorkspaceAction|postCollectionAction|setEnabled)\(path: "([^"]+)"/g),
  ].map((match) => match[1]),
]);
paths.delete('\\(path)'); // The three Swift helper call sites above supply the complete suffix.

const handlers = readdirSync(app, { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('/route.ts'))
  .map((file) => ({
    path: file.slice(0, -'/route.ts'.length).replace(/\[[^\]]+\]/g, '[]'),
    methods: [
      ...readFileSync(join(app, file), 'utf8').matchAll(
        /export (?:async function|const) (GET|POST|PATCH|PUT|DELETE)\b/g,
      ),
    ].map((m) => m[1]),
  }));

describe('native routes reach their Firestore handlers', () => {
  it('reads the phone workspace sections from its model', () => {
    expect(sectionNames).toContain('import-files');
  });
  for (const path of paths) {
    it(path, () => {
      const handler = handlers.find((route) => route.path === path.replace(/\\\([^)]+\)/g, '[]'));
      expect(handler?.methods.length, path).toBeGreaterThan(0);
      const urls = path.includes('\\(section.rawValue)')
        ? sectionNames.map((section) => path.replace('\\(section.rawValue)', section))
        : [path.replace('\\(surfaceKey)', digest).replace(/\\\([^)]+\)/g, id)];
      for (const url of urls) {
        for (const method of handler?.methods ?? []) {
          const response = proxy(
            new NextRequest('https://assistant.test/api/mobile/v1/' + url, { method }),
          );
          expect(response.headers.get('x-middleware-next'), method + ' /' + url).toBe('1');
        }
      }
    });
  }
});

it('admits exact recall and note methods and preserves restore mode', () => {
  const note = '/api/mobile/v1/memory/' + id;
  const source = '/api/mobile/v1/recall/sources/' + digest;
  for (const [path, method] of [
    [source, 'DELETE'],
    [source + '0', 'GET'],
    [note + '/snapshot', 'POST'],
    [note + '/correction/authorize', 'GET'],
    [note + '/correction/' + id + '/apply', 'GET'],
    [note + '/correction/' + id + '/status', 'POST'],
    [note + '/correction/invalid/apply', 'POST'],
    [note + '/correction/' + id + '/apply/other', 'POST'],
  ]) {
    expect(proxy(new NextRequest('https://assistant.test' + path, { method })).status).toBe(503);
  }
  config.RESTORE_REHEARSAL = true;
  try {
    expect(proxy(new NextRequest('https://assistant.test' + source)).status).toBe(503);
    expect(
      proxy(
        new NextRequest('https://assistant.test' + note + '/correction/authorize', {
          method: 'POST',
        }),
      ).status,
    ).toBe(503);
  } finally {
    config.RESTORE_REHEARSAL = false;
  }
});

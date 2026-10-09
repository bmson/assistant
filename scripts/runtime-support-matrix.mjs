#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'docs/runtime-support-matrix.generated.json');
const RUNTIME_SOURCES = [
  'packages/config/src/index.ts',
  'apps/agent/src/deps.ts',
  'apps/agent/src/index.ts',
  'apps/web/lib/server.ts',
  'apps/web/proxy.ts',
  'packages/db/drizzle/meta/_journal.json',
  'infra/gcp/release-contracts.json',
];
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

export async function buildRuntimeSupportSnapshot(root = ROOT) {
  const routeRoot = path.join(root, 'apps/web/app/api');
  const routes = {};
  for (const file of await walk(routeRoot)) {
    if (path.basename(file) !== 'route.ts') continue;
    const relative = path.relative(root, file).split(path.sep).join('/');
    const source = await readFile(file, 'utf8');
    const methods = new Set();
    for (const method of METHODS) {
      const escaped = method;
      const declaration = new RegExp(
        `export\\s+(?:async\\s+)?(?:function\\s+${escaped}\\b|const\\s+${escaped}\\b)`,
      );
      if (declaration.test(source)) methods.add(method);
    }
    routes[relative] = {
      methods: [...methods].sort(),
      sha256: sha256(source),
    };
  }

  const runtimeSources = {};
  for (const sourcePath of RUNTIME_SOURCES) {
    const source = await readFile(path.join(root, sourcePath), 'utf8');
    runtimeSources[sourcePath] = sha256(source);
  }
  const journal = JSON.parse(
    await readFile(path.join(root, 'packages/db/drizzle/meta/_journal.json'), 'utf8'),
  );
  const releaseContract = JSON.parse(
    await readFile(path.join(root, 'infra/gcp/release-contracts.json'), 'utf8'),
  );
  const latestMigration = journal.entries?.at(-1);
  const ordinal = /^([0-9]+)_/.exec(latestMigration?.tag ?? '');
  if (!latestMigration || !ordinal || Number(ordinal[1]) !== latestMigration.idx)
    throw new Error('The current migration journal does not have a checked release ordinal');
  const postgresSchemaVersion = Number(ordinal[1]);
  const components = Object.fromEntries(
    ['agent', 'web', 'browser', 'code', 'processor'].map((name) => {
      const contract = releaseContract.components?.[name];
      const schema = contract?.schema?.postgres;
      return [
        name,
        {
          apiContract: contract?.apiContract ?? null,
          peerApi: contract?.peerApi ?? null,
          postgresSchema: schema ?? null,
          currentPostgresSchemaCompatible:
            Number.isSafeInteger(schema?.min) &&
            Number.isSafeInteger(schema?.max) &&
            schema.min <= postgresSchemaVersion &&
            postgresSchemaVersion <= schema.max,
        },
      ];
    }),
  );
  return {
    format: 1,
    purpose:
      'Source composition and route drift evidence only; not a deployment or configured-runtime receipt.',
    runtimeSources,
    latestPostgresMigration: latestMigration.tag,
    postgresSchemaVersion,
    releaseContracts: components,
    agentWebSchemaCompatible:
      components.agent.currentPostgresSchemaCompatible &&
      components.web.currentPostgresSchemaCompatible,
    webApiRouteCount: Object.keys(routes).length,
    routes,
  };
}

function formatGeneratedSnapshot(snapshot) {
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  const biome = path.join(ROOT, 'node_modules/@biomejs/biome/bin/biome');
  const result = spawnSync(
    process.execPath,
    [biome, 'format', '--stdin-file-path', path.relative(ROOT, OUTPUT)],
    { input: serialized, encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Could not format runtime support matrix: ${result.stderr || result.error}`);
  }
  return result.stdout;
}

async function main() {
  const mode = process.argv[2];
  const snapshot = await buildRuntimeSupportSnapshot(ROOT);
  const serialized = formatGeneratedSnapshot(snapshot);
  if (mode === '--write') {
    await writeFile(OUTPUT, serialized);
    console.log(`Wrote ${path.relative(ROOT, OUTPUT)} (${snapshot.webApiRouteCount} API routes).`);
    return;
  }
  if (mode !== '--check') throw new Error('Usage: runtime-support-matrix.mjs --check|--write');
  if (!snapshot.agentWebSchemaCompatible) {
    console.error(
      `Release contract does not cover PostgreSQL schema ${snapshot.postgresSchemaVersion}; review component compatibility ranges before staging.`,
    );
    process.exitCode = 1;
    return;
  }
  const current = await readFile(OUTPUT, 'utf8').catch(() => '');
  if (current !== serialized) {
    console.error(
      'Runtime support matrix is stale; run `pnpm support:matrix:write` and review the diff.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Runtime composition and ${snapshot.webApiRouteCount} API route files match the checked snapshot.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Runtime support matrix check failed');
    process.exitCode = 1;
  });
}

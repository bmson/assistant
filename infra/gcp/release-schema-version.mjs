#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function deriveSchemaVersion(driver, journal, contract) {
  let version;
  if (driver === 'firestore') {
    version = contract.storageSchemaVersion?.firestore;
  } else if (driver === 'postgres') {
    const latest = journal?.entries?.at(-1);
    const ordinal = /^([0-9]+)_/.exec(latest?.tag ?? '');
    if (!latest || !ordinal || Number(ordinal[1]) !== latest.idx)
      throw new Error(
        'migration journal identity does not provide a reviewed PostgreSQL schema ordinal',
      );
    version = Number(ordinal[1]);
  } else {
    throw new Error(`unsupported storage driver ${driver}`);
  }
  if (!Number.isSafeInteger(version) || version < 0)
    throw new Error(`missing schema version for ${driver}`);
  for (const componentName of ['agent', 'web']) {
    const range = contract.components?.[componentName]?.schema?.[driver];
    if (
      !Number.isSafeInteger(range?.min) ||
      !Number.isSafeInteger(range?.max) ||
      range.min > range.max
    )
      throw new Error(`missing reviewed ${driver} schema range for ${componentName}`);
    if (version < range.min || version > range.max)
      throw new Error(
        `${componentName} compatibility range ${range.min}-${range.max} excludes ${driver} schema ${version}`,
      );
  }
  return version;
}

async function main() {
  const [driver, output = 'version'] = process.argv.slice(2);
  const root = new URL('../../', import.meta.url);
  const [journal, contract] = await Promise.all([
    readFile(new URL('packages/db/drizzle/meta/_journal.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('./release-contracts.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const version = deriveSchemaVersion(driver, journal, contract);
  if (output === 'version') {
    process.stdout.write(String(version));
    return;
  }
  const match = /^(agent|web)-range$/.exec(output);
  if (!match) throw new Error('output must be version, agent-range, or web-range');
  const range = contract.components[match[1]].schema[driver];
  process.stdout.write(`${range.min}\t${range.max}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

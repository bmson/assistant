#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveSchemaVersion } from './release-schema-version.mjs';

export function createManifest({
  release,
  imageRoot,
  selected,
  digests,
  contract,
  storageDriver = 'postgres',
  schemaVersion,
}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(release)) throw new Error('invalid release identifier');
  const components = {};
  for (const name of selected) {
    const digest = digests[name];
    const compatibility = contract.components?.[name];
    if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new Error(`missing immutable sha256 digest for ${name}`);
    if (!compatibility?.schema?.[storageDriver])
      throw new Error(`missing ${storageDriver} compatibility contract for ${name}`);
    components[name] = {
      image: `${imageRoot}/${name}@${digest}`,
      digest,
      apiContract: compatibility.apiContract,
      peerApi: structuredClone(compatibility.peerApi),
      schema: structuredClone(compatibility.schema[storageDriver]),
    };
  }
  return {
    format: 1,
    release,
    selected: [...selected],
    storageDriver,
    schemaVersion: schemaVersion ?? contract.storageSchemaVersion?.[storageDriver],
    components,
  };
}

export function validateManifest(
  manifest,
  { liveAgentApi, liveAgentSchemaMin, liveAgentSchemaMax } = {},
) {
  if (manifest?.format !== 1 || !Array.isArray(manifest.selected))
    throw new Error('unsupported release manifest');
  for (const name of manifest.selected) {
    const component = manifest.components?.[name];
    if (!component || !/^sha256:[a-f0-9]{64}$/.test(component.digest ?? ''))
      throw new Error(`component ${name} lacks an immutable digest`);
    if (
      manifest.schemaVersion < component.schema.min ||
      manifest.schemaVersion > component.schema.max
    )
      throw new Error(
        `${name} is incompatible with ${manifest.storageDriver} schema ${manifest.schemaVersion}`,
      );
  }
  if (manifest.selected.includes('agent') && manifest.selected.includes('web')) {
    const agent = manifest.components.agent;
    const web = manifest.components.web;
    if (agent.apiContract < web.peerApi.min || agent.apiContract > web.peerApi.max)
      throw new Error('new web and agent API contracts are incompatible');
    if (web.apiContract < agent.peerApi.min || web.apiContract > agent.peerApi.max)
      throw new Error('new agent and web API contracts are incompatible');
  }
  if (manifest.selected.includes('web') && !manifest.selected.includes('agent')) {
    const web = manifest.components.web;
    if (
      !Number.isInteger(liveAgentApi) ||
      !Number.isInteger(liveAgentSchemaMin) ||
      !Number.isInteger(liveAgentSchemaMax)
    )
      throw new Error('web-only release requires proven live-agent API and schema metadata');
    if (liveAgentApi < web.peerApi.min || liveAgentApi > web.peerApi.max)
      throw new Error('web-only release is incompatible with the live agent API contract');
    if (manifest.schemaVersion < liveAgentSchemaMin || manifest.schemaVersion > liveAgentSchemaMax)
      throw new Error('web-only release is incompatible with the live agent schema contract');
  }
  return true;
}

async function main() {
  const [mode, manifestPath, ...args] = process.argv.slice(2);
  if (mode === 'create') {
    const [release, imageRoot, selectedText, storageDriver, ...createValues] = args;
    const digestValues = createValues.slice(0, 5);
    const [liveAgentApiText = '', liveAgentSchemaMinText = '', liveAgentSchemaMaxText = ''] =
      createValues.slice(5);
    const contract = JSON.parse(
      await readFile(new URL('./release-contracts.json', import.meta.url)),
    );
    const journal = JSON.parse(
      await readFile(new URL('../../packages/db/drizzle/meta/_journal.json', import.meta.url)),
    );
    const schemaVersion = deriveSchemaVersion(storageDriver, journal, contract);
    const selected = selectedText.split(',').filter(Boolean);
    const digests = Object.fromEntries(
      ['agent', 'web', 'browser', 'code', 'processor'].map((name, i) => [name, digestValues[i]]),
    );
    const manifest = createManifest({
      release,
      imageRoot,
      selected,
      digests,
      contract,
      storageDriver,
      schemaVersion,
    });
    validateManifest(manifest, {
      liveAgentApi: liveAgentApiText ? Number(liveAgentApiText) : undefined,
      liveAgentSchemaMin: liveAgentSchemaMinText ? Number(liveAgentSchemaMinText) : undefined,
      liveAgentSchemaMax: liveAgentSchemaMaxText ? Number(liveAgentSchemaMaxText) : undefined,
    });
    manifest.manifestDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  if (mode === 'validate') {
    const [liveAgentApiText = '', liveAgentSchemaMinText = '', liveAgentSchemaMaxText = ''] = args;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    validateManifest(manifest, {
      liveAgentApi: liveAgentApiText ? Number(liveAgentApiText) : undefined,
      liveAgentSchemaMin: liveAgentSchemaMinText ? Number(liveAgentSchemaMinText) : undefined,
      liveAgentSchemaMax: liveAgentSchemaMaxText ? Number(liveAgentSchemaMaxText) : undefined,
    });
    return;
  }
  throw new Error(
    'usage: release-manifest.mjs create <path> <release> <imageRoot> <components> <agentDigest> <webDigest> | validate <path> [liveAgentApi] [liveAgentSchema]',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

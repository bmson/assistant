import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures: string[] = [];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.next' || entry.name === 'node_modules') return [];
      return sourceFiles(absolute);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

/**
 * Client components are the reusable presentation boundary. They may consume
 * serializable props and call server actions, but never import persistence,
 * orchestration, provider adapters, or the server singleton directly.
 */
for (const file of sourceFiles(path.join(repoRoot, 'apps/web'))) {
  const source = readFileSync(file, 'utf8');
  const relative = path.relative(repoRoot, file);
  if (/from ['"]@assistant\/core['"]/.test(source)) {
    failures.push(`${relative} imports the monolithic core barrel; use a documented subpath`);
  }
  if (
    relative !== 'apps/web/lib/server.ts' &&
    (/from ['"]@assistant\/(?:core|db|tools)/.test(source) || /from ['"]drizzle-orm/.test(source))
  ) {
    failures.push(`${relative} bypasses the application-service boundary`);
  }
  if (
    relative === 'apps/web/app/layout.tsx' &&
    (/from ['"]@assistant\/db/.test(source) || /from ['"]drizzle-orm/.test(source))
  ) {
    failures.push(`${relative} bypasses the application-service boundary`);
  }
  // Modules ship provider code behind their root entry point. The web app may
  // read module metadata (plain data, server-side) and module UI data (the
  // browser-safe /ui entry), but never the runtime.
  if (/from ['"]@assistant\/modules(?!\/(?:meta|ui))/.test(source)) {
    failures.push(
      `${relative} must import module data from @assistant/modules/meta or @assistant/modules/ui`,
    );
  }
  if (!/^\s*['"]use client['"];/.test(source)) continue;
  const forbidden = [
    /from ['"]@assistant\/(?:config|core|db|modules|tools)/,
    /from ['"]drizzle-orm/,
    /from ['"]@\/lib\/server/,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(source)) {
      failures.push(`${relative} is client UI but imports server/business infrastructure`);
      break;
    }
  }
}

const allowedWorkspaceDependencies: Record<string, readonly string[]> = {
  '@assistant/config': [],
  '@assistant/persistence': [],
  // Atomic owner-number reuse reads only the authoritative process-loaded config snapshot.
  '@assistant/firestore': ['@assistant/config', '@assistant/persistence'],
  '@assistant/db': ['@assistant/config', '@assistant/persistence'],
  '@assistant/core': ['@assistant/config', '@assistant/db', '@assistant/persistence'],
  '@assistant/application': [
    '@assistant/config',
    '@assistant/core',
    '@assistant/db',
    '@assistant/persistence',
  ],
  '@assistant/tools': ['@assistant/core', '@assistant/db', '@assistant/persistence'],
  // Modules compose the layers below them; nothing may depend on modules except
  // the agent composition root and metadata consumers.
  '@assistant/modules': [
    '@assistant/config',
    '@assistant/core',
    '@assistant/db',
    '@assistant/tools',
  ],
  // Setup tooling reads configuration and module metadata; it must never reach
  // into the database, provider clients, or the running platform.
  '@assistant/setup': ['@assistant/config', '@assistant/modules'],
};

for (const directory of readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const manifestPath = path.join(repoRoot, 'packages', directory.name, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name: string;
    dependencies?: Record<string, string>;
  };
  const allowed = allowedWorkspaceDependencies[manifest.name];
  if (!allowed) continue;
  const workspaceDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) =>
    name.startsWith('@assistant/'),
  );
  for (const dependency of workspaceDependencies) {
    if (!allowed.includes(dependency)) {
      failures.push(`${manifest.name} must not depend on ${dependency}`);
    }
  }
}

/**
 * The composition file is agent source even though it sits at the repository
 * root, and it is reached by relative path from three directories. Nothing else
 * notices when one of those paths stops resolving: the agent's would surface as
 * a failure deep inside an image build, and a missing Dockerfile COPY the same
 * way. Both are cheaper to assert here.
 */
const compositionImporters = [
  'apps/agent/src/deps.ts',
  'scripts/module-plan.ts',
  'scripts/wizard.ts',
];
for (const importer of compositionImporters) {
  const source = readFileSync(path.join(repoRoot, importer), 'utf8');
  const specifier = /from ['"](\.[^'"]*assistant\.config\.js)['"]/.exec(source)?.[1];
  if (!specifier) {
    failures.push(`${importer} no longer imports the composition file`);
    continue;
  }
  // Written as .js for ESM resolution; the file on disk is TypeScript.
  const resolved = path.resolve(path.dirname(path.join(repoRoot, importer)), specifier);
  if (!existsSync(resolved.replace(/\.js$/, '.ts'))) {
    failures.push(`${importer} imports ${specifier}, which does not resolve to a file`);
  }
}

const agentDockerfile = readFileSync(path.join(repoRoot, 'infra/docker/agent.Dockerfile'), 'utf8');
if (!/^COPY\b.*\bassistant\.config\.ts\b/m.test(agentDockerfile)) {
  failures.push('infra/docker/agent.Dockerfile must COPY assistant.config.ts into the build');
}

/**
 * Modules communicate through platform ports (OwnerNotifier, email observers,
 * channels — see packages/modules/src/platform.ts), never by importing each
 * other. A shared type belongs in the contract, not in a sibling module. This
 * is what lets any module be removed from the composition without another
 * module's import breaking.
 */
const modulesSrc = path.join(repoRoot, 'packages/modules/src');
const moduleDirs = new Set(
  readdirSync(modulesSrc, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);
for (const moduleDir of moduleDirs) {
  for (const file of sourceFiles(path.join(modulesSrc, moduleDir))) {
    const source = readFileSync(file, 'utf8');
    const relative = path.relative(repoRoot, file);
    // A relative import of a sibling module directory.
    for (const match of source.matchAll(/from ['"]\.\.\/([^'"/]+)\//g)) {
      if (moduleDirs.has(match[1] as string)) {
        failures.push(`${relative} imports sibling module ${match[1]}; use a platform port`);
      }
    }
    // The barrel bypass: index.ts re-exports module internals, so a bare
    // `from '@assistant/modules'` inside a module dir reaches a sibling's code
    // (and forms an import cycle) while dodging the relative-path check above.
    if (/from ['"]@assistant\/modules['"]/.test(source)) {
      failures.push(
        `${relative} imports the @assistant/modules barrel; a module must use a platform port, not the package it belongs to`,
      );
    }
  }
}

/** Temporary, enumerated SQL migration debt. Remove entries as use cases move. */
const persistenceImports =
  /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:@assistant\/(?:db|firestore)(?:\/|['"])|drizzle-orm(?:\/|['"])|@google-cloud\/firestore(?:\/|['"]))/;
const legacyPersistenceFiles = new Set<string>(
  JSON.parse(
    readFileSync(path.join(repoRoot, 'scripts/persistence-migration-baseline.json'), 'utf8'),
  ),
);
const remainingPersistenceFiles = new Set<string>();
for (const name of ['core', 'application', 'tools', 'modules']) {
  for (const file of sourceFiles(path.join(repoRoot, 'packages', name, 'src'))) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const relative = path.relative(repoRoot, file);
    if (!persistenceImports.test(readFileSync(file, 'utf8'))) continue;
    remainingPersistenceFiles.add(relative);
    if (!legacyPersistenceFiles.has(relative))
      failures.push(`${relative} introduces a database SDK dependency; use @assistant/persistence`);
  }
}
for (const file of legacyPersistenceFiles) {
  if (!remainingPersistenceFiles.has(file))
    failures.push(`${file} no longer needs its persistence exception; remove it from the baseline`);
}
for (const file of sourceFiles(path.join(repoRoot, 'packages/persistence/src'))) {
  if (persistenceImports.test(readFileSync(file, 'utf8')))
    failures.push(`${path.relative(repoRoot, file)} leaks a database SDK into portable contracts`);
}

if (failures.length > 0) {
  console.error('Architecture boundary violations:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Architecture boundaries are clean.');

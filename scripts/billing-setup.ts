import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, loadConfig, repoRoot } from '@assistant/config';

const ADMIN_KEY_PREFIX = 'sk-admin-';
const MAX_ADMIN_KEY_LENGTH = 521;

export interface BillingSetupReport {
  googleCloud: {
    exportTable: string | null;
    queryProject: string | null;
    queryProjectSource: 'configured' | 'export-table' | 'missing';
    location: string;
    scope: string;
    projectFilter: string | null;
    maxBytesBilled: number;
    configReady: boolean;
    proposedPrincipal: string | null;
    runtimeServiceAccountNote: string;
    requiredRoles: Array<{ role: string; resource: string }>;
    remotePermissionsChecked: false;
  };
  openAI: {
    encryptedAdminCredential: 'configured' | 'missing' | 'invalid';
    projectFilters: string[];
    projectFiltersStatus: 'configured' | 'missing' | 'invalid';
    apiKeyFilters: string[];
    apiKeyFiltersStatus: 'configured' | 'missing' | 'invalid';
    accountLabel: 'configured' | 'missing';
    queryReady: boolean;
  };
}

export function buildBillingSetupReport(config: Config): BillingSetupReport {
  const exportTable = config.GCP_BILLING_EXPORT_TABLE.trim() || null;
  const tableParts = exportTable?.split('.') ?? [];
  const exportTableValid = Boolean(
    exportTable && /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(exportTable),
  );
  const explicitQueryProject = config.GCP_BILLING_QUERY_PROJECT.trim();
  const tableProject = exportTableValid ? tableParts[0] : '';
  const queryProject = explicitQueryProject || tableProject || null;
  const queryProjectSource = explicitQueryProject
    ? 'configured'
    : tableProject
      ? 'export-table'
      : 'missing';
  const projectFilter = config.GCP_PROJECT.trim() || null;
  const configReady = Boolean(
    exportTableValid && queryProject && (config.GCP_BILLING_SCOPE !== 'project' || projectFilter),
  );
  const proposedPrincipal = projectFilter
    ? `assistant-web@${projectFilter}.iam.gserviceaccount.com`
    : null;
  const dataset = exportTableValid ? tableParts[1] : null;
  const requiredRoles = [
    {
      role: 'roles/bigquery.jobUser',
      resource: queryProject
        ? `query project ${queryProject}`
        : 'query project (unknown until configured)',
    },
    {
      role: 'roles/bigquery.dataViewer',
      resource:
        dataset && tableProject
          ? `export dataset ${tableProject}.${dataset}`
          : 'export dataset (unknown until configured)',
    },
  ];
  const projectFilters = parseFilterIds(config.OPENAI_BILLING_PROJECT_IDS, 'proj_');
  const apiKeyFilters = parseFilterIds(config.OPENAI_BILLING_API_KEY_IDS, 'key_');
  const encryptedValue = config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED.trim();
  const encryptedAdminCredential = encryptedValue
    ? isValidV2Credential(encryptedValue)
      ? 'configured'
      : 'invalid'
    : 'missing';

  return {
    googleCloud: {
      exportTable,
      queryProject,
      queryProjectSource,
      location: config.GCP_BILLING_LOCATION,
      scope: config.GCP_BILLING_SCOPE,
      projectFilter,
      maxBytesBilled: config.GCP_BILLING_MAX_BYTES,
      configReady,
      proposedPrincipal,
      runtimeServiceAccountNote: proposedPrincipal
        ? 'Proposed from the deployment convention; verify the Cloud Run web service identity before granting access.'
        : 'Unknown until GCP_PROJECT is configured; inspect the Cloud Run web service identity.',
      requiredRoles,
      remotePermissionsChecked: false,
    },
    openAI: {
      encryptedAdminCredential,
      projectFilters: projectFilters.ids,
      projectFiltersStatus: projectFilters.status,
      apiKeyFilters: apiKeyFilters.ids,
      apiKeyFiltersStatus: apiKeyFilters.status,
      accountLabel: config.OPENAI_BILLING_ACCOUNT_LABEL.trim() ? 'configured' : 'missing',
      queryReady:
        encryptedAdminCredential === 'configured' &&
        projectFilters.status !== 'invalid' &&
        apiKeyFilters.status !== 'invalid' &&
        (projectFilters.ids.length > 0 || apiKeyFilters.ids.length > 0),
    },
  };
}

function parseFilterIds(
  raw: string,
  requiredPrefix: 'proj_' | 'key_',
):
  | { status: 'missing'; ids: [] }
  | { status: 'configured'; ids: string[] }
  | { status: 'invalid'; ids: [] } {
  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) return { status: 'missing', ids: [] };
  const uniqueIds = [...new Set(ids)];
  if (
    uniqueIds.length > 25 ||
    uniqueIds.some(
      (id) =>
        id.length > 128 ||
        /^sk[-_]/i.test(id) ||
        !id.startsWith(requiredPrefix) ||
        !new RegExp(`^${requiredPrefix}[A-Za-z0-9_-]{1,${128 - requiredPrefix.length}}$`).test(id),
    )
  )
    return { status: 'invalid', ids: [] };
  return { status: 'configured', ids: uniqueIds };
}

function isValidV2Credential(value: string): boolean {
  return /^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/.test(value);
}

export function formatBillingSetupReport(report: BillingSetupReport): string {
  const google = report.googleCloud;
  const openAI = report.openAI;
  const lines = [
    'Google Cloud billing (offline configuration check)',
    `  Export table: ${google.exportTable ?? 'not configured'}`,
    `  Query project: ${google.queryProject ?? 'not configured'} (${google.queryProjectSource})`,
    `  Dataset location: ${google.location}`,
    `  Reporting scope: ${google.scope}${google.projectFilter ? `; project filter ${google.projectFilter}` : ''}`,
    `  Maximum bytes billed per query: ${google.maxBytesBilled}`,
    `  Required configuration present: ${google.configReady ? 'yes' : 'no'}`,
    `  Proposed web runtime principal: ${google.proposedPrincipal ?? 'unknown'}`,
    `  Identity note: ${google.runtimeServiceAccountNote}`,
    '  Required runtime roles (not checked):',
    ...google.requiredRoles.map((required) => `    ${required.role} on ${required.resource}`),
    '  Cloud permissions checked: no (this command makes no cloud requests)',
    'OpenAI billing (configuration presence only)',
    `  Encrypted admin credential: ${openAI.encryptedAdminCredential}`,
    `  Project filters: ${formatIds(openAI.projectFilters, openAI.projectFiltersStatus)}`,
    `  API key filters: ${formatIds(openAI.apiKeyFilters, openAI.apiKeyFiltersStatus)}`,
    `  Account label: ${openAI.accountLabel}`,
    `  Query configuration present: ${openAI.queryReady ? 'yes' : 'no'}`,
    '  Credential values are never displayed.',
  ];
  return `${lines.join('\n')}\n`;
}

function formatIds(ids: string[], status: 'configured' | 'missing' | 'invalid'): string {
  if (status === 'invalid') return 'invalid (values hidden)';
  return ids.length ? ids.join(', ') : 'none';
}

export interface SealedCredentialOptions {
  repoRoot: string;
  outputPath: string;
  credential: string;
  encrypt: (credential: string) => string;
  isIgnored: (relativePath: string) => boolean;
}

/** Write a single encrypted environment assignment to a new ignored file. */
export function writeSealedBillingCredential(options: SealedCredentialOptions): string {
  const credential = validateAdminCredential(options.credential);
  const target = resolveNewIgnoredPath(options.repoRoot, options.outputPath, options.isIgnored);
  let encrypted: string;
  try {
    encrypted = options.encrypt(credential);
  } catch {
    throw new Error('Credential encryption failed; no output file was written.');
  }
  if (!isValidV2Credential(encrypted)) {
    throw new Error('Credential encryption failed; no output file was written.');
  }
  const contents = `OPENAI_BILLING_ADMIN_KEY_ENCRYPTED=${encrypted}\n`;
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return target;
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the safe generic error below.
      }
    }
    if (created) {
      try {
        unlinkSync(target);
      } catch {
        // Preserve the safe generic error below.
      }
    }
    throw new Error(
      'Could not create the encrypted credential file; no existing file was replaced.',
    );
  }
}

function validateAdminCredential(value: string): string {
  const credential = value.trim();
  if (
    credential.length > MAX_ADMIN_KEY_LENGTH ||
    !credential.startsWith(ADMIN_KEY_PREFIX) ||
    !/^sk-admin-[A-Za-z0-9_-]{8,512}$/.test(credential)
  ) {
    throw new Error(
      'Expected a valid sk-admin- credential from stdin; the credential was not stored.',
    );
  }
  return credential;
}

function resolveNewIgnoredPath(
  workspaceRoot: string,
  requestedPath: string,
  isIgnored: (relativePath: string) => boolean,
): string {
  const root = realpathSync(workspaceRoot);
  const target = path.resolve(root, requestedPath);
  const relativePath = path.relative(root, target);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('Output path must be a new ignored file inside the workspace.');
  }
  const components = relativePath.split(path.sep);
  let parent = root;
  for (const component of components.slice(0, -1)) {
    parent = path.join(parent, component);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(parent);
    } catch {
      throw new Error('Output directory must already exist and may not contain symlinks.');
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('Output directory must already exist and may not contain symlinks.');
    }
  }
  const parentRealPath = realpathSync(parent);
  const parentRelativePath = path.relative(root, parentRealPath);
  if (parentRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelativePath)) {
    throw new Error('Output path must stay inside the workspace.');
  }
  try {
    lstatSync(target);
    throw new Error('Output file already exists; it was not replaced.');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Output file already exists; it was not replaced.'
    )
      throw error;
  }
  if (!isIgnored(relativePath)) {
    throw new Error('Output file must match a git-ignored path; nothing was written.');
  }
  return target;
}

export function parseBillingSetupArguments(
  args: string[],
): { mode: 'check' } | { mode: 'help' } | { mode: 'seal'; outputPath: string } {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { mode: 'help' };
  if (args.length === 0 || (args.length === 1 && args[0] === '--check')) return { mode: 'check' };
  const allowed = new Set(['--seal-openai', '--confirm-admin-credential']);
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      const next = args[index + 1];
      if (!next || next.startsWith('--') || outputPath)
        throw new Error('Use --output with one new ignored workspace file path.');
      outputPath = next;
      index += 1;
    } else if (typeof argument !== 'string' || !allowed.has(argument)) {
      throw new Error('Unsupported billing setup option.');
    }
  }
  if (args.includes('--seal-openai') && args.includes('--confirm-admin-credential') && outputPath) {
    return { mode: 'seal', outputPath };
  }
  throw new Error(
    'Credential sealing requires --seal-openai --output <new ignored file> --confirm-admin-credential.',
  );
}

function readCredentialFromPipe(): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw new Error(
      'Pipe the admin credential through stdin; interactive terminal input is disabled.',
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const fail = () => {
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      process.stdin.pause();
      reject(new Error('Credential input exceeded the allowed length or could not be read.'));
    };
    process.stdin.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > MAX_ADMIN_KEY_LENGTH) return fail();
      chunks.push(buffer);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', fail);
    process.stdin.resume();
  });
}

function isGitIgnored(relativePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', relativePath], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (status === 1) return false;
    throw new Error('Could not verify that the output path is ignored by git.');
  }
}

async function run(): Promise<void> {
  const parsed = parseBillingSetupArguments(process.argv.slice(2));
  if (parsed.mode === 'help') {
    console.log(
      [
        'Usage: pnpm exec tsx scripts/billing-setup.ts [--check]',
        '       pnpm exec tsx scripts/billing-setup.ts --seal-openai --output <new ignored file> --confirm-admin-credential',
        'Check is offline. Sealing reads an admin key only from piped stdin and writes encrypted data to a new ignored file.',
      ].join('\n'),
    );
    return;
  }
  if (parsed.mode === 'check') {
    console.log(formatBillingSetupReport(buildBillingSetupReport(loadConfig())));
    return;
  }
  const credential = await readCredentialFromPipe();
  const { encryptStoredCredential } = await import('@assistant/core/mcp-secrets');
  const output = writeSealedBillingCredential({
    repoRoot,
    outputPath: parsed.outputPath,
    credential,
    encrypt: encryptStoredCredential,
    isIgnored: isGitIgnored,
  });
  console.log(`Wrote encrypted credential to new ignored file: ${path.relative(repoRoot, output)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Billing setup could not be completed.';
    console.error(message);
    process.exitCode = 1;
  });
}

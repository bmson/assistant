import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';
import { EvidenceStore } from './cutover-evidence.js';
import { createNeonApi, createPostgresProbe, systemClock } from './cutover-neon-fence.js';
import {
  type CommandRunner,
  type CutoverConfig,
  type CutoverDeps,
  cutoverStatus,
  type Gcloud,
  type HttpGet,
  readCutoverConfig,
  rollbackCutover,
  runCutoverStep,
  STEPS,
} from './cutover-steps.js';
import { createGcloudAuthClient } from './gcloud-auth.js';
import { createGcsStorage } from './workspace-asset-recovery.js';

const execFileAsync = promisify(execFile);

function createGcloud(project: string): Gcloud {
  const base = (args: string[]) => [...args, `--project=${project}`];
  const run: Gcloud['run'] = (args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn('gcloud', base(args), { stdio: ['pipe', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('error', () =>
        reject(new Error(`gcloud ${args.slice(0, 3).join(' ')} failed to start`)),
      );
      child.on('close', (code) =>
        code === 0
          ? resolve(stdout)
          : reject(new Error(`gcloud ${args.slice(0, 3).join(' ')} exited with status ${code}`)),
      );
      child.stdin.end(options.stdin ?? '');
    });
  return {
    run,
    async json<T>(args: string[]) {
      const { stdout } = await execFileAsync('gcloud', [...base(args), '--format=json'], {
        maxBuffer: 256 * 1024 * 1024,
        timeout: 10 * 60_000,
      }).catch(() => {
        throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed`);
      });
      return JSON.parse(stdout || 'null') as T;
    },
  };
}

const runCommand: CommandRunner = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });

const httpGet: HttpGet = async (url, bearer) => {
  const response = await fetch(url, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
};

function realDeps(config: CutoverConfig): CutoverDeps {
  return {
    gcloud: createGcloud(config.gcp.project),
    commands: runCommand,
    neon: createNeonApi(process.env.NEON_API_KEY ?? ''),
    probe: createPostgresProbe(),
    clock: systemClock,
    async storage() {
      const token = (await (await createGcloudAuthClient()).getAccessToken())?.token;
      if (!token) throw new Error('gcloud did not provide an access token');
      return createGcsStorage(token);
    },
    http: httpGet,
    readFile: (path) => readFile(path),
  };
}

/** List/describe access only: every mutating or subprocess path throws. */
export function createReadOnlyDeps(config: CutoverConfig): CutoverDeps {
  const refuse = () => {
    throw new Error('Read-only cutover dependencies refuse this operation');
  };
  const gcloud = createGcloud(config.gcp.project);
  return {
    gcloud: {
      json: (args) => {
        if (!['list', 'describe'].includes(args[2] ?? '') && args[0] !== 'secrets') refuse();
        if (args[0] === 'secrets' && args[1] !== 'list') refuse();
        return gcloud.json(args);
      },
      run: async () => refuse(),
    },
    commands: async () => refuse(),
    neon: new Proxy({} as CutoverDeps['neon'], { get: () => refuse }),
    probe: new Proxy({} as CutoverDeps['probe'], { get: () => refuse }),
    clock: systemClock,
    storage: async () => refuse(),
    http: async () => refuse(),
    readFile: (path) => readFile(path),
  };
}

/**
 * Read-only dependencies for the final retirement proof. This is broader than
 * inventory collection because it also probes current health and the Neon
 * fence, but it exposes no mutating gcloud, Neon, SQL, command, or storage
 * operations. Secret bytes and identity tokens stay in process memory.
 */
export function createRetirementProofDeps(config: CutoverConfig): CutoverDeps {
  const inventoryOnly = createReadOnlyDeps(config);
  const live = realDeps(config);
  const refuse = (): never => {
    throw new Error('Retirement proof dependencies refuse mutating operations');
  };
  const allowedGcloudRun = (args: string[]) =>
    (args.length === 2 && args[0] === 'auth' && args[1] === 'print-identity-token') ||
    (args.length === 5 &&
      args[0] === 'secrets' &&
      args[1] === 'versions' &&
      args[2] === 'access' &&
      args[3] === 'latest' &&
      args[4] === `--secret=${config.sourceDatabaseSecret}`);
  return {
    ...inventoryOnly,
    gcloud: {
      json: inventoryOnly.gcloud.json,
      run: async (args, options) => {
        if (!allowedGcloudRun(args)) refuse();
        return live.gcloud.run(args, options);
      },
    },
    neon: {
      getEndpoint: (...args) => live.neon.getEndpoint(...args),
      listOperations: (...args) => live.neon.listOperations(...args),
      setEndpointDisabled: async () => refuse(),
      getOperation: async () => refuse(),
      createBranch: async () => refuse(),
      getBranch: async () => refuse(),
      deleteBranch: async () => refuse(),
    },
    probe: {
      tryConnect: (...args) => live.probe.tryConnect(...args),
      readOnlyProof: async () => refuse(),
      sessionInventory: async () => refuse(),
      primaryWriteState: async () => refuse(),
    },
    http: live.http,
  };
}

const USAGE = `Usage:
  pnpm cutover status   --config cutover.json --evidence-dir DIR
  pnpm cutover run STEP --config cutover.json --evidence-dir DIR [--confirm STEP]
  pnpm cutover rollback --config cutover.json --evidence-dir DIR --confirm rollback [--accept-firestore-divergence]

Steps: ${STEPS.map((step) => `${step.name}${step.mutating ? '*' : ''}`).join(', ')}
(* changes production and needs --confirm with the same step name)`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'evidence-dir': { type: 'string' },
      confirm: { type: 'string' },
      'accept-firestore-divergence': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const [command, step] = positionals;
  if (!command || !values.config || !values['evidence-dir']) throw new Error(USAGE);
  const config = await readCutoverConfig(values.config);
  const store = new EvidenceStore(values['evidence-dir']);
  if (command === 'status') {
    console.log(JSON.stringify(cutoverStatus(config, store), null, 2));
    return;
  }
  if (command === 'run') {
    if (!step) throw new Error(USAGE);
    const evidence = await runCutoverStep(step, config, realDeps(config), store, {
      confirm: values.confirm,
    });
    console.log(
      JSON.stringify(
        { step: evidence.step, status: evidence.status, error: evidence.error ?? null },
        null,
        2,
      ),
    );
    if (evidence.status !== 'passed') process.exitCode = 1;
    return;
  }
  if (command === 'rollback') {
    const result = await rollbackCutover(config, realDeps(config), store, {
      confirm: values.confirm,
      acceptFirestoreDivergence: values['accept-firestore-divergence'],
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error(USAGE);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

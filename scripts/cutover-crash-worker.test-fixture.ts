import { readFileSync, writeFileSync } from 'node:fs';
import { EvidenceStore } from './cutover-evidence.js';
import { type CutoverConfig, type CutoverDeps, runCutoverStep } from './cutover-steps.js';

type DurableSchedulerState = {
  scheduler: 'ENABLED' | 'PAUSED';
  effectCount: number;
  pushEndpoint: string;
};

type FixtureInput = {
  config: CutoverConfig;
  evidenceDirectory: string;
  statePath: string;
  mode: 'kill-after-effect' | 'evidence-write-eio' | 'retry';
};

function loadState(path: string): DurableSchedulerState {
  return JSON.parse(readFileSync(path, 'utf8')) as DurableSchedulerState;
}

function saveState(path: string, state: DurableSchedulerState) {
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function makeDeps(input: FixtureInput): CutoverDeps {
  const { config, mode, statePath } = input;
  const json = async <T>(args: string[]): Promise<T> => {
    const key = args.slice(0, 3).join(' ');
    const state = loadState(statePath);
    const value = (() => {
      if (key === 'run services list')
        return config.services.map((service) => ({
          metadata: { name: service.name },
          status: {
            url: `https://${service.name}-x.a.run.app`,
            latestReadyRevisionName: `${service.name}-00001`,
            traffic: [
              { revisionName: `${service.name}-00001`, percent: 100, latestRevision: true },
            ],
          },
          spec: {
            template: {
              spec: {
                serviceAccountName: config.exportServiceAccount,
                containers: [
                  {
                    image: service.image,
                    env: Object.entries(service.env).map(([name, value]) => ({ name, value })),
                  },
                ],
              },
            },
          },
        }));
      if (key === 'run jobs list') return [];
      if (key === 'scheduler jobs list')
        return [
          {
            name: `projects/${config.gcp.project}/locations/${config.gcp.region}/jobs/assistant-sweep`,
            state: state.scheduler,
            schedule: '* * * * *',
            httpTarget: { uri: `https://assistant-agent-x.a.run.app/internal/sweep` },
          },
          {
            name: `projects/${config.gcp.project}/locations/${config.gcp.region}/jobs/assistant-canaries`,
            state: 'PAUSED',
            schedule: '* * * * *',
            httpTarget: { uri: `https://assistant-agent-x.a.run.app/internal/canaries/run` },
          },
        ];
      if (key === 'tasks queues list') return [];
      if (key === 'pubsub subscriptions list')
        return config.dispatcher.pushSubscriptions.map((subscription) => ({
          name: `projects/${config.gcp.project}/subscriptions/${subscription.name}`,
          topic: `projects/${config.gcp.project}/topics/gmail-events`,
          pushConfig: {
            ...(state.pushEndpoint ? { pushEndpoint: state.pushEndpoint } : {}),
            oidcToken: {
              serviceAccountEmail: subscription.oidcServiceAccount,
              audience: subscription.oidcAudience,
            },
          },
        }));
      if (key === 'secrets list')
        return [config.sourceDatabaseSecret, 'auth-secret'].map((name) => ({
          name: `projects/${config.gcp.project}/secrets/${name}`,
        }));
      throw new Error(`Unexpected fake gcloud read: ${args.join(' ')}`);
    })();
    return structuredClone(value) as T;
  };

  const run = async (args: string[]) => {
    const state = loadState(statePath);
    if (args[0] === 'scheduler' && args[1] === 'jobs' && args[2] === 'pause') {
      state.scheduler = 'PAUSED';
      state.effectCount += 1;
      saveState(statePath, state);
      if (mode === 'kill-after-effect') process.kill(process.pid, 'SIGKILL');
      return '';
    }
    if (args[0] === 'pubsub' && args[1] === 'subscriptions' && args[2] === 'modify-push-config') {
      const endpointArg = args.find((arg) => arg.startsWith('--push-endpoint='));
      state.pushEndpoint = endpointArg?.slice('--push-endpoint='.length) ?? '';
      state.effectCount += 1;
      saveState(statePath, state);
      return '';
    }
    throw new Error(`Unexpected fake gcloud mutation: ${args.join(' ')}`);
  };

  return {
    gcloud: { json, run },
    commands: async () => {
      throw new Error('Cutover crash fixture must not invoke commands');
    },
    neon: {
      getEndpoint: async () => {
        throw new Error('Cutover crash fixture must not invoke Neon');
      },
      setEndpointDisabled: async () => {
        throw new Error('Cutover crash fixture must not mutate Neon');
      },
      createBranch: async () => {
        throw new Error('Cutover crash fixture must not mutate Neon');
      },
      getBranch: async () => {
        throw new Error('Cutover crash fixture must not read Neon');
      },
      deleteBranch: async () => {
        throw new Error('Cutover crash fixture must not mutate Neon');
      },
      getOperation: async () => {
        throw new Error('Cutover crash fixture must not read Neon');
      },
      listOperations: async () => {
        throw new Error('Cutover crash fixture must not read Neon');
      },
    },
    probe: {
      tryConnect: async () => {
        throw new Error('Cutover crash fixture must not probe a database');
      },
      readOnlyProof: async () => {
        throw new Error('Cutover crash fixture must not probe a database');
      },
      sessionInventory: async () => {
        throw new Error('Cutover crash fixture must not probe a database');
      },
      primaryWriteState: async () => {
        throw new Error('Cutover crash fixture must not probe a database');
      },
    },
    clock: { now: () => new Date('2026-10-07T12:00:00.000Z'), sleep: async () => {} },
    storage: async () => {
      throw new Error('Cutover crash fixture must not access cloud storage');
    },
    http: async () => {
      throw new Error('Cutover crash fixture must not access HTTP');
    },
    readFile: async () => {
      throw new Error('Cutover crash fixture must not read recovery manifests');
    },
  } as CutoverDeps;
}

async function main() {
  const [, , inputPath] = process.argv;
  if (!inputPath) throw new Error('Expected fixture input path');
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as FixtureInput;
  const store = new EvidenceStore(input.evidenceDirectory);
  if (input.mode === 'evidence-write-eio') {
    store.write = () => {
      const error = new Error('simulated evidence-store EIO') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    };
  }
  try {
    await runCutoverStep('quiesce', input.config, makeDeps(input), store, { confirm: 'quiesce' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (input.mode === 'retry' && message.includes('unresolved durable intent')) {
      process.exitCode = 43;
      return;
    }
    if (input.mode === 'evidence-write-eio' && message.includes('simulated evidence-store EIO')) {
      process.exitCode = 42;
      return;
    }
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

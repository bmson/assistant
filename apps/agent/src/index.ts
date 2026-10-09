import type { Server } from 'node:http';
import {
  loadConfig,
  validateAgentPersistenceConfig,
  validateRestoreRehearsalConfig,
} from '@assistant/config';
import {
  assertPostgresInstallationOwner,
  assertPostgresRestoreRehearsalReadOnly,
} from '@assistant/db';
import { assertFirestoreInstallationOwner } from '@assistant/firestore';
import { callsModule } from '@assistant/modules';
import { validateAssistantConfig } from '@assistant/modules/meta';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { attachCallStream } from './call-stream.js';
import { agentServices, buildDeps } from './deps.js';
import { initOtel } from './otel-init.js';
import { startPoller } from './poller.js';
import { installRestoreNetworkFence } from './restore-network-fence.js';

const config = loadConfig();

// Fail fast on a misconfigured production deploy rather than breaking the queue
// on the first task or accepting unauthenticated internal calls.
const configProblems = [
  ...validateAssistantConfig(config),
  ...validateAgentPersistenceConfig(config),
  ...validateRestoreRehearsalConfig(config),
];
if (configProblems.length > 0) {
  console.error('FATAL: invalid production configuration:');
  for (const problem of configProblems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (config.RESTORE_REHEARSAL) installRestoreNetworkFence();
initOtel();

// Build the dependency graph — and with it install the modules — at boot, not
// lazily on the first request. installModules validates the composition (every
// declared webhook/internal route has a handler; no duplicate paths or task
// kinds), and that check is worthless if it only runs when Cloud Tasks delivers
// the first task in production. A composition mistake now crashes startup, the
// same way validateAssistantConfig above does, instead of surfacing as a
// silent 404 on a live webhook.
const deps = buildDeps();
if (config.RESTORE_REHEARSAL) {
  if (deps.firestoreStore) throw new Error('RESTORE_REHEARSAL cannot use Firestore persistence');
  await assertPostgresRestoreRehearsalReadOnly(deps.db);
}
if (deps.firestoreStore) {
  // Empty destinations may boot for controlled import; existing poller/ready
  // activation guards keep owner work inert until the installation is ready.
  await assertFirestoreInstallationOwner(deps.firestoreStore, config.FIRESTORE_AGENT_ID, true);
} else {
  await assertPostgresInstallationOwner(deps.db);
}

if (config.QUEUE_DRIVER === 'local') {
  startPoller(deps);
  console.log('local queue poller started (2s interval)');
} else if (config.QUEUE_DRIVER === 'inert') {
  console.log('restore rehearsal background dispatch is disabled');
}
const app = createApp();

// Cloud Run injects PORT; local dev uses AGENT_PORT (8787).
const port = process.env.PORT ? Number(process.env.PORT) : config.AGENT_PORT;
const server = serve(
  {
    fetch: app.fetch,
    port,
    ...(config.RESTORE_REHEARSAL ? { hostname: '127.0.0.1' } : {}),
  },
  (info) => {
    console.log(`agent service listening on :${info.port}`);
  },
);

// Live phone calls: Twilio media streams arrive as WebSocket upgrades.
const callBridge = deps.modules.exportsOf(callsModule);
if (!config.RESTORE_REHEARSAL && callBridge)
  attachCallStream(server as Server, callBridge, () => agentServices(deps));

import { spawn } from 'node:child_process';
import { allocateTestTarget, isolatedTestEnvironment } from './test-target.js';

/** Emulator-only Firestore suite with its own disposable PostgreSQL database. */
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
  throw new Error(
    'Start the Firestore emulator and set FIRESTORE_EMULATOR_HOST=127.0.0.1:8789. This command never uses a cloud database.',
  );
}
const response = await fetch(`http://${host}`, { signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error('The Firestore emulator is not ready');

function run(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    };
    process.on('SIGINT', forwardSignal);
    process.on('SIGTERM', forwardSignal);
    child.once('error', reject);
    child.once('close', (code) => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
      resolve(code ?? 1);
    });
  });
}

const target = allocateTestTarget(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const testEnv: NodeJS.ProcessEnv = {
  ...isolatedTestEnvironment(process.env),
  DATABASE_URL: target.databaseUrl,
  TEST_DATABASE_URL: target.databaseUrl,
  ASSISTANT_TEST_TARGET_TOKEN: target.token,
  GCLOUD_PROJECT: 'demo-assistant-test',
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS,
    `--import=${new URL('./deny-test-egress.mjs', import.meta.url).href}`,
  ]
    .filter(Boolean)
    .join(' '),
};

const files = [
  'packages/firestore',
  'packages/persistence',
  'apps/agent/src/firestore-dispatch.test.ts',
  'apps/agent/src/firestore-mcp.test.ts',
  'apps/agent/src/firestore-owner-notices.test.ts',
  'apps/agent/src/firestore-boot.test.ts',
  'apps/agent/src/firestore-portable-web-workspace.test.ts',
  'apps/agent/src/firestore-google-calendar.test.ts',
  'apps/agent/src/firestore-schedule.test.ts',
  'apps/agent/src/firestore-repair-schedule.test.ts',
  'apps/agent/src/firestore-approval.test.ts',
  'apps/agent/src/firestore-model-routing.test.ts',
  'apps/agent/src/firestore-runtime-smoke.test.ts',
  'apps/agent/src/firestore-executor.test.ts',
  'apps/agent/src/firestore-document-extraction.test.ts',
  'apps/agent/src/firestore-chat.test.ts',
  'apps/agent/src/firestore-application.test.ts',
  'apps/agent/src/firestore-graph-sync.test.ts',
  'apps/agent/src/firestore-memory-consolidation.test.ts',
  'apps/agent/src/firestore-memory-extraction.test.ts',
  'apps/agent/src/firestore-watches.test.ts',
  'apps/agent/src/firestore-reminders.test.ts',
  'apps/agent/src/firestore-cloudtasks.test.ts',
  'apps/agent/src/firestore-boot-cloudtasks.test.ts',
  'apps/agent/src/firestore-full-composition.test.ts',
  'apps/agent/src/firestore-sweep.test.ts',
  'apps/agent/src/firestore-maintenance-parity.test.ts',
  'apps/agent/src/firestore-job-callbacks.test.ts',
  'apps/agent/src/firestore-health-monitor.test.ts',
  'apps/agent/src/firestore-reminder-delivery.test.ts',
  'apps/agent/src/firestore-ambient-refresh.test.ts',
  'apps/agent/src/firestore-open-loop-sweep.test.ts',
  'apps/agent/src/firestore-email-extraction.test.ts',
  'apps/agent/src/firestore-anomaly-scan.test.ts',
  'apps/agent/src/firestore-briefing.test.ts',
  'apps/agent/src/firestore-skill-reflection.test.ts',
  'apps/agent/src/firestore-self-maintenance.test.ts',
  'apps/agent/src/firestore-dream.test.ts',
  'apps/agent/src/firestore-self-improvement.test.ts',
  'apps/agent/src/firestore-graph-jobs.test.ts',
  'apps/agent/src/firestore-pulse.test.ts',
  'apps/agent/src/firestore-chat-segmentation.test.ts',
  'apps/agent/src/firestore-lookup-tools.test.ts',
  'apps/agent/src/firestore-push-notifier.test.ts',
  'apps/agent/src/firestore-sms-channel.test.ts',
  'apps/agent/src/firestore-application-confirmations.test.ts',
  'apps/agent/src/firestore-email-sync.test.ts',
  'apps/agent/src/firestore-email-channel.test.ts',
  'apps/agent/src/firestore-document-search.test.ts',
  'apps/agent/src/firestore-document-processing.test.ts',
  'apps/agent/src/firestore-imports.test.ts',
  'apps/web/app/import/actions.firestore.test.ts',
  'apps/web/app/import/page.test.tsx',
  'apps/web/app/profile/voice/page.test.tsx',
  'apps/agent/src/firestore-goals-missions.test.ts',
  'apps/agent/src/firestore-builtin-tools.test.ts',
  'apps/web/app/costs/page.test.tsx',
  'apps/web/app/packs/actions.firestore.test.ts',
  'apps/web/app/skills/actions.firestore.test.ts',
  'apps/web/app/skills/page.test.tsx',
  'apps/web/app/settings/page.test.tsx',
  'apps/web/lib/task-activity.firestore.test.ts',
  'apps/web/app/api/files/route.firestore.test.ts',
  'apps/web/app/profile/page.firestore.test.tsx',
  'apps/web/app/profile/memories/page.test.tsx',
  'apps/web/app/api/mobile/v1/people/route.test.ts',
  'apps/web/lib/chat-server.test.ts',
  'apps/web/app/api/mobile/v1/location/route.firestore.test.ts',
  'apps/web/app/api/mobile/v1/memory/people/[id]/route.firestore.test.ts',
  'apps/web/app/api/mobile/v1/memory/profile/maintenance.firestore.test.ts',
  'apps/web/app/anomalies/actions.firestore.test.ts',
  'apps/web/lib/mobile-improvements-server.test.ts',
  'apps/web/app/tasks/actions.firestore.test.ts',
  'apps/web/app/chat/actions.firestore.test.ts',
  'apps/web/app/api/mobile/v1/devices/route.firestore.test.ts',
  'apps/web/app/profile/actions.firestore.test.ts',
  'apps/web/app/profile/about/page.test.tsx',
  'apps/web/app/api/mobile/v1/memory/library/route.test.ts',
  'apps/web/app/api/mobile/v1/memory/profile/route.firestore.test.ts',
  'apps/web/app/api/mobile/v1/documents/route.firestore.test.ts',
  'apps/web/app/api/mobile/v1/mcp/route.test.ts',
  'apps/web/app/api/mobile/v1/knowledge/route.firestore.test.ts',
  'apps/web/app/profile/knowledge/knowledge.firestore.test.ts',
  'apps/web/app/people/page.test.tsx',
  'apps/web/app/people/[id]/page.test.tsx',
  'apps/web/lib/firestore-mobile-workspace.test.ts',
  'scripts/firestore-watch-smoke.test.ts',
  'scripts/consumer-owner-claim.test.ts',
  'scripts/profile-library-parity.test.ts',
  'scripts/profile-people-read.test.ts',
  'scripts/mobile-workspace-memory.test.ts',
  'apps/agent/src/task-runner.test.ts',
  'packages/tools/src/dispatcher.firestore.test.ts',
  ...process.argv.slice(2),
];

let status = 1;
try {
  status = await run(['--filter', '@assistant/db', 'test:prepare'], testEnv);
  if (status === 0) {
    status = await run(['exec', 'vitest', 'run', '--testTimeout=30000', ...files], testEnv);
  }
} finally {
  try {
    const cleanup = await run(['--filter', '@assistant/db', 'test:cleanup'], {
      ...testEnv,
      ASSISTANT_TEST_CLEANUP: '1',
    });
    if (cleanup !== 0 && status === 0) status = cleanup;
  } catch (error) {
    console.error(
      `Test database cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    if (status === 0) status = 1;
  }
}
process.exitCode = status;

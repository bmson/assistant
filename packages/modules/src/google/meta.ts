import { isModuleEnabled } from '@assistant/config/modules';
import type { ModuleMeta } from '../contract.js';
import { googleToolLabels } from './labels.js';

export const googleMeta = {
  name: 'google',
  title: 'Google Workspace',
  summary: 'Gmail, Calendar, Drive, Docs, Sheets, Slides, and job application confirmations.',
  configKeys: [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'BOT_GOOGLE_REFRESH_TOKEN',
    'GMAIL_PUBSUB_TOPIC',
    'GMAIL_PUSH_SERVICE_ACCOUNT',
    'GMAIL_SYNC_ENABLED',
    'EMAIL_OBSERVER_WORKER_ENABLED',
    'EMAIL_INGEST_MODE',
    'EMAIL_INGEST_IMPORTANCE_THRESHOLD',
    'EMAIL_INGEST_MAX_TRIAGE_PER_DAY',
    'EMAIL_OUTBOUND_DOMAINS',
  ],
  readiness: (config) => {
    const ready = Boolean(
      config.GOOGLE_OAUTH_CLIENT_ID &&
        config.GOOGLE_OAUTH_CLIENT_SECRET &&
        config.BOT_GOOGLE_REFRESH_TOKEN,
    );
    return { ready, detail: ready ? 'ready' : 'missing Google OAuth credentials' };
  },
  prodProblems: (config) => {
    const problems: string[] = [];
    const enabled = isModuleEnabled(config, 'google');
    if (config.GMAIL_PUBSUB_TOPIC && !enabled) {
      problems.push('the google module is required when GMAIL_PUBSUB_TOPIC is set');
    }
    if (config.GMAIL_PUBSUB_TOPIC && !config.GMAIL_PUSH_SERVICE_ACCOUNT) {
      problems.push('GMAIL_PUSH_SERVICE_ACCOUNT is required when GMAIL_PUBSUB_TOPIC is set');
    }
    if (config.CANARY_ENABLED && !enabled) {
      problems.push('the google module is required when CANARY_ENABLED=true');
    }
    return problems;
  },
  infra: {
    gcpApis: [
      'gmail.googleapis.com',
      'calendar-json.googleapis.com',
      'docs.googleapis.com',
      'sheets.googleapis.com',
      'slides.googleapis.com',
      'drive.googleapis.com',
    ],
    // Mail sync polls for new messages; the watch registration expires after a
    // week, so it is renewed daily.
    schedulerJobs: [
      { name: 'assistant-gmail-sync', schedule: '* * * * *', path: '/internal/gmail/sync' },
      { name: 'assistant-gmail-watch', schedule: '0 4 * * *', path: '/internal/gmail/watch' },
    ],
  },
  ui: {
    toolLabels: googleToolLabels,
  },
  // The email channel delivers owner-facing email_triage finals; declared so the
  // executor fails such a task loudly if the google module is uninstalled.
  deliversTaskTypes: ['email_triage'],
  // Deterministic task kinds handled by applicationConfirmationTaskHandlers;
  // declared so a queued confirmation completes benignly if google is removed.
  taskKinds: ['application_confirmation', 'application_confirmation_ambiguous'],
  // Gmail push: the platform verifies the Google-signed OIDC token against the
  // configured push service account before the module's handler runs.
  webhooks: [
    {
      path: '/gmail/pubsub',
      auth: { kind: 'googleOidc', serviceAccountKey: 'GMAIL_PUSH_SERVICE_ACCOUNT' },
    },
  ],
  // The handlers for the scheduler jobs above, declared together so the
  // schedule and the route cannot drift apart.
  internalRoutes: [
    { path: '/gmail/watch' },
    {
      // Not the uniform disabled-404: the every-minute scheduler job must stay
      // green when sync is off, so a disabled module reports a 200 skip.
      path: '/gmail/sync',
      whenDisabled: {
        status: 200,
        body: { skipped: true, reason: 'gmail sync disabled by module or setting' },
      },
    },
  ],
  billing: {
    gcp: [
      {
        service: 'Pub/Sub',
        tier: 'free-tier-likely',
        note: 'Gmail push notifications; the first 10 GiB per month is free.',
      },
      {
        service: 'Cloud Scheduler',
        tier: 'free-tier-likely',
        note: 'Two jobs (mail sync, watch renewal); three jobs per month are free.',
      },
    ],
    external: [
      {
        vendor: 'Google Workspace',
        required: false,
        note: 'A seat is needed only if the assistant has its own Workspace identity; a consumer Google account works otherwise.',
        url: 'https://workspace.google.com/pricing',
      },
    ],
  },
} satisfies ModuleMeta;

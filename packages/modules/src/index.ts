/**
 * The full entry point, published as `@assistant/modules`.
 *
 * This reaches provider code through the module definitions, so only the agent
 * composition root and `assistant.config.ts` import it. Everything that needs
 * metadata alone should import `@assistant/modules/meta` instead.
 *
 * Only symbols an external consumer (the agent app, deployment scripts, the
 * composition root) actually imports are re-exported here. A module's own
 * plumbing — channel delivery, sweep/tick helpers, the owner-notifier fan-out,
 * inbound-mail matching — is reached through relative imports inside
 * `packages/modules`, never the barrel, so it stays off this surface and off
 * the sibling-import bypass path that `scripts/check-boundaries.ts` guards.
 */
export { browserModule } from './browser/module.js';
export { type CallBridge, callsModule } from './calls/module.js';
export { codeModule } from './code/module.js';
export * from './compose.js';
export { documentsModule } from './documents/module.js';
export {
  type ApplicationConfirmationTaskDeps,
  applicationConfirmationTaskHandlers,
  applicationPersistence,
  confirmationTokenHashes,
  executeApplicationConfirmationTask,
  processApplicationConfirmation,
} from './google/application-confirmations.js';
export { calendarModule } from './google/calendar-module.js';
export { type EmailSyncDeps, processMessage } from './google/email-sync.js';
export { googleModule } from './google/module.js';
export {
  emailIngestForwarded,
  emailObserverWorkerEnabled,
  gmailSyncEnabled,
} from './google/runtime.js';
export * from './install.js';
export { mapsModule } from './maps/module.js';
export * from './meta.js';
export * from './platform.js';
export { pushModule } from './push/module.js';
export { remindersModule } from './reminders/module.js';
export { searchModule } from './search/module.js';
export {
  deliverSmsFinal,
  handleInboundSms,
  type SmsChannelDeps,
  sendCanarySms,
} from './sms/channel.js';
export { smsModule } from './sms/module.js';
export { watchesModule } from './watches/module.js';

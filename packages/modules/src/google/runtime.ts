import { type Config, loadConfig } from '@assistant/config';
import { isModuleEnabled } from '@assistant/config/modules';

/**
 * Whether the agent should poll Gmail for new mail.
 *
 * An explicit true or false always wins; otherwise sync runs only in
 * production, so a developer's machine does not quietly consume the same
 * mailbox as the deployed assistant. The module being installed is a hard gate
 * either way.
 */
export function gmailSyncEnabled(config: Config = loadConfig()): boolean {
  if (!isModuleEnabled(config, 'google')) return false;
  if (config.GMAIL_SYNC_ENABLED === 'true') return true;
  if (config.GMAIL_SYNC_ENABLED === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

/** Durable observer work stays paused until its explicit rollout gate is enabled. */
export function emailObserverWorkerEnabled(config: Config = loadConfig()): boolean {
  return config.EMAIL_OBSERVER_WORKER_ENABLED === true && gmailSyncEnabled(config);
}

/**
 * Is this mailbox the owner's forwarding pipe rather than an inbox strangers
 * write to? This single predicate decides what inbound mail is owner-directed
 * while remaining sender-authored and tainted. Header-based detection is not
 * safe because forwarding and direct delivery cannot be distinguished reliably
 * from sender-controlled headers.
 */
export function emailIngestForwarded(config: Config = loadConfig()): boolean {
  return isModuleEnabled(config, 'google') && config.EMAIL_INGEST_MODE === 'forwarded';
}

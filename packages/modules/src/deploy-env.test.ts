import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@assistant/config';
import { describe, expect, it } from 'vitest';
import { assistantModuleMetas } from './registry.js';

/**
 * Every setting a module claims to own must be reachable in production.
 *
 * `infra/gcp/deploy.sh` deploys with `--set-env-vars`, which REPLACES the whole
 * environment rather than merging into it. A setting the script does not name
 * is therefore not merely unset — it is *unsettable*: an operator can change it
 * in the console, and the next provisioning run silently wipes it back.
 *
 * That is how `EMAIL_INGEST_MODE` came to be undeliverable while the module
 * that owns it declared it, documented it in `.env.example`, and branched on
 * it at runtime. Nothing failed; the mailbox ledger just stayed empty and the
 * assistant went quiet, which is indistinguishable from having nothing to say.
 *
 * A module key is satisfied by appearing anywhere in the deploy script: in an
 * env fragment, or delivered from Secret Manager via `--set-secrets`. The
 * exemptions below are keys that genuinely do not belong in a Cloud Run
 * revision, each with the reason it is exempt.
 */
describe('deploy.sh delivers every module setting', () => {
  const deploy = readFileSync(path.join(repoRoot, 'infra/gcp/deploy.sh'), 'utf8');
  const observerEnv = readFileSync(
    path.join(repoRoot, 'infra/gcp/email-observer-worker-env.sh'),
    'utf8',
  );

  /**
   * Keys whose value the script actually READS from the operator's env file.
   *
   * Matching on the read, not on the key name appearing somewhere in the file,
   * is what makes this test worth having. The first draft searched the raw
   * text and passed with the plumbing deleted — the comment block explaining
   * these settings mentions them by name, and the fragment that builds the
   * value contains a literal `EMAIL_INGEST_MODE=` even when the value behind
   * it is empty. A setting nothing reads from `.env` cannot be configured,
   * whatever the file says about it.
   */
  const sourcedText = `${deploy}\n${observerEnv}`;
  const sourced = new Set(
    [...sourcedText.matchAll(/\b(?:envval|mail_env_add)\s+([A-Z][A-Z0-9_]*)/g)].map(
      (match) => match[1] as string,
    ),
  );

  /**
   * Keys the script decides itself rather than accepting from the operator.
   *
   * Each is a property of running on Cloud Run, not a preference: the workers
   * are Cloud Run Jobs with names this same script creates, so letting an env
   * file disagree with what was provisioned would only produce a broken
   * installation. Listed individually rather than pattern-matched so adding a
   * genuinely operator-facing setting cannot hide behind a wildcard.
   */
  const DERIVED = new Map<string, string>([
    ['GMAIL_PUBSUB_TOPIC', 'built from the project id and the topic this script creates'],
    ['GMAIL_PUSH_SERVICE_ACCOUNT', "Google's own push identity, discovered at deploy time"],
    ['BROWSER_DRIVER', 'always cloudrun in a deployed installation'],
    ['BROWSER_JOB_NAME', 'the Cloud Run Job this script creates'],
    ['CODE_DRIVER', 'always cloudrun in a deployed installation'],
    ['CODE_JOB_NAME', 'the Cloud Run Job this script creates'],
    ['PROCESSOR_DRIVER', 'always cloudrun in a deployed installation'],
    ['PROCESSOR_JOB_NAME', 'the Cloud Run Job this script creates'],
    ['TRACES_BUCKET', 'derived from the project id'],
    ['PROFILE_ENC_KEY', 'delivered from Secret Manager; generated on first deploy'],
    ['PUBLIC_URL', 'the agent service URL, discovered after its first deploy'],
  ]);

  const declared = [...new Set(assistantModuleMetas.flatMap((meta) => meta.configKeys))].sort();

  it('reads every module config key from the env file, or derives it on purpose', () => {
    const unreachable = declared.filter((key) => !sourced.has(key) && !DERIVED.has(key));
    expect(unreachable).toEqual([]);
  });

  /**
   * The `--set-env-vars` payloads, per service.
   *
   * Asserting against these rather than the whole file is what stops an
   * incidental match passing for working plumbing: `${MAIL_ENV}` appears
   * inside the helper that builds the fragment, so a file-wide search stays
   * green even when nothing splices the fragment into a service. The agent
   * payload is the one carrying the worker job names; the web payload is the
   * one carrying the auth flags.
   */
  const payloads = [...deploy.matchAll(/--set-env-vars\s+"([^"]*)"/g)].map((m) => m[1] as string);
  const agentEnv = payloads.find((line) => line.includes('BROWSER_JOB_NAME')) ?? '';
  const webEnv = payloads.find((line) => line.includes('AUTH_TRUST_HOST')) ?? '';

  it('found both service environments to check', () => {
    // Guards every assertion below: a renamed flag would otherwise silently
    // reduce them to comparing empty strings.
    expect(agentEnv).not.toBe('');
    expect(webEnv).not.toBe('');
  });

  it('reads the mail-ingest settings that decide whether mail is read at all', () => {
    // Pinned to the agent's own fragment builder rather than to `sourced`: the
    // web service reads EMAIL_INGEST_MODE too, which is enough to satisfy a
    // whole-file check while the agent — the process that actually ingests
    // mail — receives nothing.
    for (const key of [
      'EMAIL_INGEST_MODE',
      'EMAIL_INGEST_IMPORTANCE_THRESHOLD',
      'EMAIL_INGEST_NOTIFY_THRESHOLD',
      'EMAIL_INGEST_MAX_TRIAGE_PER_DAY',
    ]) {
      expect(deploy, `${key} must be added to the agent's mail fragment`).toContain(
        `mail_env_add ${key}`,
      );
    }
  });

  it('splices each mail fragment into the service that needs it', () => {
    // A fragment that is built and never interpolated reaches nothing, and
    // reads exactly like a working one at a glance.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching a literal shell interpolation
    expect(agentEnv).toContain('${MAIL_ENV}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching a literal shell interpolation
    expect(webEnv).toContain('${WEB_MAIL_ENV}');
  });

  it('forwards the default-off observer gate to the agent only', () => {
    expect(observerEnv).toContain('envval EMAIL_OBSERVER_WORKER_ENABLED');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching a literal shell interpolation
    expect(agentEnv).toContain('${EMAIL_OBSERVER_WORKER_ENV}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching a literal shell interpolation
    expect(webEnv).not.toContain('${EMAIL_OBSERVER_WORKER_ENV}');
  });
});

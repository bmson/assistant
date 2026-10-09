'use server';

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  envFile,
  loadConfig,
  reloadConfig,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import { FirestoreMcpConnectionMutationRepository } from '@assistant/firestore';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { runFirestoreSettingsMutation } from '@/lib/firestore-settings-mutation';
import {
  clearMobileAccessTokenCache,
  hasMobileTokenRotationCapability,
} from '@/lib/mobile-access-token';
import { persistSecretEnvValue } from '@/lib/persist-secret-env';
import {
  discoverFirestoreMcpConnection,
  encryptMcpConnectionBearerToken,
  getApplication,
  getFirestoreInstallationStore,
} from '@/lib/server';

function revalidateSettings(): void {
  revalidatePath('/settings');
}

/** Editable agent identity: timezone, locale, signature. */
export async function updateAgentSettings(input: {
  timezone: string;
  locale: string;
  signature: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const config = loadConfig();
  const result =
    config.PERSISTENCE_DRIVER === 'firestore'
      ? await runFirestoreSettingsMutation((settings) => settings.updateAssistantSettings(input))
      : await getApplication().updateSettings(input);
  if (result.error) return result;
  revalidateSettings();
  return {};
}

/** Pause/resume a proactive schedule. Re-enabling recomputes next_run_at on the next sweep. */
export async function setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<void> {
  await requireOwner();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    await runFirestoreSettingsMutation((settings) =>
      settings.setRecurringJobEnabled(scheduleId, enabled),
    );
  } else {
    await getApplication().setScheduleEnabled(scheduleId, enabled);
  }
  revalidateSettings();
}

/** Quiet hours and the daily ambient-ping cap — when the assistant may buzz the phone. */
export async function updateNotificationSettings(input: {
  quietStart: string;
  quietEnd: string;
  ambientDailyCap: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const config = loadConfig();
  const result =
    config.PERSISTENCE_DRIVER === 'firestore'
      ? await runFirestoreSettingsMutation((settings) => settings.updateNotificationPrefs(input))
      : await getApplication().updateNotificationPrefs(input);
  if (result.error) return result;
  revalidateSettings();
  return {};
}

/** Enable/disable a standing approval rule. */
export async function setPolicyEnabled(policyId: string, enabled: boolean): Promise<void> {
  await requireOwner();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    await runFirestoreSettingsMutation((settings) =>
      settings.setApprovalPolicyEnabled(policyId, enabled),
    );
  } else {
    await getApplication().setPolicyEnabled(policyId, enabled);
  }
  revalidateSettings();
}

/** Remove a standing approval rule entirely — the tool goes back to asking. */
export async function deletePolicy(policyId: string): Promise<void> {
  await requireOwner();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    await runFirestoreSettingsMutation((settings) => settings.deleteApprovalPolicy(policyId));
  } else {
    await getApplication().deletePolicy(policyId);
  }
  revalidateSettings();
}

/** Add and inspect an owner-managed Streamable HTTP MCP server. */
export async function createMcpConnectionAction(input: {
  name: string;
  endpoint: string;
  bearerToken?: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return { error: problems.join('; ') };
    const bearerToken = input.bearerToken?.trim() ?? '';
    if (bearerToken.length > 8_192) return { error: 'Bearer token is too long.' };
    if (
      [...bearerToken].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f || /\s/u.test(character);
      })
    )
      return { error: 'Bearer token cannot contain whitespace or control characters.' };
    let bearerTokenEncrypted: string | null = null;
    try {
      bearerTokenEncrypted = bearerToken ? encryptMcpConnectionBearerToken(bearerToken) : null;
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unable to protect bearer token.' };
    }
    const result = await new FirestoreMcpConnectionMutationRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ).create({ name: input.name, endpoint: input.endpoint, bearerTokenEncrypted });
    if (!('connectionId' in result)) return { error: result.error };
    await discoverFirestoreMcpConnection(result.connectionId);
    revalidateSettings();
    return {};
  }
  const result = await getApplication().addMcpConnection(input);
  if ('error' in result) return { error: result.error };
  revalidateSettings();
  return {};
}

/** Re-run MCP tool discovery without changing the saved endpoint. */
export async function refreshMcpConnectionAction(id: string): Promise<{ error?: string }> {
  await requireOwner();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return { error: problems.join('; ') };
    const result = await discoverFirestoreMcpConnection(id);
    if (!('status' in result)) return { error: result.error };
    revalidateSettings();
    return {};
  }
  const result = await getApplication().refreshMcpConnection(id);
  if (!('status' in result)) return { error: result.error };
  revalidateSettings();
  return {};
}

/** Disable or re-enable a saved MCP connection. Re-enabling inspects it again. */
export async function setMcpConnectionEnabledAction(
  id: string,
  enabled: boolean,
): Promise<{ error?: string }> {
  await requireOwner();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return { error: problems.join('; ') };
    const result = await new FirestoreMcpConnectionMutationRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ).setEnabled(id, enabled);
    if (!result) return { error: 'MCP connection not found.' };
    if (enabled) {
      const discovery = await discoverFirestoreMcpConnection(id);
      if (!('status' in discovery)) return { error: discovery.error };
    }
    revalidateSettings();
    return {};
  }
  const result = await getApplication().setMcpConnectionEnabled(id, enabled);
  if ('error' in result) return { error: result.error };
  revalidateSettings();
  return {};
}

/** Forget a saved MCP endpoint and its discovered tool metadata. */
export async function deleteMcpConnectionAction(id: string): Promise<{ error?: string }> {
  await requireOwner();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return { error: problems.join('; ') };
    const deleted = await new FirestoreMcpConnectionMutationRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ).delete(id);
    if (!deleted) return { error: 'MCP connection not found.' };
    revalidateSettings();
    return {};
  }
  const deleted = await getApplication().deleteMcpConnection(id);
  if (!deleted) return { error: 'MCP connection not found.' };
  revalidateSettings();
  return {};
}

/**
 * Persist one env value into the repository .env, replacing the existing line
 * when present. Returns false when there is no .env to write — a Cloud Run
 * service is configured from injected env vars, and silently "rotating" only
 * the in-memory value would revert on the next instance recycle.
 *
 * The write is atomic (temp file + rename) with a `.bak` alongside: this file
 * is the single configuration source every local process reads at boot, so a
 * crash mid-write must not leave a truncated .env behind.
 */
/** On Cloud Run, fetch an access token for the web runtime's service account. */
async function metadataAccessToken(): Promise<string> {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Publish a new mobile-api-token version in Secret Manager, then make the
 * running instance use it. Only the versions become available — the service
 * refreshes `mobile-api-token:latest` across instances after rotation.
 */
async function publishToSecretManager(
  project: string,
  secretName: string,
  token: string,
): Promise<string | null> {
  const accessToken = await metadataAccessToken();
  const parent = `projects/${project}/secrets/${encodeURIComponent(secretName)}`;
  const res = await fetch(`https://secretmanager.googleapis.com/v1/${parent}:addVersion`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(token, 'utf8').toString('base64') } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return `Secret Manager rejected the rotation (${res.status}): ${detail.slice(0, 200)}`;
  }
  return null;
}

/**
 * Generate a new MOBILE_API_TOKEN and put it into effect. Two paths:
 *  - Local / self-hosted (.env present): persist to .env, reload in place.
 *  - Rotation-enabled Cloud Run installs publish to their configured secret.
 *    Immutable injected secrets intentionally have no rotation capability.
 * The new token is returned once so the UI can show it; the stored value is
 * only ever masked after this.
 */
export async function rotateMobileToken(): Promise<{ token?: string; error?: string }> {
  await requireOwner();
  const token = randomBytes(32).toString('hex');

  if (existsSync(envFile)) {
    persistSecretEnvValue(envFile, 'MOBILE_API_TOKEN', token);
  } else {
    const config = loadConfig();
    if (!hasMobileTokenRotationCapability(config)) {
      return { error: 'This installation does not support mobile access key rotation.' };
    }
    if (!config.GCP_PROJECT) {
      return { error: 'No .env file and no GCP_PROJECT — nowhere to persist the new key.' };
    }
    const secretError = await publishToSecretManager(
      config.GCP_PROJECT,
      config.MOBILE_API_TOKEN_SECRET_NAME,
      token,
    ).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (secretError) return { error: secretError };
  }

  // Load-bearing: dotenv does not override variables already present in
  // process.env, so the new value is set explicitly before the config cache
  // is dropped — otherwise reloadConfig() would re-parse the stale one.
  process.env.MOBILE_API_TOKEN = token;
  reloadConfig();
  clearMobileAccessTokenCache();
  revalidateSettings();
  return { token };
}

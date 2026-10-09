import { allowedArtifactPath } from '@assistant/persistence/artifact-path';
/**
 * Job input — arrives as the CODE_JOB_INPUT env var, produced by the agent's
 * launcher. This worker deliberately does NOT depend on @assistant/core (no DB
 * creds, no model SDKs in the image), so the spec shape is a minimal structural
 * copy of core's CodeSpecSchema.
 */

export interface CodeInput {
  workspacePath: string;
  as: string;
}

export interface CodeSpec {
  goal: string;
  language: 'javascript' | 'python';
  source: string;
  inputs?: CodeInput[];
  allowNetwork: boolean;
  timeoutSeconds: number;
}

/** Workspace areas an input may be staged from — mirrors core's CODE_INPUT_PREFIXES. */
export const CODE_INPUT_PREFIXES = ['code/', 'browser/attachments/', 'documents/', 'imports/'];
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_JOB_INPUT_BYTES = 3 * 1024 * 1024;
const MAX_INPUTS = 20;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JobStorageConfig {
  driver: 'gcs' | 'local';
  bucket?: string;
  prefix?: string;
  root?: string;
}

export interface JobInput {
  taskId: string;
  spec: CodeSpec;
  callbackUrl: string;
  callbackToken: string;
  storage: JobStorageConfig;
}

export function parseJobInput(raw: string | undefined): JobInput {
  if (!raw) throw new Error('CODE_JOB_INPUT is not set');
  if (Buffer.byteLength(raw, 'utf8') > MAX_JOB_INPUT_BYTES)
    throw new Error(`job input exceeds ${MAX_JOB_INPUT_BYTES} bytes`);
  const input = JSON.parse(raw) as JobInput;
  if (
    !TASK_ID.test(input.taskId) ||
    typeof input.callbackUrl !== 'string' ||
    !input.callbackUrl ||
    typeof input.callbackToken !== 'string' ||
    !input.callbackToken ||
    input.callbackToken.length > 128
  ) {
    throw new Error('job input missing taskId/callbackUrl/callbackToken');
  }
  if (!input.spec || typeof input.spec.source !== 'string' || input.spec.source.length === 0) {
    throw new Error('job input has no source');
  }
  if (typeof input.spec.goal !== 'string' || Buffer.byteLength(input.spec.goal, 'utf8') > 4000)
    throw new Error('invalid job goal');
  if (Buffer.byteLength(input.spec.source, 'utf8') > MAX_SOURCE_BYTES)
    throw new Error(`job source exceeds ${MAX_SOURCE_BYTES} bytes`);
  if (input.spec.language !== 'javascript' && input.spec.language !== 'python') {
    throw new Error(`unsupported language: ${input.spec.language}`);
  }
  if (
    !Number.isInteger(input.spec.timeoutSeconds) ||
    input.spec.timeoutSeconds < 1 ||
    input.spec.timeoutSeconds > 600
  ) {
    throw new Error('invalid job timeout');
  }
  if (typeof input.spec.allowNetwork !== 'boolean') throw new Error('invalid network policy');
  if (!input.storage?.driver) throw new Error('job input missing storage config');
  const inputs = input.spec.inputs ?? [];
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) throw new Error('too many job inputs');
  const names = new Set<string>();
  for (const artifact of inputs) {
    allowedArtifactPath(artifact.workspacePath, CODE_INPUT_PREFIXES);
    if (
      !/^[\w.-]{1,120}$/.test(artifact.as) ||
      ['.', '..'].includes(artifact.as) ||
      names.has(artifact.as.toLowerCase())
    )
      throw new Error('unsafe input filename');
    names.add(artifact.as.toLowerCase());
  }
  return input;
}

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { phoneSetupInputs, requiredPhonePrice } from './phone-setup-plan.js';

const envSchema = z.record(z.string(), z.string());
const snapshotSchema = z
  .object({
    env: envSchema,
    tokenReference: z.string().nullable(),
    timeout: z.number().int().positive(),
    revision: z.string(),
  })
  .strict();
const numberSchema = z
  .object({
    sid: z.string().regex(/^PN[0-9a-f]{32}$/i),
    phone: z.string().regex(/^\+[1-9]\d{6,14}$/),
    routingBefore: z.record(z.string(), z.string()),
  })
  .strict();
const routingSchema = z.record(z.string(), z.string());
const planSchema = z
  .object({
    project: z.string().regex(/^[a-z0-9][a-z0-9-]{3,62}$/),
    region: z.string().regex(/^[a-z][a-z0-9-]+$/),
    account: z.string().regex(/^AC[0-9a-f]{32}$/i),
    agentUrl: z.string(),
    webUrl: z.string(),
    ownerPhone: z.string(),
    agentModules: z.string(),
    webModules: z.string(),
    vertex: z.boolean(),
    serviceAccount: z.string().min(1),
    webServiceAccount: z.string().min(1),
    agentBefore: snapshotSchema,
    webBefore: snapshotSchema,
    number: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('existing'),
          ...numberSchema.shape,
          routingBefore: routingSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('purchase'),
          phone: numberSchema.shape.phone,
          monthlyUsd: z.string(),
        })
        .strict(),
    ]),
    transitionApproved: z.literal(true),
    purchaseApproved: z.boolean(),
  })
  .strict();

export type PhoneSetupPlan = z.infer<typeof planSchema>;
export type PhoneNumber = z.infer<typeof numberSchema>;
export type PhoneServiceSnapshot = z.infer<typeof snapshotSchema>;
export const phoneSetupSteps = [
  'secret',
  'secretAccess',
  'number',
  'voiceAccess',
  'agent',
  'web',
  'routing',
] as const;
export type PhoneSetupStep = (typeof phoneSetupSteps)[number];
const stepSchema = z.enum(phoneSetupSteps);
const effectSchema = z
  .object({
    status: z.enum(['intent', 'done']),
    result: z.unknown().optional(),
  })
  .strict();
const recordSchema = z
  .object({
    format: z.literal('assistant-phone-setup'),
    version: z.literal(1),
    id: z.string().uuid(),
    plan: planSchema,
    effects: z.partialRecord(stepSchema, effectSchema),
    complete: z.boolean(),
  })
  .strict();
export type PhoneSetupRecord = z.infer<typeof recordSchema>;

export function validatePhoneSetupPlan(value: unknown): PhoneSetupPlan {
  const plan = planSchema.parse(value);
  const parsed = phoneSetupInputs(plan);
  if (
    parsed.agentModules !== plan.agentModules ||
    parsed.webModules !== plan.webModules ||
    parsed.agentUrl !== plan.agentUrl ||
    parsed.webUrl !== plan.webUrl
  )
    throw new Error('Recovery plan is not a canonical phone configuration.');
  if (plan.number.kind === 'purchase') {
    requiredPhonePrice(plan.number.monthlyUsd);
    if (!plan.purchaseApproved) throw new Error('Phone purchase requires separate approval.');
  }
  return plan;
}

function checkedRecord(value: unknown): PhoneSetupRecord {
  const record = recordSchema.parse(value);
  validatePhoneSetupPlan(record.plan);
  let unfinished = false;
  for (const step of phoneSetupSteps) {
    const effect = record.effects[step];
    if (effect && unfinished) throw new Error('Recovery record has out-of-order effects.');
    if (effect?.status !== 'done') unfinished = true;
    if (effect?.status === 'done') {
      if (
        step === 'secret' &&
        (typeof effect.result !== 'string' || !/^[1-9]\d*$/.test(effect.result))
      )
        throw new Error('Recovery record needs the exact numeric secret version.');
      if (step === 'number') {
        const number = numberSchema.parse(effect.result);
        if (
          number.phone !== record.plan.number.phone ||
          (record.plan.number.kind === 'existing' && number.sid !== record.plan.number.sid)
        )
          throw new Error('Number receipt does not match the approved transition.');
      }
      if (
        (step === 'agent' || step === 'web') &&
        (typeof effect.result !== 'string' || !effect.result)
      )
        throw new Error('A service completion needs a confirmed ready revision.');
      if (['secretAccess', 'voiceAccess', 'routing'].includes(step) && effect.result !== true)
        throw new Error('A completed access or routing effect needs verified acceptance.');
    }
  }
  if (record.complete && unfinished)
    throw new Error('Incomplete effects cannot be called complete.');
  return record;
}

/** The journal contains configuration and receipts, never a Twilio token or cloud access token. */
export class PhoneSetupJournal {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const directory = lstatSync(dirname(path));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077)
      throw new Error('Phone recovery directory must be private (0700) and not a symlink.');
  }

  read(): PhoneSetupRecord | undefined {
    if (!existsSync(this.path)) return undefined;
    const info = lstatSync(this.path);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 128 * 1024)
      throw new Error('Invalid or nonprivate phone recovery record.');
    return checkedRecord(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  write(record: PhoneSetupRecord) {
    checkedRecord(record);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.path);
    const directory = openSync(dirname(this.path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  /** Crashed locks require explicit --recover-lock; a live process can never be unlocked. */
  lock(recover = false): () => void {
    const lockPath = `${this.path}.lock`;
    const recoveryPath = `${this.path}.recovering`;
    if (recover && existsSync(lockPath)) {
      const recovery = openSync(recoveryPath, 'wx', 0o600);
      try {
        const info = lstatSync(lockPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128)
          throw new Error('Invalid phone setup lock; inspect it manually.');
        const pid = Number(readFileSync(lockPath, 'utf8').trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock process ID.');
        try {
          process.kill(pid, 0);
          throw new Error('Phone setup is still running.');
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
            throw error;
        }
        unlinkSync(lockPath);
        // Acquire before releasing the recovery guard. A racing ordinary acquisition fails closed.
        const descriptor = openSync(lockPath, 'wx', 0o600);
        writeFileSync(descriptor, String(process.pid));
        fsyncSync(descriptor);
        closeSync(descriptor);
      } finally {
        closeSync(recovery);
        unlinkSync(recoveryPath);
      }
    } else {
      if (existsSync(recoveryPath)) throw new Error('Phone setup lock recovery is in progress.');
      try {
        const descriptor = openSync(lockPath, 'wx', 0o600);
        try {
          writeFileSync(descriptor, String(process.pid));
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
          throw new Error(
            'Phone setup has an existing lock. After an interruption use --resume --recover-lock.',
          );
        throw error;
      }
    }
    return () => unlinkSync(lockPath);
  }
}

export type PhoneSetupPorts = {
  /** Read-only permissions, service readiness, account and routing checks; must precede effects. */
  preflight: (record: PhoneSetupRecord) => Promise<void>;
  apply: (step: PhoneSetupStep, record: PhoneSetupRecord) => Promise<unknown>;
  /** undefined means acceptance is unknown: never silently repeat such an effect. */
  reconcile: (step: PhoneSetupStep, record: PhoneSetupRecord) => Promise<unknown | undefined>;
};

/** Routing changes last, after both deployments. Every dispatch has a durable prior intent. */
export async function runPhoneSetup(
  journal: PhoneSetupJournal,
  plan: PhoneSetupPlan,
  ports: PhoneSetupPorts,
): Promise<PhoneSetupRecord> {
  validatePhoneSetupPlan(plan);
  const record =
    journal.read() ??
    ({
      format: 'assistant-phone-setup',
      version: 1,
      id: randomUUID(),
      plan,
      effects: {},
      complete: false,
    } satisfies PhoneSetupRecord);
  if (JSON.stringify(record.plan) !== JSON.stringify(plan))
    throw new Error(
      'An existing recovery plan targets a different transition. Resume that plan first.',
    );
  if (record.complete) return record;
  await ports.preflight(record);
  journal.write(record);
  for (const step of phoneSetupSteps) {
    const effect = record.effects[step];
    if (effect?.status === 'done') continue;
    let result: unknown;
    if (effect?.status === 'intent') {
      result = await ports.reconcile(step, record);
      if (result === undefined)
        throw new Error(
          `The ${step} change has unknown acceptance. Inspect the recovery record and provider state; it will not be repeated automatically.`,
        );
    } else {
      record.effects[step] = { status: 'intent' };
      journal.write(record);
      result = await ports.apply(step, record);
    }
    record.effects[step] = { status: 'done', result };
    journal.write(record);
  }
  record.complete = true;
  journal.write(record);
  return record;
}

export function setupNumber(record: PhoneSetupRecord): PhoneNumber {
  return numberSchema.parse(record.effects.number?.result);
}

export function setupSecretVersion(record: PhoneSetupRecord): string {
  const value = record.effects.secret?.result;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    throw new Error('Missing pinned secret version.');
  return value;
}

/** A create-only secret per operation permits safe read-only reconciliation after a crash. */
export function setupSecretName(record: PhoneSetupRecord): string {
  return `twilio-phone-${record.id}`;
}

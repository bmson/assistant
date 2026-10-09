import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * One JSON evidence file per cutover step. Files are private (0600), created
 * once, and chained: each passed step records the SHA-256 of the previous
 * step's file, so later edits to earlier evidence are detectable. A failed
 * attempt is kept beside the step under an `.failed-<time>` name so the step
 * can be retried without losing what happened.
 */

export const EVIDENCE_FORMAT = 'assistant-cutover-evidence';

export type StepStatus = 'passed' | 'failed';

export type StepEvidence<T = unknown> = {
  format: typeof EVIDENCE_FORMAT;
  version: 1;
  step: string;
  index: number;
  status: StepStatus;
  mutating: boolean;
  confirmed: boolean;
  configSha256: string;
  previousSha256: string | null;
  startedAt: string;
  completedAt: string;
  result: T;
  error?: string;
};

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function durableCreateFile(path: string, contents: string | Buffer, mode = 0o600): void {
  const descriptor = openSync(path, 'wx', mode);
  try {
    if (typeof contents === 'string') writeSync(descriptor, contents);
    else writeSync(descriptor, contents, 0, contents.length);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Stable JSON: object keys sorted, so the config hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

export class EvidenceStore {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(this.privateDirectory, { recursive: true, mode: 0o700 });
  }

  /** Holds material that must never be copied into a report: bundles, manifests, rollback URIs. */
  get privateDirectory(): string {
    return join(this.directory, 'private');
  }

  fileName(index: number, step: string): string {
    return `${String(index).padStart(2, '0')}-${step}.json`;
  }

  path(index: number, step: string): string {
    return join(this.directory, this.fileName(index, step));
  }

  read<T = unknown>(index: number, step: string): StepEvidence<T> | null {
    const path = this.path(index, step);
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as StepEvidence<T>;
    if (value.format !== EVIDENCE_FORMAT || value.step !== step || value.index !== index)
      throw new Error(`Evidence file ${this.fileName(index, step)} is not valid cutover evidence`);
    return value;
  }

  fileSha256(index: number, step: string): string | null {
    const path = this.path(index, step);
    return existsSync(path) ? sha256Hex(readFileSync(path)) : null;
  }

  /** Create-only write. A failed attempt is archived first so a retry gets a fresh file. */
  write(evidence: StepEvidence): string {
    const path = this.path(evidence.index, evidence.step);
    const existing = this.read(evidence.index, evidence.step);
    if (existing?.status === 'passed')
      throw new Error(`Step ${evidence.step} already passed; its evidence is immutable`);
    if (existing) {
      const stamp = existing.completedAt.replace(/[:.]/g, '');
      renameSync(path, path.replace(/\.json$/, `.failed-${stamp}.json`));
    }
    durableCreateFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
    return path;
  }

  writePrivate(name: string, contents: string | Buffer, options: { overwrite?: boolean } = {}) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid private evidence file name');
    const path = join(this.privateDirectory, name);
    if (options.overwrite) {
      writeFileSync(path, contents, { flag: 'w', mode: 0o600 });
    } else {
      durableCreateFile(path, contents);
    }
    chmodSync(path, 0o600);
    return path;
  }

  /** 1 for the first attempt at a step, 2 after one archived failure, and so on. */
  attempt(index: number, step: string): number {
    const prefix = this.fileName(index, step).replace(/\.json$/, '.failed-');
    const failures = readdirSync(this.directory).filter((name) => name.startsWith(prefix)).length;
    return failures + (this.read(index, step)?.status === 'failed' ? 2 : 1);
  }

  /** A non-step record (for example a rollback) beside the step files. */
  writeRecord(name: string, value: unknown): string {
    if (!/^[a-z][a-zA-Z0-9._-]+\.json$/.test(name) || /^\d/.test(name))
      throw new Error('Invalid evidence record name');
    const path = join(this.directory, name);
    durableCreateFile(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  readRecord<T = unknown>(name: string): T | null {
    if (!/^[a-z][a-zA-Z0-9._-]+\.json$/.test(name) || /^\d/.test(name))
      throw new Error('Invalid evidence record name');
    const path = join(this.directory, name);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  }

  records<T = unknown>(prefix: string): Array<{ name: string; value: T }> {
    if (!/^[a-z][a-zA-Z0-9._-]*$/.test(prefix)) throw new Error('Invalid evidence record prefix');
    return readdirSync(this.directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
      .map((name) => ({
        name,
        value: JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as T,
      }));
  }

  privatePath(name: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid private evidence file name');
    return join(this.privateDirectory, name);
  }

  /** Every passed or failed step file, in step order (archived failures excluded). */
  list(): StepEvidence[] {
    return readdirSync(this.directory)
      .filter((name) => /^\d{2}-[a-z0-9-]+\.json$/.test(name))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as StepEvidence);
  }
}

/**
 * Check the chain: each passed step must record the hash of the previous
 * passed step's file and the same configuration hash.
 */
export function verifyEvidenceChain(
  store: EvidenceStore,
  steps: ReadonlyArray<{ index: number; name: string }>,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  let previous: string | null = null;
  let configSha: string | null = null;
  for (const step of steps) {
    const evidence = store.read(step.index, step.name);
    if (evidence?.status !== 'passed') break;
    if (evidence.previousSha256 !== previous)
      problems.push(`${step.name}: previous evidence hash does not match`);
    if (configSha && evidence.configSha256 !== configSha)
      problems.push(`${step.name}: configuration changed during the cutover`);
    configSha = evidence.configSha256;
    previous = store.fileSha256(step.index, step.name);
  }
  return { ok: problems.length === 0, problems };
}

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** Serialize local config writers and replace secrets using private, durable files. */
export function persistSecretEnvValue(path: string, key: string, value: string): boolean {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value))
    throw new Error('Invalid environment value');
  if (!existsSync(path)) return false;
  const lockPath = `${path}.lock`;
  const lock = openSync(lockPath, 'wx', 0o600);
  const temporary: string[] = [];
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error('Environment file must be a regular file');
    const content = readFileSync(path, 'utf8');
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    const updated = pattern.test(content)
      ? content.replace(pattern, () => line)
      : `${content.trimEnd()}\n${line}\n`;
    const replace = (target: string, bytes: string) => {
      const temp = `${path}.${randomUUID()}.tmp`;
      temporary.push(temp);
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, target);
    };
    // Keep only the immediately previous version, with the same private mode.
    replace(`${path}.bak`, content);
    replace(path, updated);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return true;
  } finally {
    for (const temp of temporary) if (existsSync(temp)) unlinkSync(temp);
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

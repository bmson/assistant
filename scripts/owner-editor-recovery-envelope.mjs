// Encrypt fixed proof objects only. Never import auth state or publish raw objects.
import {
  constants,
  createCipheriv,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const purpose = 'assistant-owner-editor-recovery-pair/v1';

export function recipient(pem) {
  if (
    typeof pem !== 'string' ||
    pem.length > 16384 ||
    !pem.includes('BEGIN PUBLIC KEY') ||
    pem.includes('PRIVATE KEY')
  ) {
    throw new Error('invalid_recipient');
  }
  const key = createPublicKey(pem);
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (key.asymmetricKeyType !== 'rsa' || !bits || bits < 3072 || bits > 8192)
    throw new Error('invalid_recipient');
  return key;
}

export function seal(folder, output, pem) {
  const key = recipient(pem);
  if (lstatSync(folder).isSymbolicLink()) throw new Error('invalid_objects');
  const names = readdirSync(folder)
    .filter((name) => name !== '.owner.json')
    .sort();
  if (names.length > 25 || !names.includes('collection-receipt.json'))
    throw new Error('invalid_objects');
  let total = 0;
  const objects = {};
  for (const name of names) {
    if (
      !/^(?:attempt-consumed|collection-receipt|(?:agent|web)-(?:subject|(?:sig|att)-(?:manifest|[0-3])))[.]json$/.test(
        name,
      )
    ) {
      throw new Error('invalid_objects');
    }
    const path = join(folder, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
      throw new Error('invalid_objects');
    total += stat.size;
    // Registry body budget excludes the small local receipts.
    if (total > 16 * 1024 * 1024 + 4096) throw new Error('objects_budget');
    objects[name] = readFileSync(path).toString('base64');
  }
  const symmetric = randomBytes(32);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', symmetric, nonce);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ purpose, objects })),
      cipher.final(),
    ]);
    const wrappedKey = publicEncrypt(
      { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      symmetric,
    );
    writeFileSync(
      output,
      JSON.stringify({
        version: 1,
        purpose,
        wrappedKey: wrappedKey.toString('base64'),
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }),
      { flag: 'wx', mode: 0o600 },
    );
  } finally {
    symmetric.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).join(' ') === '--verify-recipient')
      recipient(process.env.RECOVERY_RECIPIENT_PUBLIC_KEY);
    else if (process.argv.slice(2).join(' ') === '--seal') {
      if (!/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '')) throw new Error('invalid_run');
      seal(
        join(process.env.RUNNER_TEMP, `owner-editor-recovery-pair-${process.env.GITHUB_RUN_ID}`),
        join(process.env.GITHUB_WORKSPACE, 'owner-editor-recovery-pair.encrypted.json'),
        process.env.RECOVERY_RECIPIENT_PUBLIC_KEY,
      );
    } else throw new Error('unsupported_action');
  } catch {
    process.stderr.write('Recovery proof envelope stopped.\n');
    process.exitCode = 1;
  }
}

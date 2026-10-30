/** Private diagnostic transport only; never a readiness or maintenance packet. */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { packetRecipient } from './owner-editor-v1-packet.js';

const PURPOSE = 'assistant-owner-editor-inventory-failure-v1';
const MAX_STDERR = 16384;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
export interface FailureBinding {
  sourceSha: string;
  runId: string;
}
function binding(value: FailureBinding) {
  if (!/^[a-f0-9]{40}$/.test(value.sourceSha) || !/^[0-9]{1,20}$/.test(value.runId))
    throw new Error('Invalid diagnostic binding');
  return {
    purpose: PURPOSE,
    sourceSha: value.sourceSha,
    runId: value.runId,
    stage: 'cli_composites',
  };
}
export function verifyFailureRecipient(env: NodeJS.ProcessEnv): string | null {
  const pem = env.OWNER_EDITOR_DIAGNOSTIC_RECIPIENT_PUBLIC_KEY ?? '';
  const expected = env.OWNER_EDITOR_DIAGNOSTIC_SOURCE_SHA ?? '';
  if (!pem && !expected) return null;
  if (!pem || expected !== env.GITHUB_SHA) throw new Error('Invalid diagnostic source');
  binding({ sourceSha: expected, runId: env.GITHUB_RUN_ID ?? '' });
  packetRecipient(pem);
  return pem;
}
function privateStderr(error: unknown) {
  let value: unknown;
  try {
    if (error && typeof error === 'object') {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'stderr');
      if (descriptor && 'value' in descriptor) value = descriptor.value;
    }
  } catch {
    /* No coercion or getter invocation. */
  }
  const raw = typeof value === 'string' ? value : '';
  const bounded = Buffer.from(raw.slice(0, MAX_STDERR), 'utf8')
    .subarray(0, MAX_STDERR)
    .toString('utf8');
  const stderr = bounded
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(
      /("(?:access_token|id_token|refresh_token|client_secret|private_key|Authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bya29\.[A-Za-z0-9._~-]+/g, '[REDACTED_ACCESS_TOKEN]')
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
  let retained = Buffer.from(stderr, 'utf8').subarray(0, MAX_STDERR).toString('utf8');
  while (Buffer.byteLength(retained) > MAX_STDERR) retained = retained.slice(0, -1);
  return {
    stderr: retained,
    truncated: Buffer.byteLength(raw) > MAX_STDERR || Buffer.byteLength(stderr) > MAX_STDERR,
    stderrAvailable: typeof value === 'string',
  };
}
export function encryptInventoryFailure(
  error: unknown,
  publicKeyPem: string,
  source: FailureBinding,
) {
  const bound = binding(source),
    recipient = packetRecipient(publicKeyPem);
  const plaintext = Buffer.from(JSON.stringify({ ...bound, ...privateStderr(error) }));
  if (plaintext.length > 32768) throw new Error('Diagnostic bound');
  const key = randomBytes(32),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(bound)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: 1,
    ...bound,
    algorithm: 'RSA-OAEP-SHA256+A256GCM',
    recipientSha256: digest(recipient.export({ type: 'spki', format: 'der' })),
    key: publicEncrypt(
      { key: recipient, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
      key,
    ).toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
/** Local-only caller must write returned plaintext to a private file, never public logs. */
export function decryptInventoryFailure(raw: unknown, privateKeyPem: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || JSON.stringify(raw).length > 65536)
    throw new Error('Invalid diagnostic envelope');
  const env = raw as Record<string, unknown>;
  if (
    Object.keys(env).sort().join(',') !==
      'algorithm,ciphertext,format,iv,key,purpose,recipientSha256,runId,sourceSha,stage,tag' ||
    env.format !== 1 ||
    env.algorithm !== 'RSA-OAEP-SHA256+A256GCM' ||
    env.purpose !== PURPOSE ||
    env.stage !== 'cli_composites' ||
    typeof env.sourceSha !== 'string' ||
    typeof env.runId !== 'string'
  )
    throw new Error('Invalid diagnostic envelope');
  const bound = binding({ sourceSha: env.sourceSha, runId: env.runId });
  const privateKey = createPrivateKey(privateKeyPem),
    publicKey = createPublicKey(privateKey);
  if (
    privateKey.asymmetricKeyType !== 'rsa' ||
    digest(publicKey.export({ type: 'spki', format: 'der' })) !== env.recipientSha256
  )
    throw new Error('Wrong diagnostic recipient');
  const decoded = (field: string) => {
    const value = env[field];
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
      throw new Error('Invalid diagnostic envelope');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new Error('Invalid diagnostic envelope');
    return bytes;
  };
  const iv = decoded('iv'),
    tag = decoded('tag');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid diagnostic envelope');
  const key = privateDecrypt(
    { key: privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
    decoded('key'),
  );
  if (key.length !== 32) throw new Error('Invalid diagnostic envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(JSON.stringify(bound)));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(decoded('ciphertext')), decipher.final()]);
  if (plaintext.length > 32768) throw new Error('Diagnostic bound');
  const payload = JSON.parse(plaintext.toString('utf8'));
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join(',') !==
      'purpose,runId,sourceSha,stage,stderr,stderrAvailable,truncated' ||
    payload.purpose !== PURPOSE ||
    payload.sourceSha !== bound.sourceSha ||
    payload.runId !== bound.runId ||
    payload.stage !== bound.stage ||
    typeof payload.stderr !== 'string' ||
    Buffer.byteLength(payload.stderr) > 32768 ||
    typeof payload.truncated !== 'boolean' ||
    typeof payload.stderrAvailable !== 'boolean'
  )
    throw new Error('Invalid diagnostic payload');
  return payload as typeof bound & { stderr: string; truncated: boolean; stderrAvailable: boolean };
}

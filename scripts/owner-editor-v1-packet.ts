/** Private approval packet envelope, safe to retain as ciphertext in a public repository. */
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
import {
  type OwnerEditorMaintenancePacket,
  parseOwnerEditorMaintenancePacket,
} from '@assistant/firestore/owner-editor-maintenance';

const context = Buffer.from('assistant-owner-editor-v1-packet');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function maintenancePacketDigest(packet: unknown) {
  return digest(JSON.stringify(canonical(parseOwnerEditorMaintenancePacket(packet))));
}
export function packetRecipient(publicKeyPem: string) {
  if (
    publicKeyPem.length > 8192 ||
    !publicKeyPem.trim().startsWith('-----BEGIN PUBLIC KEY-----') ||
    !publicKeyPem.trim().endsWith('-----END PUBLIC KEY-----') ||
    publicKeyPem.includes('PRIVATE KEY')
  )
    throw new Error('Invalid packet recipient');
  const recipient = createPublicKey(publicKeyPem);
  const bits = recipient.asymmetricKeyDetails?.modulusLength ?? 0;
  if (recipient.asymmetricKeyType !== 'rsa' || bits < 3072 || bits > 8192)
    throw new Error('Invalid packet recipient');
  return recipient;
}
export function encryptMaintenancePacket(
  packet: OwnerEditorMaintenancePacket,
  publicKeyPem: string,
) {
  const recipient = packetRecipient(publicKeyPem);
  const plaintext = Buffer.from(JSON.stringify(parseOwnerEditorMaintenancePacket(packet)));
  if (plaintext.length > 8192) throw new Error('Packet bound');
  const key = randomBytes(32),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: 1,
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
export function decryptMaintenancePacket(
  raw: unknown,
  privateKeyPem: string,
): OwnerEditorMaintenancePacket {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid envelope');
  const env = raw as Record<string, unknown>;
  if (
    Object.keys(env).sort().join(',') !==
      'algorithm,ciphertext,format,iv,key,recipientSha256,tag' ||
    env.format !== 1 ||
    env.algorithm !== 'RSA-OAEP-SHA256+A256GCM' ||
    !['key', 'iv', 'tag', 'ciphertext', 'recipientSha256'].every(
      (k) => typeof env[k] === 'string',
    ) ||
    JSON.stringify(env).length > 16384
  )
    throw new Error('Invalid envelope');
  const privateKey = createPrivateKey(privateKeyPem),
    publicKey = createPublicKey(privateKey);
  if (
    privateKey.asymmetricKeyType !== 'rsa' ||
    digest(publicKey.export({ type: 'spki', format: 'der' })) !== env.recipientSha256
  )
    throw new Error('Wrong recipient');
  const decoded = (field: string) => {
    const value = env[field] as string;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid envelope');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new Error('Invalid envelope');
    return bytes;
  };
  const iv = decoded('iv'),
    tag = decoded('tag');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope');
  const key = privateDecrypt(
    { key: privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
    decoded('key'),
  );
  if (key.length !== 32) throw new Error('Invalid envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(context);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(decoded('ciphertext')), decipher.final()]);
  if (plaintext.length > 8192) throw new Error('Packet bound');
  return parseOwnerEditorMaintenancePacket(JSON.parse(plaintext.toString('utf8')));
}

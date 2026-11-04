import assert from 'node:assert/strict';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recipient, seal } from './owner-editor-recovery-envelope.mjs';

const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' });

test('only an existing public RSA recipient of the permitted size is accepted', () => {
  assert.equal(recipient(pem).asymmetricKeyType, 'rsa');
  const small = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => recipient(small.publicKey.export({ type: 'spki', format: 'pem' })));
  assert.throws(() => recipient(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })));
  assert.throws(() => recipient('invalid private-token'));
});

test('proof objects are encrypted, purpose-bound, private and never overwritten', () => {
  const folder = mkdtempSync(join(tmpdir(), 'owner-proof-envelope-'));
  const output = join(tmpdir(), `owner-proof-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(join(folder, 'web-subject.json'), 'private-object');
    writeFileSync(join(folder, 'collection-receipt.json'), '{"requests":10}');
    writeFileSync(join(folder, '.owner.json'), 'local ownership excluded');
    seal(folder, output, pem);
    const text = readFileSync(output, 'utf8');
    assert.ok(!text.includes('private-object'));
    assert.ok(!text.includes('local ownership'));
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const envelope = JSON.parse(text);
    const symmetric = privateDecrypt(
      { key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(envelope.wrappedKey, 'base64'),
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      symmetric,
      Buffer.from(envelope.nonce, 'base64'),
    );
    decipher.setAAD(Buffer.from(envelope.purpose));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const clear = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]),
    );
    assert.equal(
      Buffer.from(clear.objects['web-subject.json'], 'base64').toString(),
      'private-object',
    );
    assert.equal(clear.purpose, 'assistant-owner-editor-recovery-pair/v1');
    assert.throws(() => seal(folder, output, pem));
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(output, { force: true });
  }
});

test('unapproved names, symlinks and oversized objects fail closed', () => {
  for (const kind of ['name', 'symlink', 'size']) {
    const folder = mkdtempSync(join(tmpdir(), 'owner-proof-reject-'));
    const output = join(folder, 'must-not-exist');
    try {
      writeFileSync(join(folder, 'collection-receipt.json'), '{}');
      if (kind === 'name') writeFileSync(join(folder, 'credentials.json'), 'secret');
      if (kind === 'symlink') symlinkSync('/etc/hosts', join(folder, 'web-subject.json'));
      if (kind === 'size')
        writeFileSync(join(folder, 'web-subject.json'), Buffer.alloc(16 * 1024 * 1024 + 1));
      assert.throws(() => seal(folder, output, pem));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

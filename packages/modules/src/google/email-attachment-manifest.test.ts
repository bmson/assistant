import { emailAttachmentManifestDigest } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { preparedEmailAttachmentManifest } from './email-sync.js';

describe('prepared email attachment manifest', () => {
  it('binds provider attachment identity and safe metadata in order', () => {
    const parts = [
      {
        mimeType: 'application/pdf',
        filename: 'invoice.pdf',
        body: { attachmentId: 'att-a', size: 123 },
      },
      {
        mimeType: 'application/x-unknown',
        filename: 'ignore.bin',
        body: { attachmentId: 'att-b', size: 10 },
      },
      { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'att-c', size: 45 } },
    ];
    const payload = { mimeType: 'multipart/mixed', parts };
    const duplicatePart = {
      mimeType: 'application/pdf',
      filename: 'invoice.pdf',
      body: { attachmentId: 'att-a', size: 123 },
    };
    const first = preparedEmailAttachmentManifest(payload);
    const replay = preparedEmailAttachmentManifest(payload);
    expect(first).toEqual(replay);
    expect(emailAttachmentManifestDigest(first.entries)).toBe(first.digest);
    expect(first.entries).toEqual([
      {
        providerAttachmentId: 'att-a',
        ordinal: 0,
        filename: 'invoice.pdf',
        mime: 'application/pdf',
        advertisedBytes: 123,
      },
      {
        providerAttachmentId: 'att-c',
        ordinal: 1,
        filename: 'notes.txt',
        mime: 'text/plain',
        advertisedBytes: 45,
      },
    ]);
    expect(() => preparedEmailAttachmentManifest({ parts: [...parts, duplicatePart] })).toThrow(
      'attachment_manifest_duplicate_id',
    );
  });
});

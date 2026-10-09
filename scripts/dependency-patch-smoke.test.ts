import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

describe('patched image dependency runtime', () => {
  it('uses the fixed sharp/librsvg versions and rasterizes a simple SVG', async () => {
    expect(sharp.versions.sharp).toBe('0.35.5');
    expect(sharp.versions.rsvg).toBe('2.63.2');

    const png = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#fff"/></svg>',
      ),
    )
      .png()
      .toBuffer();

    await expect(sharp(png).metadata()).resolves.toMatchObject({
      format: 'png',
      width: 1,
      height: 1,
    });
  });
});

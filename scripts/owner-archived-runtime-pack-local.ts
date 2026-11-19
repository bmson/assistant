import { createHash } from 'node:crypto';
import { constants, createWriteStream, type WriteStream } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FIXED_METADATA, MAX_BUNDLE } from './owner-archived-runtime-hosted.js';
import { ARCHIVED_RUNTIME_PACK_SHA256 } from './owner-archived-runtime-input.js';

async function pack(directory: string, output: string) {
  const paths = [
    ...FIXED_METADATA,
    ...(await readdir(join(directory, 'blobs', 'sha256'))).map((name) => {
      if (!/^[a-f0-9]{64}$/.test(name)) throw new Error('invalid archive blob name');
      return `blobs/sha256/${name}`;
    }),
  ].sort();
  if (paths.length > 256) throw new Error('archive member limit');
  const files = await Promise.all(
    paths.map(async (path) => {
      const stat = await lstat(join(directory, path));
      if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0)
        throw new Error('invalid archive member');
      return { path, size: stat.size };
    }),
  );
  const header = Buffer.from(JSON.stringify({ format: 1, files }) + '\n');
  const size = files.reduce((sum, file) => sum + file.size, header.length);
  if (size > MAX_BUNDLE) throw new Error('archive bundle size limit');
  const objectHash = createHash('sha256');
  const fingerprint: [string, number, string][] = [];
  async function* payload() {
    objectHash.update(header);
    yield header;
    for (const file of files) {
      const contentHash = createHash('sha256');
      let count = 0;
      const source = await open(
        join(directory, file.path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      for await (const chunk of source.createReadStream()) {
        const bytes = chunk as Buffer;
        count += bytes.length;
        if (count > file.size) throw new Error('archive member changed while packing');
        contentHash.update(bytes);
        objectHash.update(bytes);
        yield bytes;
      }
      if (count !== file.size) throw new Error('archive member changed while packing');
      fingerprint.push([file.path, file.size, contentHash.digest('hex')]);
    }
    const packHash = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
    if (packHash !== ARCHIVED_RUNTIME_PACK_SHA256) throw new Error('archive fingerprint mismatch');
  }

  const stream: WriteStream = createWriteStream(output, { flags: 'wx', mode: 0o600 });
  let created = false;
  stream.once('open', () => {
    created = true;
  });
  try {
    await pipeline(Readable.from(payload()), stream);
  } catch (error) {
    if (created) await rm(output, { force: true });
    throw error;
  }
  return { bytes: size, objectSha256: objectHash.digest('hex') };
}

const [mode, directory, output] = process.argv.slice(2);
if (process.argv.length !== 5 || mode !== '--pack' || !directory || !output) {
  process.stderr.write(
    'Usage: tsx owner-archived-runtime-pack-local.ts --pack PACK_DIR NEW_OUTPUT\n',
  );
  process.exitCode = 1;
} else {
  pack(directory, output).then(
    (result) => process.stdout.write(JSON.stringify(result) + '\n'),
    () => {
      process.stderr.write('Archived runtime pack rejected\n');
      process.exitCode = 1;
    },
  );
}

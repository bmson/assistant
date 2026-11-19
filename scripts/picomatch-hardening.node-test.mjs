import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';

// This policy covers parser-recognized repeated extglobs. It does not make
// arbitrary regex syntax or caller-created parse states safe for untrusted input.
// Default to the exact matcher resolved from Vitest, not a global or a separate
// direct dependency.
const rootRequire = createRequire(import.meta.url);
const fromVitest = createRequire(rootRequire.resolve('vitest/package.json'));
const target = fromVitest.resolve('picomatch');
const packageRoot = dirname(target);
assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, '4.0.7');
const pm = rootRequire(target);
const reviewedPatchHash = 'f615c03a5e48b398155c785b1a4dbad69c0adf31442d9d5e5c22e96951762c1a';

/** Validate pnpm's canonical v9 lock sections, failing closed on unfamiliar
 * Picomatch references instead of trying to infer their resolution. */
function validatePicomatchLock(lock, patchHash) {
  assert.match(lock, /^lockfileVersion: '9\.0'$/m);
  const sections = new Map();
  let section;
  for (const line of lock.split(/\r?\n/)) {
    const top = /^([A-Za-z][A-Za-z0-9]*):\s*$/.exec(line);
    if (top) {
      section = top[1];
      assert.ok(!sections.has(section), `duplicate lock section: ${section}`);
      sections.set(section, []);
    } else if (section) sections.get(section).push(line);
  }
  for (const required of ['patchedDependencies', 'importers', 'packages', 'snapshots'])
    assert.ok(sections.has(required), `missing lock section: ${required}`);
  const entries = (name) =>
    sections.get(name).flatMap((line) => {
      const match = /^ {2}([^\s][^:]*):(?:\s.*)?$/.exec(line);
      return match ? [match[1]] : [];
    });
  assert.deepEqual(
    entries('patchedDependencies').filter((key) => key.includes('picomatch@')),
    ['picomatch@4.0.7'],
  );
  assert.deepEqual(
    entries('packages').filter((key) => key.includes('picomatch@')),
    ['picomatch@4.0.7'],
  );
  for (const line of sections.get('packages')) {
    if (line.includes('picomatch@')) assert.match(line, /^ {2}picomatch@4\.0\.7:\s*$/);
  }
  const patched = `picomatch@4.0.7(patch_hash=${patchHash})`;
  assert.deepEqual(
    entries('snapshots').filter((key) => key.startsWith('picomatch@')),
    [patched],
  );
  const patchSection = sections.get('patchedDependencies').join('\n');
  assert.match(
    patchSection,
    new RegExp(
      `^  picomatch@4\\.0\\.7:\\n    hash: ${patchHash}\\n    path: patches/picomatch@4\\.0\\.7\\.patch$`,
      'm',
    ),
  );
  for (const name of ['importers', 'snapshots']) {
    const lines = sections.get(name);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Covers peer-context keys and npm aliases in addition to direct snapshots.
      let offset = line.indexOf('picomatch@');
      while (offset !== -1) {
        const end = offset + patched.length;
        assert.ok(
          line.startsWith(patched, offset) && (end === line.length || /[)\s:'"]/.test(line[end])),
          `unreviewed Picomatch reference in ${name}`,
        );
        offset = line.indexOf('picomatch@', end);
      }
      const dependency = /^(\s+)(?:picomatch|'picomatch'|"picomatch"):\s*(.*?)\s*$/.exec(line);
      if (!dependency && /(?:^|[\s{,])['"]?picomatch['"]?:/.test(line))
        assert.fail(`unrecognized Picomatch dependency in ${name}`);
      if (!dependency) continue;
      let version = dependency[2];
      if (!version) {
        const indent = dependency[1].length;
        const fields = [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (next.trim() && next.length - next.trimStart().length <= indent) break;
          const field = /^\s+version:\s*(\S+)\s*$/.exec(next);
          if (field) fields.push(field[1]);
        }
        assert.equal(fields.length, 1, 'Picomatch importer must have one resolved version');
        [version] = fields;
      }
      assert.equal(
        version.replace(/^['"]|['"]$/g, ''),
        `4.0.7(patch_hash=${patchHash})`,
        `unreviewed Picomatch dependency in ${name}`,
      );
    }
  }
}

test('installed parser is bound to the exact reviewed lockfile patch', () => {
  const patch = readFileSync(new URL('../patches/picomatch@4.0.7.patch', import.meta.url));
  const patchHash = createHash('sha256').update(patch).digest('hex');
  const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.equal(patchHash, reviewedPatchHash);
  validatePicomatchLock(lock, patchHash);
  assert.ok(target.includes(`picomatch@4.0.7_patch_hash=${patchHash}`));
  const parserHash = createHash('sha256')
    .update(readFileSync(join(packageRoot, 'lib/parse.js')))
    .digest('hex');
  assert.equal(parserHash, 'a8c2b3b6fb63feabd51e3be009d92edaefad62cda67bb0996663f352d1c61cda');
});

test('lock validation rejects additional versions, unpatched snapshots and references', () => {
  const hash = reviewedPatchHash;
  const fixture = `lockfileVersion: '9.0'\n\npatchedDependencies:\n  picomatch@4.0.7:\n    hash: ${hash}\n    path: patches/picomatch@4.0.7.patch\n\nimporters:\n  .: {}\n\npackages:\n  picomatch@4.0.7:\n    resolution: {}\n\nsnapshots:\n  picomatch@4.0.7(patch_hash=${hash}): {}\n  consumer@1.0.0:\n    dependencies:\n      picomatch: 4.0.7(patch_hash=${hash})\n`;
  assert.doesNotThrow(() => validatePicomatchLock(fixture, hash));
  const withImporter = fixture.replace(
    '  .: {}',
    `  .:\n    devDependencies:\n      picomatch:\n        specifier: ^4.0.7\n        version: 4.0.7(patch_hash=${hash})`,
  );
  assert.doesNotThrow(() => validatePicomatchLock(withImporter, hash));
  for (const invalid of [
    fixture.replace('packages:\n', 'packages:\n  picomatch@2.3.1:\n    resolution: {}\n'),
    fixture.replace('snapshots:\n', 'snapshots:\n  picomatch@2.3.1: {}\n'),
    fixture.replace('snapshots:\n', 'snapshots:\n  picomatch@4.0.7: {}\n'),
    fixture.replace(`picomatch: 4.0.7(patch_hash=${hash})`, 'picomatch: 4.0.7'),
    withImporter.replace(`version: 4.0.7(patch_hash=${hash})`, 'version: 4.0.7'),
    fixture.replace('consumer@1.0.0:', 'consumer@1.0.0(picomatch@2.3.1):'),
    fixture.replace(
      'consumer@1.0.0:',
      `consumer@1.0.0(picomatch@4.0.7(patch_hash=${hash})suffix):`,
    ),
    fixture.replace(`hash: ${hash}`, `hash: ${'0'.repeat(64)}`),
    fixture.replace('snapshots:\n', 'unexpected:\n'),
  ])
    assert.throws(() => validatePicomatchLock(invalid, hash));
});

function subprocess(program, args) {
  const child = spawnSync(process.execPath, ['-e', program, target, ...args], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(child.error?.code, undefined, `matcher child failed or timed out: ${child.error}`);
  assert.equal(child.status, 0, `matcher child failed: ${child.stderr}`);
}

const rejectChild = String.raw`
  const assert = require('node:assert/strict');
  const pm = require(process.argv[1]);
  const pattern = process.argv[2];
  const text = 'a'.repeat(32) + '!';
  const options = [{}, { fastpaths: false }, { maxExtglobRecursion: false },
    { contains: true, capture: true }, { windows: true, bash: true }];
  const apis = [
    (p, o) => pm.parse(p, o),
    (p, o) => pm.makeRe(p, o),
    (p, o) => pm.isMatch(text, p, o),
    (p, o) => pm(p, o)(text),
  ];
  for (const opts of options) for (const call of apis) {
    assert.throws(() => call(pattern, opts), error =>
      error instanceof SyntaxError && error.message === 'Repeated extglobs are disabled by repository policy');
  }
`;

test('repeated extglobs fail closed through every string-pattern entry point', () => {
  // Even valid simple repetitions are intentionally unsupported by this policy.
  for (const pattern of [
    '+(*)',
    '+(*a)',
    '+(a*)',
    '+(*(a)?)',
    '*(a|b)',
    '+(js|jsx)',
    'src/**/+(js|jsx)',
    '*/+(a)',
    '@(a|+(b))',
    '+([a-z])',
  ])
    subprocess(rejectChild, [pattern]);
});

test('ordinary globs, braces, nonrepeated extglobs and paths retain behavior', () => {
  for (const [input, pattern, options, expected] of [
    ['src/a.ts', 'src/**/*.{ts,js}', {}, true],
    ['src/deep/a.js', 'src/**/*.{ts,js}', {}, true],
    ['src/a.css', 'src/**/*.{ts,js}', {}, false],
    ['src/.hidden', 'src/*', {}, false],
    ['src/.hidden', 'src/*', { dot: true }, true],
    ['src/a/b', 'src/*', {}, false],
    ['a\\b.js', 'a/*.js', { windows: true }, true],
    ['foo', '@(foo|bar)', {}, true],
    ['bar', '?(foo|bar)', {}, true],
    ['baz', '@(foo|bar)', {}, false],
    ['+abc', '\\+(abc)', {}, true],
    ['+abc', '[+](abc)', {}, true],
    ['x*', 'x[*]', {}, true],
  ])
    assert.equal(pm.isMatch(input, pattern, options), expected, `${input} against ${pattern}`);
});

test('arrays, ignore patterns, and exposed fastpaths do not compile repeated extglobs', () => {
  const parse = rootRequire(join(packageRoot, 'lib/parse.js'));
  for (const pattern of ['+(*)', '*(a|b)', '*/+(a)']) {
    assert.equal(parse.fastpaths(pattern, {}), undefined);
    assert.throws(() => pm(['*.ts', pattern]), SyntaxError);
    assert.throws(() => pm.parse(['*.ts', pattern]), SyntaxError);
    assert.throws(() => pm('*.ts', { ignore: pattern }), SyntaxError);
  }
});

test('noextglob treats the operators through its existing non-extglob parser', () => {
  const program = String.raw`
    const assert = require('node:assert/strict');
    const pm = require(process.argv[1]);
    for (const [pattern, expected] of [['+(*)', true], ['+(*a)', false], ['+(*(a)?)', true], ['*(a|b)', false]]) {
      for (const opts of [{noextglob:true}, {noextglob:true,fastpaths:false}, {noextglob:true,maxExtglobRecursion:false}]) {
        const regex = pm.makeRe(pattern, opts);
        assert.ok(regex instanceof RegExp);
        assert.equal(pm.isMatch('+' + 'a'.repeat(32) + '!', pattern, opts), expected);
      }
    }
  `;
  subprocess(program, []);
});

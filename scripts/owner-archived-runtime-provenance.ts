import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ArchivedRoleEvidence } from './owner-archived-runtime-pack.js';

const ORIGINAL_SOURCE = '1c2ea3907bf17b14368846708002f9d4633f2092';
const ORIGINAL_RUN = '44263661117';
const WORKFLOW_REF = 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main';
const WORKFLOW_IDENTITY = `https://github.com/${WORKFLOW_REF}`;
const ISSUER = 'https://token.actions.githubusercontent.com';
const INVOCATION = `https://github.com/bmson/assistant/actions/runs/${ORIGINAL_RUN}/attempts/1`;
const IMAGE_ROOT = 'us-west1-docker.pkg.dev/bmson-assistant/assistant';

const ROLES = ['agent', 'web'] as const;
type Role = (typeof ROLES)[number];

// Exact archived release-44263661117/attempt 1 bytes, independently verified
// against the original Sigstore subjects and historical trust material.
const EXPECTED = {
  agent: {
    parent: '1298263587c4021246c7a4832e174ea95bb5a5a2ffef8359b989ba60d694690b',
    child: '7ab38d59edcf5d5f47a0884a928249ffd4e0457aa67f3cbf948fae4cb17c65e5',
    receipt: '1c5c71f1d9265f7d9809d7e9d974c7c60ddb643c86617f67115282a8ed7fd4ae',
    signature: '3622eb1ee86309014fb951c866bb1dfa3e5a5ec6936898138d1819265e9b1705',
    sbom: '774532041b045bf81db58ffc78b20096e7529a6503b86bf4a4a406694910fc95',
  },
  web: {
    parent: '34d027a7e04daf667428d615f60fb537b5090caf785a3c4f65db0a714b42eb0a',
    child: 'fde5cc2ae8bfe91405a4c5a56bcac59cff74f951f89e542a05b387fcc82e8d36',
    receipt: '42f8055c7c691fe38d05fdf28036d3c326f4f87616972c0c143b81fe2e63cc1e',
    signature: 'dd82ff571add460de5d6a8858fe92e5da060907ccdbf86f99d264e5ddb11fa99',
    sbom: '1fc9e4fb591e0584f4abe503f6a172decdcba8c0c114b676ddd74ff45f8eb5f3',
  },
} as const;
const TRUST_ROOT = '6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66';

// SHA-256 values from the immutable official Cosign v3.1.4 release checksums.
const COSIGN_SHA256: Partial<Record<string, string>> = {
  'darwin-arm64': '9f9b8cd557cf2e5b3df3373a00baa005a86b02391e3e06dd0ce37b3a1533d3a4',
  'linux-x64': '424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa',
};
const COSIGN = fileURLToPath(
  new URL('../.artifacts/archived-runtime-tools/cosign', import.meta.url),
);
const exec = promisify(execFile);
const MAX_BUNDLE = 4 * 1024 * 1024;
const MAX_ROOT = 256 * 1024;
const MAX_BINARY = 160 * 1024 * 1024;
const PROXY = 'http://127.0.0.1:1';

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Archived runtime provenance: ${label}`);
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bounded(bytes: unknown, max: number): asserts bytes is Buffer {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= max, 'invalid input size');
}

function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'invalid JSON object');
  return value as Record<string, unknown>;
}

function parse(bytes: Buffer) {
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

function decode(value: unknown, max: number): Buffer {
  check(typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4, 'invalid base64 size');
  const bytes = Buffer.from(value, 'base64');
  check(
    bytes.length > 0 && bytes.length <= max && bytes.toString('base64') === value,
    'invalid base64',
  );
  return bytes;
}

function verifyReceipt(role: Role, evidence: ArchivedRoleEvidence) {
  bounded(evidence.receipt, 4096);
  const receipt = parse(evidence.receipt);
  check(
    receipt.format === 1 &&
      receipt.image === `${IMAGE_ROOT}/${role}` &&
      receipt.source === ORIGINAL_SOURCE &&
      receipt.workflowSha === ORIGINAL_SOURCE &&
      receipt.workflowRef === WORKFLOW_REF &&
      receipt.runId === ORIGINAL_RUN &&
      receipt.runAttempt === '1' &&
      receipt.registryManifestDigest === `sha256:${EXPECTED[role].parent}`,
    `${role} build receipt identity mismatch`,
  );
}

function verifyImage(role: Role, evidence: ArchivedRoleEvidence) {
  bounded(evidence.parent, 16 * 1024);
  bounded(evidence.child, 16 * 1024);
  check(sha256(evidence.parent) === EXPECTED[role].parent, `${role} OCI parent digest mismatch`);
  check(sha256(evidence.child) === EXPECTED[role].child, `${role} OCI child digest mismatch`);
  const parent = parse(evidence.parent);
  check(Array.isArray(parent.manifests), `${role} OCI index missing descriptors`);
  const matching = parent.manifests.map(object).filter((descriptor) => {
    const platform = object(descriptor.platform);
    return platform.os === 'linux' && platform.architecture === 'amd64';
  });
  check(
    matching.length === 1 &&
      matching[0]?.digest === `sha256:${EXPECTED[role].child}` &&
      matching[0]?.size === evidence.child.length,
    `${role} OCI runtime child binding mismatch`,
  );
}

function verifyBundle(role: Role, kind: 'signature' | 'sbom', bytes: Buffer) {
  bounded(bytes, MAX_BUNDLE);
  check(sha256(bytes) === EXPECTED[role][kind], `${role} ${kind} bundle digest mismatch`);
  const bundle = parse(bytes);
  check(
    bundle.mediaType === 'application/vnd.dev.sigstore.bundle.v0.3+json',
    'invalid bundle format',
  );
  const envelope = object(bundle.dsseEnvelope);
  const statement = parse(decode(envelope.payload, MAX_BUNDLE));
  const predicate =
    kind === 'signature' ? 'https://sigstore.dev/cosign/sign/v1' : 'https://spdx.dev/Document';
  check(
    statement.predicateType === predicate &&
      Array.isArray(statement.subject) &&
      statement.subject.length === 1,
    'invalid attestation statement',
  );
  const subject = object(statement.subject[0]);
  const digest = object(subject.digest);
  check(
    Object.keys(digest).length === 1 && digest.sha256 === EXPECTED[role].parent,
    'attestation subject mismatch',
  );
  if (kind === 'sbom') {
    check(
      subject.name === `${IMAGE_ROOT}/${role}` &&
        object(statement.predicate).spdxVersion === 'SPDX-2.3',
      'SPDX subject mismatch',
    );
  }

  const material = object(bundle.verificationMaterial);
  check(
    Array.isArray(material.tlogEntries) && material.tlogEntries.length > 0,
    'missing transparency evidence',
  );
  const certificate = new X509Certificate(decode(object(material.certificate).rawBytes, 16 * 1024));
  // In these exact pinned certificates Fulcio extension 1.3.6.1.4.1.57264.1.21
  // is a noncritical DER OCTET STRING wrapping a UTF8String. Match the entire
  // encoded extension including its OID and lengths, not an unscoped URI.
  const invocation = Buffer.from(INVOCATION);
  const oid = Buffer.from('060a2b0601040183bf300115', 'hex');
  const extension = Buffer.concat([
    Buffer.from([0x30, oid.length + invocation.length + 4]),
    oid,
    Buffer.from([0x04, invocation.length + 2, 0x0c, invocation.length]),
    invocation,
  ]);
  check(certificate.raw.includes(extension), 'Fulcio build invocation mismatch');
  return predicate;
}

async function pinnedCosign(directory: string) {
  const expected = COSIGN_SHA256[`${process.platform}-${process.arch}`];
  check(expected, 'unsupported verifier platform');
  const source = await lstat(COSIGN);
  check(
    source.isFile() && source.size > 0 && source.size <= MAX_BINARY,
    'invalid verifier executable',
  );
  const executable = join(directory, 'cosign');
  await copyFile(COSIGN, executable);
  const copied = await lstat(executable);
  check(copied.isFile() && copied.size <= MAX_BINARY, 'invalid verifier executable');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  check(hash.digest('hex') === expected, 'verifier executable hash mismatch');
  await chmod(executable, 0o700);
  return executable;
}

/** Confirm only the two exact archived original image bindings. No Registry request. */
export async function verifyArchivedRuntimeProvenance(
  roles: Record<Role, ArchivedRoleEvidence>,
  trustedRoot: Buffer,
): Promise<void> {
  bounded(trustedRoot, MAX_ROOT);
  for (const role of ROLES) {
    check(roles[role], `${role} evidence missing`);
    verifyReceipt(role, roles[role]);
  }
  check(sha256(trustedRoot) === TRUST_ROOT, 'trust root digest mismatch');
  const bundles = ROLES.flatMap((role) => {
    const evidence = roles[role];
    check(
      sha256(evidence.receipt) === EXPECTED[role].receipt,
      `${role} build receipt digest mismatch`,
    );
    verifyImage(role, evidence);
    return (['signature', 'sbom'] as const).map((kind) => {
      const predicate = verifyBundle(role, kind, evidence[kind]);
      return { role, kind, bytes: Buffer.from(evidence[kind]), predicate };
    });
  });
  const rootBytes = Buffer.from(trustedRoot);
  const directory = await mkdtemp(join(tmpdir(), 'assistant-archived-provenance-'));
  try {
    const executable = await pinnedCosign(directory);
    const root = join(directory, 'trusted-root.json');
    await writeFile(root, rootBytes, { flag: 'wx', mode: 0o600 });
    for (const { role, kind, bytes, predicate } of bundles) {
      const input = join(directory, `${role}-${kind}.json`);
      await writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
      try {
        await exec(
          executable,
          [
            'verify-blob-attestation',
            '--bundle',
            input,
            '--trusted-root',
            root,
            '--certificate-identity',
            WORKFLOW_IDENTITY,
            '--certificate-oidc-issuer',
            ISSUER,
            '--certificate-github-workflow-sha',
            ORIGINAL_SOURCE,
            '--certificate-github-workflow-repository',
            'bmson/assistant',
            '--certificate-github-workflow-ref',
            'refs/heads/main',
            '--certificate-github-workflow-trigger',
            'workflow_dispatch',
            '--type',
            predicate,
            '--digest',
            EXPECTED[role].parent,
            '--digestAlg',
            'sha256',
            '--timeout',
            '8s',
          ],
          {
            cwd: directory,
            env: {
              TUF_ROOT: join(directory, 'sigstore-tuf'),
              XDG_CACHE_HOME: join(directory, 'cache'),
              LANG: 'C',
              HTTPS_PROXY: PROXY,
              HTTP_PROXY: PROXY,
              ALL_PROXY: PROXY,
            },
            timeout: 10_000,
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024,
          },
        );
      } catch {
        throw new Error(
          `Archived runtime provenance: ${role} ${kind} cryptographic verification failed`,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

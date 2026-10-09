import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GENERATED_CARD_NATIVE_CONTRACT } from '@assistant/persistence/card-capabilities';

const outputPath = resolve(
  process.cwd(),
  'apps/ios/Assistant/Components/GeneratedCardCapabilityManifest.swift',
);

export function renderManifest(): string {
  const json = JSON.stringify(GENERATED_CARD_NATIVE_CONTRACT, null, 2);
  return `// Generated from packages/persistence/src/card-capabilities.ts. Do not edit by hand.\nimport Foundation\n\nenum GeneratedCardCapabilityManifest {\n    static let contract: [String: Any] = {\n        let data = Data(#"""\n${json}\n"""#.utf8)\n        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]\n    }()\n}\n`;
}

const expected = renderManifest();
if (process.argv.includes('--check')) {
  const actual = await readFile(outputPath, 'utf8').catch(() => '');
  if (actual !== expected) {
    console.error(
      'Generated iOS card capability manifest is stale. Run the generator to refresh it.',
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, expected);
}

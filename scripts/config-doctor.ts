import { loadConfig, modelProviderConfigProblems } from '@assistant/config';
import {
  moduleDiagnostics,
  proactiveConfigNotes,
  validateAssistantConfig,
} from '@assistant/modules/meta';

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  console.error('Configuration is invalid.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`Assistant: ${config.ASSISTANT_NAME} <${config.ASSISTANT_EMAIL}>`);
console.log(`Workspace: workspace/${config.ASSISTANT_WORKSPACE_ID}`);
console.log(
  `Runtime: ${
    config.QUEUE_DRIVER === 'cloudtasks'
      ? 'Google Cloud'
      : config.QUEUE_DRIVER === 'inert'
        ? 'inert restore rehearsal'
        : 'local'
  }`,
);
console.log('Modules:');
for (const diagnostic of moduleDiagnostics(config)) {
  const marker = !diagnostic.enabled ? '○' : diagnostic.ready ? '✓' : '!';
  console.log(`  ${marker} ${diagnostic.module}: ${diagnostic.detail}`);
}

// Settings that are valid but leave the assistant mute. Printed before the
// pass/fail line because a "Configuration is ready." with an empty inbox behind
// it is exactly the confusion this whole check exists to prevent.
const notes = proactiveConfigNotes(config);
if (notes.length > 0) {
  console.warn('Proactive behaviour:');
  for (const note of notes) console.warn(`  ! ${note}`);
}

const problems = validateAssistantConfig(config);
if (problems.length > 0) {
  console.error('Production configuration problems:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else if (modelProviderConfigProblems(config).length > 0) {
  console.warn(modelProviderConfigProblems(config).join('; '));
} else {
  console.log('Configuration is ready.');
}

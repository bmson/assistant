import { writeFileSync } from 'node:fs';

export interface SetupEnvValues {
  [name: string]: string;
}

function setValue(source: string, name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${name} cannot contain a newline`);
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  return pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`;
}

/** Fill the local template and omit empty placeholders so optional schema keys stay absent. */
export function generateSetupEnv(source: string, values: SetupEnvValues): string {
  let env = source;
  for (const [name, value] of Object.entries(values)) env = setValue(env, name, value);
  return env.replace(/^[A-Z][A-Z0-9_]*=[\t ]*(?:\r?\n|$)/gm, '');
}

export function writePrivateSetupEnv(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

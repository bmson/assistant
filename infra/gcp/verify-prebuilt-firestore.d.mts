export function verifyReuseContext(env: NodeJS.ProcessEnv, source: string): void;
export function verifyRoleReceipt(
  receipt: unknown,
  role: 'agent' | 'web' | 'browser' | 'code' | 'processor',
  source: string,
  runId: string,
): string;

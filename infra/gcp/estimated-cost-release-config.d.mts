export interface EstimatedCostReleaseProfile {
  format: 1;
  mode: 'compatible-off' | 'enable';
  source: string;
  projectId: string;
  projectNumber?: string;
  installationId: string;
  ownerId: string;
  providerSecret: string;
  providerVersion: string;
  reviewedAt: string;
  expiresAt: string;
  baselineReceiptSha256?: string;
  writersReceiptSha256?: string;
  drainReceiptSha256?: string;
}
export type EstimatedCostReleaseExpectations = Partial<
  Pick<
    EstimatedCostReleaseProfile,
    'source' | 'projectId' | 'projectNumber' | 'installationId' | 'ownerId'
  >
> & { now?: Date | number };
export function validateEstimatedCostReleaseProfile(
  profile: unknown,
  expected?: EstimatedCostReleaseExpectations,
): EstimatedCostReleaseProfile;
export function estimatedCostReleaseProfile(
  raw: unknown,
  expected?: EstimatedCostReleaseExpectations,
): EstimatedCostReleaseProfile | undefined;
export function estimatedCostReleaseEnvironment(
  profile: EstimatedCostReleaseProfile,
): Record<string, string>;
export function pinEstimatedCostProvider(
  env: unknown[],
  profile: EstimatedCostReleaseProfile,
): unknown[];
export function verifyEstimatedCostProvider(
  env: unknown[],
  profile: EstimatedCostReleaseProfile,
): void;
export function estimatedCostNativeEnvironment(raw: unknown): unknown[];
export function requireEstimatedCostReleaseProfile(
  raw: unknown,
  profile?: EstimatedCostReleaseProfile,
): void;
export function estimatedCostAgentArguments(
  raw: unknown,
  profile: EstimatedCostReleaseProfile,
  existingAssignments: string,
): { envArgument: string; secretArgument: string };
export function validateEstimatedCostReleaseInvocation(
  profile: EstimatedCostReleaseProfile | undefined,
  env: Record<string, string | undefined>,
  now?: number,
): void;

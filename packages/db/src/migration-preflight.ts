export function shouldBootstrap0019Targets(input: {
  modelsTableExists: boolean;
  roleTableExists: boolean;
  journalExists: boolean;
  appliedMigrations: number;
  extractRoleExists: boolean;
}): boolean {
  return (
    input.modelsTableExists &&
    input.roleTableExists &&
    input.journalExists &&
    input.appliedMigrations < 20 &&
    input.extractRoleExists
  );
}

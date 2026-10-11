/** Return true when any member of a process group can still execute. */
export function processGroupHasLiveMembers(states: readonly string[]): boolean {
  return states.some((state) => !state.startsWith('Z') && !state.startsWith('X'));
}

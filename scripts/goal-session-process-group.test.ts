import { describe, expect, it } from 'vitest';
import { processGroupHasLiveMembers } from './goal-session-process-group.js';

describe('goal-session process group liveness', () => {
  it('treats an absent or zombie-only group as quiescent', () => {
    expect(processGroupHasLiveMembers([])).toBe(false);
    expect(processGroupHasLiveMembers(['Z'])).toBe(false);
    expect(processGroupHasLiveMembers(['Z+', 'X'])).toBe(false);
  });

  it('keeps any live or unrecognized process state fail-closed', () => {
    expect(processGroupHasLiveMembers(['Z', 'S'])).toBe(true);
    expect(processGroupHasLiveMembers(['R'])).toBe(true);
    expect(processGroupHasLiveMembers(['?'])).toBe(true);
  });
});

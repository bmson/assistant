import type { ResearchAssignmentRepository } from '@assistant/persistence';
export function createResearchAssignmentRecord(
  repository: ResearchAssignmentRepository,
  ...args: Parameters<ResearchAssignmentRepository['createResearchAssignmentRecord']>
) {
  return repository.createResearchAssignmentRecord(...args);
}
export function editResearchAssignmentRecord(
  repository: ResearchAssignmentRepository,
  ...args: Parameters<ResearchAssignmentRepository['editResearchAssignmentRecord']>
) {
  return repository.editResearchAssignmentRecord(...args);
}
export function reopenResearchAssignmentRecord(
  repository: ResearchAssignmentRepository,
  ...args: Parameters<ResearchAssignmentRepository['reopenResearchAssignmentRecord']>
) {
  return repository.reopenResearchAssignmentRecord(...args);
}
export function setResearchAssignmentStoppedStateRecord(
  repository: ResearchAssignmentRepository,
  ...args: Parameters<ResearchAssignmentRepository['setResearchAssignmentStoppedStateRecord']>
) {
  return repository.setResearchAssignmentStoppedStateRecord(...args);
}
export function recordResearchAssignmentOptionsRecord(
  repository: ResearchAssignmentRepository,
  ...args: Parameters<ResearchAssignmentRepository['recordResearchAssignmentOptionsRecord']>
) {
  return repository.recordResearchAssignmentOptionsRecord(...args);
}
export function acceptResearchAssignmentShortlist(
  repository: ResearchAssignmentRepository,
  ...args: Parameters<ResearchAssignmentRepository['acceptResearchAssignmentShortlist']>
) {
  return repository.acceptResearchAssignmentShortlist(...args);
}

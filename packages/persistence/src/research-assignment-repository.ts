import type {
  NewResearchAssignmentInput,
  ResearchAssignmentBriefPatch,
  ResearchAssignmentOptionsSubmission,
} from './research-assignment.js';
export interface ResearchAssignmentRepository {
  createResearchAssignmentRecord(
    input: Omit<NewResearchAssignmentInput, 'assignmentId'>,
  ): Promise<{ goalId: string; assignmentId: string }>;
  editResearchAssignmentRecord(
    goalId: string,
    patch: ResearchAssignmentBriefPatch,
    now?: Date,
  ): Promise<void>;
  reopenResearchAssignmentRecord(goalId: string, now?: Date): Promise<void>;
  setResearchAssignmentStoppedStateRecord(
    goalId: string,
    status: 'paused' | 'cancelled',
    now?: Date,
  ): Promise<void>;
  recordResearchAssignmentOptionsRecord(
    goalId: string,
    input: ResearchAssignmentOptionsSubmission,
    now?: Date,
  ): Promise<void>;
  acceptResearchAssignmentShortlist(
    goalId: string,
    resultRevision: number,
    now?: Date,
  ): Promise<void>;
}

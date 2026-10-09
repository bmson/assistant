import { describe, expect, it } from 'vitest';
import type { SuggestionStatus } from './suggestion-state';
import {
  acceptedSuggestionLabel,
  suggestionStatus,
  suggestionTaskIsActive,
} from './suggestion-state';

describe('suggestion answer reconciliation', () => {
  const wake = '2026-09-20T12:00:00Z';
  const snooze = { status: 'snoozed' as const, snoozedUntil: wake };

  it('holds a successful answer over a stale poll', () => {
    expect(suggestionStatus('pending', { status: 'accepted' })).toBe('accepted');
    expect(suggestionStatus('pending', { status: 'dismissed' })).toBe('dismissed');
    expect(suggestionStatus('pending', snooze, Date.parse(wake) - 1)).toBe('snoozed');
  });

  it('lets an elapsed snooze return when the server reopens it', () => {
    expect(suggestionStatus('pending', snooze, Date.parse(wake))).toBe('pending');
  });

  it('honors decisions from another device over a local snooze', () => {
    expect(suggestionStatus('accepted', snooze, Date.parse(wake) - 1)).toBe('accepted');
    expect(suggestionStatus('dismissed', snooze, Date.parse(wake) - 1)).toBe('dismissed');
    expect(suggestionStatus('expired', snooze)).toBe('expired');
  });

  it('keeps a newer unknown terminal status closed for an older client contract', () => {
    const superseded = 'superseded' as SuggestionStatus;
    expect(suggestionStatus(superseded, snooze, Date.parse(wake) - 1)).toBe('superseded');
    expect(suggestionStatus(superseded, undefined)).not.toBe('pending');
  });

  it('describes the actual task outcome instead of claiming completed work is running', () => {
    expect(acceptedSuggestionLabel('done')).toBe('Completed');
    expect(acceptedSuggestionLabel('failed')).toBe('Couldn’t complete');
    expect(acceptedSuggestionLabel('waiting_approval')).toBe('Needs attention');
    expect(acceptedSuggestionLabel()).toBe('Accepted');
    expect(suggestionTaskIsActive('running')).toBe(true);
    expect(suggestionTaskIsActive('waiting_approval')).toBe(true);
    expect(suggestionTaskIsActive('done')).toBe(false);
    expect(suggestionTaskIsActive('failed')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  artifactExecutionFailure,
  artifactRoutingFailure,
  artifactToolUnavailable,
  documentReadDispatchFailure,
  needsArtifactToolRetry,
  requestedArtifactIntent,
  requestedDocumentReadIntent,
} from './artifact-intent.js';

describe('requestedArtifactIntent', () => {
  it.each([
    ['try creating the doc again', 'docs.create'],
    ['Create a Google Document for the project plan', 'docs.create'],
    ['make a spreadsheet for the budget', 'sheets.create'],
    ['prepare slides for the customer briefing', 'slides.create'],
  ])('routes an explicit artifact request to %s', (text, toolName) => {
    expect(requestedArtifactIntent(text)?.toolName).toBe(toolName);
  });

  it.each([
    'can it create docs, sheets, and slides?',
    'how do I create a Google Doc?',
    "don't create a document yet",
    'create a document and a spreadsheet',
    'write this into the existing Google Doc',
    'write rows into this sheet',
    'append this section to the presentation',
    'prepare the revised copy in this slide deck',
    'write this into https://docs.google.com/document/d/1SLbcTqOwMMQG3QmD7gj755xzOKwQtVyv5cvaPjSwGSs/edit',
  ])('does not force a tool for %s', (text) => {
    expect(requestedArtifactIntent(text)).toBeUndefined();
  });

  it('recognizes a directly shared Google Doc as a real document-read request', () => {
    const intent = requestedDocumentReadIntent(
      'CV: https://docs.google.com/document/d/1SLbcTqOwMMQG3QmD7gj755xzOKwQtVyv5cvaPjSwGSs/edit?tab=t.0',
    );
    expect(intent).toEqual({
      toolName: 'docs.get',
      documentId: '1SLbcTqOwMMQG3QmD7gj755xzOKwQtVyv5cvaPjSwGSs',
    });
    if (!intent) return;
    expect(
      requestedDocumentReadIntent('https://example.com/document/d/not-a-google-doc'),
    ).toBeUndefined();
    expect(documentReadDispatchFailure(intent, 'Google API 403')).toContain('Google API 403');
  });

  it('requires the matching tool call and describes both no-attempt outcomes precisely', () => {
    const intent = requestedArtifactIntent('Try creating the doc again');
    expect(intent).toBeDefined();
    if (!intent) return;

    expect(needsArtifactToolRetry(intent, [])).toBe(true);
    expect(needsArtifactToolRetry(intent, [{ toolName: 'docs.create' }])).toBe(false);
    expect(artifactRoutingFailure(intent)).toContain('docs.create');
    expect(artifactRoutingFailure(intent)).toContain('No request was sent to Google');
    expect(artifactToolUnavailable(intent)).toContain('not available to this task');
  });

  it.each([
    'Do not open, just explain what a Google Doc URL looks like: URL',
    'Don’t read this document: URL',
    'Translate "open URL" into French',
    'Here is a hypothetical example: URL',
    '`URL`',
    'Compare URL with https://docs.google.com/document/d/OtherDocument123/edit',
  ])('does not force a read for quoted, prohibited, or ambiguous input: %s', (text) => {
    expect(
      requestedDocumentReadIntent(
        text.replaceAll('URL', 'https://docs.google.com/document/d/DocumentId123/edit'),
      ),
    ).toBeUndefined();
  });

  it('surfaces the durable Google error and never calls a failed creation complete', () => {
    const intent = requestedArtifactIntent('Create a document');
    expect(intent).toBeDefined();
    if (!intent) return;

    expect(
      artifactExecutionFailure(intent, [
        {
          toolName: 'docs.create',
          status: 'failed',
          result: null,
          error: 'Google API 403: insufficient authentication scopes',
        },
      ]),
    ).toContain('Google API 403');
    expect(
      artifactExecutionFailure(intent, [
        { toolName: 'docs.create', status: 'succeeded', result: { documentId: 'doc-1' } },
      ]),
    ).toBeUndefined();
  });
});

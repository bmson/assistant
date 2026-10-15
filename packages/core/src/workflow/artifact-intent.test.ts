import { describe, expect, it } from 'vitest';
import {
  artifactExecutionFailure,
  artifactRoutingFailure,
  artifactSharingVerificationFailure,
  artifactToolUnavailable,
  conditionalArtifactExistingResponse,
  conditionalArtifactPreflight,
  documentReadDispatchFailure,
  needsArtifactToolRetry,
  requestedArtifactIntent,
  requestedConditionalArtifactIntent,
  requestedDocumentReadIntent,
} from './artifact-intent.js';

describe('requestedArtifactIntent', () => {
  it.each([
    ['try creating the doc again', 'docs.create'],
    ['Create a Google Document for the project plan', 'docs.create'],
    ['make a spreadsheet for the budget', 'sheets.create'],
    ['prepare slides for the customer briefing', 'slides.create'],
    [
      'Create a new private Google Doc titled QA. Include a heading Project Aurora. Do not send messages or edit any existing file.',
      'docs.create',
    ],
    ['Make a spreadsheet for the budget; never update an existing sheet.', 'sheets.create'],
    [
      'Prepare a Google Doc with the plan, but do not share it or add anything to the existing document.',
      'docs.create',
    ],
  ])('routes an explicit artifact request to %s', (text, toolName) => {
    expect(requestedArtifactIntent(text)?.toolName).toBe(toolName);
  });

  it.each([
    'can it create docs, sheets, and slides?',
    'how do I create a Google Doc?',
    "don't create a document yet",
    'Create a Google Doc later, but do not create it now.',
    'Create a document and update the existing sheet.',
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

describe('conditional artifact creation safety', () => {
  const request =
    'Create a private Google Doc titled "Quarterly plan". If the exact title already exists, verify and report it instead of duplicating. Make it accessible only to me.';
  const intent = requestedConditionalArtifactIntent(request);

  it('requires a quoted title and owner-only intent is parsed separately', () => {
    expect(intent).toMatchObject({
      toolName: 'docs.create',
      exactTitle: 'Quarterly plan',
      ownerOnly: true,
    });
    expect(
      requestedConditionalArtifactIntent(
        'Create a Google Doc if the exact title already exists, do not duplicate it.',
      ),
    ).toMatchObject({ toolName: 'docs.create', ownerOnly: false });
    expect(
      requestedConditionalArtifactIntent(
        'Create a Google Doc titled "No overwrite" but never overwrite an existing file.',
      ),
    ).toMatchObject({ toolName: 'docs.create', exactTitle: 'No overwrite' });
    expect(
      requestedConditionalArtifactIntent(
        'Create a Google Doc titled "Reused". If an existing Google Doc with that exact title exists, report it instead.',
      ),
    ).toMatchObject({ toolName: 'docs.create', exactTitle: 'Reused' });
    expect(
      requestedConditionalArtifactIntent(
        'Create a Google Doc titled "Found case". If an existing Google Doc with that title is found, report it instead.',
      ),
    ).toMatchObject({ toolName: 'docs.create', exactTitle: 'Found case' });
    expect(
      requestedConditionalArtifactIntent(
        'Create a Google Doc titled "Do not duplicate this" and include the phrase "do not duplicate" in the body.',
      ),
    ).toBeUndefined();
  });

  it('binds a title from the authenticated request when owner-intent separation removed quoted data', () => {
    const requestWithTitle =
      'Create a private Google Doc titled "Conditional duplicate QA". If the exact title already exists, verify and report it instead of duplicating. Make it accessible only to me.';
    const separatedOwnerText =
      'Create a private Google Doc titled . If the exact title already exists, verify and report it instead of duplicating. Make it accessible only to me.';
    expect(requestedConditionalArtifactIntent(separatedOwnerText, requestWithTitle)).toMatchObject({
      exactTitle: 'Conditional duplicate QA',
      ownerOnly: true,
    });
    expect(requestedConditionalArtifactIntent(separatedOwnerText)).toMatchObject({
      toolName: 'docs.create',
      ownerOnly: true,
    });
    expect(requestedConditionalArtifactIntent(separatedOwnerText)?.exactTitle).toBeUndefined();
  });

  it('fails closed on no receipt, failed search, incomplete coverage, or privacy uncertainty', () => {
    if (!intent) throw new Error('expected test intent');
    expect(conditionalArtifactPreflight(intent, [])).toEqual({ status: 'not_started' });
    const base = {
      toolName: 'drive.search',
      args: {
        query: 'Quarterly plan',
        exactTitle: 'Quarterly plan',
        verifyOwnerOnly: true,
      },
      fromCurrentTask: true,
    };
    expect(
      conditionalArtifactPreflight(intent, [{ ...base, status: 'failed', result: null }]).status,
    ).toBe('blocked');
    expect(
      conditionalArtifactPreflight(intent, [
        {
          ...base,
          status: 'succeeded',
          result: {
            lookupMode: 'exact-title',
            exactTitle: 'Quarterly plan',
            coverage: 'incomplete',
            files: [],
            sharingVerification: 'unverified',
          },
        },
      ]).status,
    ).toBe('blocked');
    expect(
      conditionalArtifactPreflight(intent, [
        {
          ...base,
          status: 'succeeded',
          result: {
            lookupMode: 'exact-title',
            exactTitle: 'Quarterly plan',
            coverage: 'complete',
            files: [],
            sharingVerification: 'unverified',
          },
        },
      ]),
    ).toEqual({ status: 'absent' });
  });

  it('reports a single exact accessible match and blocks duplicates or unverifiable ACLs', () => {
    if (!intent) throw new Error('expected test intent');
    const base = {
      toolName: 'drive.search',
      status: 'succeeded',
      args: {
        query: 'Quarterly plan',
        exactTitle: 'Quarterly plan',
        verifyOwnerOnly: true,
      },
      fromCurrentTask: true,
    };
    const result = (files: unknown[], sharingVerification: string) =>
      conditionalArtifactPreflight(intent, [
        {
          ...base,
          result: {
            lookupMode: 'exact-title',
            exactTitle: 'Quarterly plan',
            coverage: 'complete',
            files,
            sharingVerification,
          },
        },
      ]);
    const file = {
      fileId: 'DocumentId12345',
      name: 'Quarterly plan',
      url: 'https://docs.google.com/document/d/DocumentId12345/edit',
    };
    const match = result([file], 'verified_owner_only');
    expect(match).toMatchObject({ status: 'exists', fileId: file.fileId, url: file.url });
    if (match.status === 'exists') {
      expect(conditionalArtifactExistingResponse(intent, match)).toContain(
        'did not create a duplicate',
      );
      expect(conditionalArtifactExistingResponse(intent, match)).toContain(
        'limited to your account and the assistant account',
      );
    }
    expect(
      result([file, { ...file, fileId: 'DocumentId12346' }], 'verified_owner_only'),
    ).toMatchObject({
      status: 'blocked',
    });
    expect(result([file], 'unverified')).toMatchObject({ status: 'blocked' });
    expect(result([{ ...file, name: 'Quarterly plan (1)' }], 'verified_owner_only')).toMatchObject({
      status: 'blocked',
    });
  });

  it('does not claim an owner-only new artifact without a successful ACL receipt', () => {
    if (!intent) throw new Error('expected test intent');
    expect(
      artifactSharingVerificationFailure(intent, [
        {
          toolName: 'docs.create',
          status: 'succeeded',
          result: {
            documentId: 'CreatedDocId12345',
            url: 'https://docs.google.com/document/d/CreatedDocId12345/edit',
            sharingVerification: 'unverified',
          },
        },
      ]),
    ).toContain('could not confirm that access is limited to you');
    expect(
      artifactSharingVerificationFailure(intent, [
        {
          toolName: 'docs.create',
          status: 'succeeded',
          result: { sharingVerification: 'verified_owner_only' },
        },
      ]),
    ).toBeUndefined();
  });
});

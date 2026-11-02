import { describe, expect, it, vi } from 'vitest';
import { decodeBasic5ObservedReply, observeBasic5Save } from './basic5-browser-save-observation.js';

const privateText = 'private-cookie-token <html>private-form-value</html>';
const saved = {
  version: 1,
  authority: 'operation_receipt',
  command: 'update_person_identity',
  operationId: '11111111-1111-4111-8111-111111111111',
  requestHash: 'a'.repeat(64),
  statusVersion: 1,
  outcome: 'saved',
  ids: { contactId: '22222222-2222-4222-8222-222222222222' },
  revision: 'b'.repeat(64),
};

async function realDecoder() {
  // This exact .js specifier is used by the live helper. Vitest resolves the
  // actual TypeScript module; the decoder and namespace are never mocked.
  const module = await import('../apps/web/lib/owner-editor-client.js');
  expect(typeof module.decodeOwnerEditorReply).toBe('function');
  return module.decodeOwnerEditorReply;
}

function nativeResponsePort(response: Response) {
  // Native JSON consumption is real. This does not model or establish the
  // availability of a Playwright browser response's channel/body transport.
  return {
    headers: () => Object.fromEntries(response.headers),
    json: vi.fn(() => response.json()),
  };
}

describe('actual decoder import and observed native response JSON boundary', () => {
  it('imports the real named decoder and consumes a valid native JSON receipt exactly once', async () => {
    const decoder = await realDecoder();
    const response = Response.json(saved);
    const port = nativeResponsePort(response);
    const decode = vi.fn(decoder);
    const diagnostics: unknown[] = [];

    await expect(
      decodeBasic5ObservedReply({
        response: port,
        decode,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toEqual(saved);

    expect(port.json).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
    expect(decode).toHaveBeenCalledExactlyOnceWith(saved);
    expect(diagnostics.at(-1)).toMatchObject({
      step: 'reply_decoded',
      contentTypeClass: 'json',
      decoderCallable: true,
      jsonReadCompleted: true,
      topLevelObject: true,
      wireKeysAllowed: true,
      receiptKeysPresent: true,
      versionTypeNumber: true,
      versionOne: true,
      wireTypesValid: true,
      decoderAccepted: true,
    });
    expect(Object.keys(diagnostics.at(-1) as object)).toHaveLength(11);
  });

  it.each([
    ['html', 'text/html', `<html>${privateText}</html>`],
    ['json', 'application/json', `{broken ${privateText}`],
  ])(
    'distinguishes failed %s JSON reading from decoder rejection',
    async (contentTypeClass, contentType, body) => {
      const response = new Response(body, {
        status: 200,
        headers: { 'content-type': contentType },
      });
      const port = nativeResponsePort(response);
      const decode = vi.fn(await realDecoder());
      const diagnostics: unknown[] = [];

      await expect(
        decodeBasic5ObservedReply({
          response: port,
          decode,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      ).rejects.toBeInstanceOf(SyntaxError);

      expect(port.json).toHaveBeenCalledOnce();
      expect(decode).not.toHaveBeenCalled();
      expect(diagnostics.at(-1)).toMatchObject({
        step: 'response_json',
        contentTypeClass,
        decoderCallable: true,
        jsonReadCompleted: false,
        topLevelObject: null,
        decoderAccepted: null,
      });
      expect(JSON.stringify(diagnostics)).not.toContain(privateText);
    },
  );

  it('reads valid JSON once and reports actual decoder rejection of version two', async () => {
    const response = Response.json({ ...saved, version: 2 });
    const port = nativeResponsePort(response);
    const decode = vi.fn(await realDecoder());
    const diagnostics: unknown[] = [];

    await expect(
      decodeBasic5ObservedReply({
        response: port,
        decode,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toBeNull();

    expect(port.json).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
    expect(diagnostics.at(-1)).toMatchObject({
      step: 'reply_decode',
      contentTypeClass: 'json',
      decoderCallable: true,
      jsonReadCompleted: true,
      topLevelObject: true,
      wireKeysAllowed: true,
      receiptKeysPresent: true,
      versionTypeNumber: true,
      versionOne: false,
      decoderAccepted: false,
    });
  });

  it('projects only fixed key-membership and type facts for malformed wire JSON', async () => {
    const response = Response.json({
      ...saved,
      version: '1',
      authority: privateText,
      command: 42,
      statusVersion: '1',
      privateExtra: privateText,
    });
    const port = nativeResponsePort(response);
    const diagnostics: unknown[] = [];

    await expect(
      decodeBasic5ObservedReply({
        response: port,
        decode: await realDecoder(),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toBeNull();

    expect(diagnostics.at(-1)).toMatchObject({
      step: 'reply_decode',
      jsonReadCompleted: true,
      topLevelObject: true,
      wireKeysAllowed: false,
      receiptKeysPresent: true,
      versionTypeNumber: false,
      versionOne: null,
      wireTypesValid: false,
      decoderAccepted: false,
    });
    const encoded = JSON.stringify(diagnostics);
    expect(encoded).not.toContain(privateText);
    expect(encoded).not.toContain('privateExtra');
    expect(encoded).not.toContain(saved.operationId);
    expect(encoded).not.toContain(saved.requestHash);
  });

  it('preserves an actual response JSON transport rejection without invoking the decoder', async () => {
    const cause = new Error(`private response transport failure ${privateText}`);
    const decode = vi.fn(await realDecoder());
    const diagnostics: unknown[] = [];
    const json = vi.fn(async () => {
      throw cause;
    });

    await expect(
      decodeBasic5ObservedReply({
        response: { headers: () => ({ 'content-type': 'application/json' }), json },
        decode,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).rejects.toBe(cause);

    expect(json).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({ step: 'response_json', jsonReadCompleted: false });
    expect(JSON.stringify(diagnostics)).not.toContain(privateText);
  });

  it('preserves a thrown decoder cause while recording that JSON reading completed', async () => {
    const response = Response.json(saved);
    const port = nativeResponsePort(response);
    const cause = new TypeError(`private decoder failure ${privateText}`);
    const decode = vi.fn(() => {
      throw cause;
    });
    const diagnostics: unknown[] = [];

    await expect(
      decodeBasic5ObservedReply({
        response: port,
        decode,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).rejects.toBe(cause);

    expect(port.json).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
    expect(diagnostics.at(-1)).toMatchObject({
      step: 'reply_decode',
      jsonReadCompleted: true,
      decoderCallable: true,
      decoderAccepted: null,
    });
    expect(JSON.stringify(diagnostics)).not.toContain(privateText);
  });

  it('fails closed with a non-callable decoder rather than manufacturing an accepted reply', async () => {
    const port = nativeResponsePort(Response.json(saved));
    const diagnostics: unknown[] = [];

    await expect(
      decodeBasic5ObservedReply({
        response: port,
        decode: {},
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).rejects.toThrow('BASIC5 observed reply decoder is unavailable');

    expect(diagnostics.at(-1)).toMatchObject({ decoderCallable: false, decoderAccepted: null });
    expect(port.json).toHaveBeenCalledOnce();
  });

  it.each([null, [], 'synthetic scalar'])(
    'records a non-object JSON top level without exposing the decoded value',
    async (value) => {
      const port = nativeResponsePort(Response.json(value));
      const diagnostics: unknown[] = [];
      await expect(
        decodeBasic5ObservedReply({
          response: port,
          decode: await realDecoder(),
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      ).resolves.toBeNull();
      expect(diagnostics.at(-1)).toMatchObject({
        step: 'reply_decode',
        jsonReadCompleted: true,
        topLevelObject: false,
        wireKeysAllowed: null,
        receiptKeysPresent: null,
        versionTypeNumber: null,
        versionOne: null,
        wireTypesValid: null,
        decoderAccepted: false,
      });
      expect(JSON.stringify(diagnostics)).not.toContain('synthetic scalar');
      expect(port.json).toHaveBeenCalledOnce();
    },
  );

  it('separates missing required keys from unexpected key names', async () => {
    const diagnostics: unknown[] = [];
    await expect(
      decodeBasic5ObservedReply({
        response: nativeResponsePort(Response.json({ version: 1 })),
        decode: await realDecoder(),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toBeNull();
    expect(diagnostics.at(-1)).toMatchObject({
      topLevelObject: true,
      wireKeysAllowed: true,
      receiptKeysPresent: false,
      decoderAccepted: false,
    });
  });

  it.each([
    ['json', { 'content-type': 'application/problem+json; charset=utf-8' }],
    ['other', { 'content-type': 'text/plain' }],
    ['missing', {}],
  ] as const)(
    'keeps content-type classification %s observational',
    async (contentTypeClass, headers) => {
      const port = nativeResponsePort(Response.json(saved));
      const diagnostics: unknown[] = [];
      await expect(
        decodeBasic5ObservedReply({
          response: { ...port, headers: () => headers },
          decode: await realDecoder(),
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      ).resolves.toEqual(saved);
      expect(diagnostics.at(-1)).toMatchObject({ contentTypeClass, decoderAccepted: true });
      expect(port.json).toHaveBeenCalledOnce();
    },
  );

  it('preserves actual decoding when header inspection or the diagnostic sink throws', async () => {
    const port = nativeResponsePort(Response.json(saved));
    const decode = vi.fn(await realDecoder());
    await expect(
      decodeBasic5ObservedReply({
        response: {
          ...port,
          headers: () => {
            throw new Error(`private header failure ${privateText}`);
          },
        },
        decode,
        onDiagnostic: () => {
          throw new Error(`private sink failure ${privateText}`);
        },
      }),
    ).resolves.toEqual(saved);
    expect(port.json).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
  });

  it.each(['throw', 'nonrecord'] as const)(
    'keeps unavailable header inspection unknown (%s), separate from observed absence',
    async (kind) => {
      const port = nativeResponsePort(Response.json(saved));
      const diagnostics: unknown[] = [];
      await expect(
        decodeBasic5ObservedReply({
          response: {
            ...port,
            headers: () => {
              if (kind === 'throw') throw new Error(`private header failure ${privateText}`);
              return null as unknown as Record<string, string>;
            },
          },
          decode: await realDecoder(),
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      ).resolves.toEqual(saved);
      expect(diagnostics.at(-1)).toMatchObject({
        contentTypeClass: 'unknown',
        decoderAccepted: true,
      });
      expect(port.json).toHaveBeenCalledOnce();
      expect(JSON.stringify(diagnostics)).not.toContain(privateText);
    },
  );

  it('reports wrong top-level ids types without retaining nested values', async () => {
    const diagnostics: unknown[] = [];
    const port = nativeResponsePort(Response.json({ ...saved, ids: privateText }));
    await expect(
      decodeBasic5ObservedReply({
        response: port,
        decode: await realDecoder(),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toBeNull();
    expect(diagnostics.at(-1)).toMatchObject({
      wireKeysAllowed: true,
      receiptKeysPresent: true,
      wireTypesValid: false,
      decoderAccepted: false,
    });
    expect(JSON.stringify(diagnostics)).not.toContain(privateText);
    expect(port.json).toHaveBeenCalledOnce();
  });

  it('keeps the response waiter alive through real native JSON reading and actual decoding', async () => {
    const response = Response.json(saved);
    let waiterSignal: AbortSignal | undefined;
    const port = {
      headers: () => Object.fromEntries(response.headers),
      json: vi.fn(() => {
        expect(waiterSignal?.aborted).toBe(false);
        return response.json();
      }),
    };
    const actualDecode = await realDecoder();
    const decode = vi.fn((value: unknown) => {
      expect(waiterSignal?.aborted).toBe(false);
      return actualDecode(value);
    });
    let deliver: ((value: typeof port) => void) | undefined;
    const closeListeners = new Set<() => void>();
    const page = {
      waitForResponse: (
        predicate: (candidate: typeof port) => boolean,
        options: { timeout: number; signal: AbortSignal },
      ) => {
        waiterSignal = options.signal;
        return new Promise<typeof port>((resolve) => {
          deliver = (candidate) => {
            if (predicate(candidate)) resolve(candidate);
          };
        });
      },
      on: (_event: 'close', listener: () => void) => closeListeners.add(listener),
      off: (_event: 'close', listener: () => void) => closeListeners.delete(listener),
      isClosed: () => false,
    };
    let notifyRequest: ((matched: boolean | null) => void) | undefined;
    let posts = 0;
    const dispose = vi.fn();
    const parsedResponses: (typeof port)[] = [];
    const replyDiagnostics: unknown[] = [];
    const saveDiagnostics: unknown[] = [];

    await expect(
      observeBasic5Save({
        operation: 'update_person_identity',
        page,
        click: async () => {
          expect(waiterSignal?.aborted).toBe(false);
          posts += 1;
          notifyRequest?.(true);
          deliver?.(port);
        },
        parse: async (observedResponse) => {
          parsedResponses.push(observedResponse);
          return decodeBasic5ObservedReply({
            response: observedResponse,
            decode,
            onDiagnostic: (diagnostic) => replyDiagnostics.push(diagnostic),
          });
        },
        matchResponse: (candidate) => candidate === port,
        status: () => response.status,
        activateRequestObserver: (notify) => {
          notifyRequest = notify;
          return dispose;
        },
        totalMatchingPostCount: () => posts,
        readUi: async () => ({
          nativeValid: true,
          invalidControlPresent: false,
          alertPresent: false,
          saveEnabled: true,
        }),
        isTimeoutError: () => false,
        onDiagnostic: (diagnostic) => saveDiagnostics.push(diagnostic),
      }),
    ).resolves.toEqual(saved);

    expect(parsedResponses).toEqual([port]);
    expect(parsedResponses[0]).toBe(port);
    expect(port.json).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledExactlyOnceWith(saved);
    expect(response.bodyUsed).toBe(true);
    expect(waiterSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(closeListeners.size).toBe(0);
    expect(replyDiagnostics.at(-1)).toMatchObject({
      step: 'reply_decoded',
      jsonReadCompleted: true,
      decoderAccepted: true,
    });
    expect(saveDiagnostics.at(-1)).toMatchObject({
      phase: 'parse',
      totalMatchingPostCount: 1,
      commandMatched: true,
      httpStatus: 200,
      errorStage: null,
    });
  });

  it('reports strict decoding without implying the receipt operation matches the expected save', async () => {
    const differentOperation = {
      ...saved,
      operationId: '33333333-3333-4333-8333-333333333333',
    };
    const port = nativeResponsePort(Response.json(differentOperation));
    const decode = vi.fn(await realDecoder());
    const diagnostics: unknown[] = [];

    // The actual decoder validates receipt structure. The fixture's independent
    // operation-ID and request-hash equality checks still run after this boundary.
    await expect(
      decodeBasic5ObservedReply({
        response: port,
        decode,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toEqual(differentOperation);

    expect(differentOperation.operationId).not.toBe(saved.operationId);
    expect(port.json).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledExactlyOnceWith(differentOperation);
    expect(diagnostics.at(-1)).toMatchObject({
      step: 'reply_decoded',
      decoderAccepted: true,
    });
    expect(Object.keys(diagnostics.at(-1) as object)).toHaveLength(11);
    expect(diagnostics.at(-1)).not.toHaveProperty('identityVerified');
    expect(diagnostics.at(-1)).not.toHaveProperty('operationId');
    expect(diagnostics.at(-1)).not.toHaveProperty('requestHash');
  });
});

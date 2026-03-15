import { describe, it, expect, vi, afterEach } from 'vitest';
import { createNatsNodeMessage, type INatsMsgLike, type NatsNodeMessageOptions, type NodeMessageFunctions } from '../NATS';
import type { MsgHdrs } from '@nats-io/nats-core';

// ─── Mock helpers ────────────────────────────────────────────────

function createMockMsg(overrides: Partial<INatsMsgLike> = {}): INatsMsgLike {
	const data = overrides.data ?? new TextEncoder().encode('hello');
	return {
		subject: 'test.subject',
		data,
		json: vi.fn(() => JSON.parse(new TextDecoder().decode(data))),
		string: vi.fn(() => new TextDecoder().decode(data)),
		...overrides,
	};
}

function createMockFunc(): NodeMessageFunctions {
	return {
		getNode: vi.fn(() => ({
			name: 'TestNode',
			type: 'n8n-nodes-base.testNode',
			typeVersion: 1,
			position: [0, 0] as [number, number],
			parameters: {},
			continueOnFail: false,
		})),
		helpers: {
			prepareBinaryData: vi.fn(async (buf: Buffer) => ({
				mimeType: 'application/octet-stream',
				data: buf.toString('base64'),
			})),
			returnJsonArray: vi.fn((data: any) => [data]),
		},
	} as unknown as NodeMessageFunctions;
}

function createMockHeaders(entries: [string, string[]][], opts?: { hasError?: boolean; code?: number; status?: string; description?: string }): MsgHdrs {
	const map = new Map(entries);
	return {
		[Symbol.iterator]: function* () {
			for (const [key, values] of map) {
				yield [key, values] as [string, string[]];
			}
		},
		get: (key: string) => map.get(key)?.[0] ?? '',
		has: (key: string) => map.has(key),
		values: (key: string) => map.get(key) ?? [],
		hasError: opts?.hasError ?? false,
		code: opts?.code ?? 0,
		status: opts?.status ?? '',
		description: opts?.description ?? '',
	} as unknown as MsgHdrs;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('createNatsNodeMessage', () => {

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('should auto-detect JSON and parse body', async () => {
		const data = new TextEncoder().encode('{"key":"value"}');
		const msg = createMockMsg({ data, json: vi.fn(() => ({ key: 'value' })) });
		const func = createMockFunc();

		const result = await createNatsNodeMessage(func, msg);

		expect(result.json.data).toEqual({ key: 'value' });
		expect(result.json.subject).toBe('test.subject');
	});

	it('should treat non-JSON data as string', async () => {
		const data = new TextEncoder().encode('plain text');
		const msg = createMockMsg({ data, string: vi.fn(() => 'plain text') });
		const func = createMockFunc();

		const result = await createNatsNodeMessage(func, msg);

		expect(result.json.data).toBe('plain text');
	});

	it('should handle binary content with prepareBinaryData', async () => {
		const data = new Uint8Array([0x01, 0x02, 0x03]);
		const msg = createMockMsg({ data });
		const func = createMockFunc();

		const result = await createNatsNodeMessage(func, msg, 0, { contentIsBinary: true });

		expect(func.helpers.prepareBinaryData).toHaveBeenCalledWith(Buffer.from(data));
		expect(result.binary).toBeDefined();
		expect(result.binary!.data).toBeDefined();
	});

	it('should extract single-value headers', async () => {
		const hdrs = createMockHeaders([['X-Custom', ['val1']]]);
		const msg = createMockMsg({ data: new TextEncoder().encode('test'), headers: hdrs });
		const func = createMockFunc();

		const result = await createNatsNodeMessage(func, msg);

		expect(result.json.headers).toEqual({ 'X-Custom': 'val1' });
	});

	it('should extract multi-value headers as array', async () => {
		const hdrs = createMockHeaders([['X-Multi', ['a', 'b', 'c']]]);
		const msg = createMockMsg({ data: new TextEncoder().encode('test'), headers: hdrs });
		const func = createMockFunc();

		const result = await createNatsNodeMessage(func, msg);

		expect(result.json.headers).toEqual({ 'X-Multi': ['a', 'b', 'c'] });
	});

	it('should return empty headers object when no headers present', async () => {
		const msg = createMockMsg({ data: new TextEncoder().encode('test'), headers: undefined });
		const func = createMockFunc();

		const result = await createNatsNodeMessage(func, msg);

		expect(result.json.headers).toEqual({});
	});

	it('should throw NodeOperationError on error headers when continueOnFail is false', async () => {
		const hdrs = createMockHeaders([], { hasError: true, code: 503, status: 'No Responders', description: 'no responders' });
		const msg = createMockMsg({ data: new TextEncoder().encode(''), headers: hdrs });
		const func = createMockFunc();

		await expect(createNatsNodeMessage(func, msg)).rejects.toThrow();
	});

	it('should attach error to item on error headers when continueOnFail is true', async () => {
		const hdrs = createMockHeaders([], { hasError: true, code: 503, status: 'No Responders', description: 'no responders' });
		const msg = createMockMsg({ data: new TextEncoder().encode(''), headers: hdrs });
		const func = createMockFunc();
		vi.mocked(func.getNode).mockReturnValue({
			name: 'TestNode',
			type: 'n8n-nodes-base.testNode',
			typeVersion: 1,
			position: [0, 0] as [number, number],
			parameters: {},
			continueOnFail: true,
		} as any);

		const result = await createNatsNodeMessage(func, msg);

		expect(result.error).toBeDefined();
	});

	it('should flatten json with onlyContent flag', async () => {
		const data = new TextEncoder().encode('{"key":"value"}');
		const msg = createMockMsg({ data, json: vi.fn(() => ({ key: 'value' })) });
		const func = createMockFunc();

		const result = await createNatsNodeMessage(func, msg, 0, { onlyContent: true });

		// onlyContent: json IS the data directly, no wrapping
		expect(result.json.key).toBe('value');
		expect(result.json).not.toHaveProperty('subject');
		expect(result.json).not.toHaveProperty('headers');
	});

	it('should include reply subject when present', async () => {
		const msg = createMockMsg({
			data: new TextEncoder().encode('test'),
			reply: '_INBOX.abc123',
		});
		const func = createMockFunc();

		const result = await createNatsNodeMessage(func, msg);

		expect(result.json.reply).toBe('_INBOX.abc123');
	});

	it('should handle empty data (0 bytes)', async () => {
		const msg = createMockMsg({
			data: new Uint8Array(0),
			string: vi.fn(() => ''),
		});
		const func = createMockFunc();

		const result = await createNatsNodeMessage(func, msg);

		// Empty data, < 2 bytes so no JSON auto-detect, falls to string path
		expect(result.json.data).toBe('');
	});

	it('should set pairedItem from idx parameter', async () => {
		const msg = createMockMsg({ data: new TextEncoder().encode('test') });
		const func = createMockFunc();

		const result = await createNatsNodeMessage(func, msg, 5);

		expect(result.pairedItem).toBe(5);
	});
});

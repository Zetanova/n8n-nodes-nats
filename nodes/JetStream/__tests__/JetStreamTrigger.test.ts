import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ITriggerFunctions } from 'n8n-workflow';

// ─── Module mocks (hoisted by vitest) ───────────────────────────

vi.mock('typedi', () => {
	const container = { get: vi.fn() };
	return { default: container, Service: () => (target: any) => target };
});

vi.mock('../../Nats.service', () => ({
	NatsService: class {},
}));

vi.mock('../../Nats/actions/message', () => ({
	createNatsNodeMessage: vi.fn(),
}));

import Container from 'typedi';
import { JetStreamTrigger } from '../JetStreamTrigger.node';

// ─── Mock helpers ───────────────────────────────────────────────

/**
 * Creates a mock ConsumerMessages with a controllable async iterator.
 * - hangForever: next() blocks until close() is called
 * - completeImmediately: next() returns done:true right away (empty iterator)
 */
function createMockMessages({ hangForever = false, completeImmediately = false } = {}) {
	let pendingResolve: ((result: IteratorResult<any>) => void) | null = null;
	let iteratorDone = completeImmediately;
	let statusGenerator: () => AsyncIterable<any> = () => (async function* () {})();

	const messages = {
		[Symbol.asyncIterator]() {
			return {
				next(): Promise<IteratorResult<any>> {
					if (iteratorDone) return Promise.resolve({ value: undefined, done: true as const });
					return new Promise<IteratorResult<any>>((resolve) => {
						pendingResolve = resolve;
					});
				},
				return(): Promise<IteratorResult<any>> {
					iteratorDone = true;
					pendingResolve?.({ value: undefined, done: true });
					pendingResolve = null;
					return Promise.resolve({ value: undefined, done: true as const });
				},
			};
		},
		close: vi.fn(async () => {
			iteratorDone = true;
			pendingResolve?.({ value: undefined, done: true });
			pendingResolve = null;
		}),
		status: vi.fn(() => statusGenerator()),
		closed: vi.fn(() => new Promise<void | Error>(() => {})),
	};

	return {
		messages,
		/** Override what status() yields on iteration */
		setStatusEvents(gen: () => AsyncIterable<any>) {
			statusGenerator = gen;
		},
	};
}

/**
 * Creates a mock NatsConnection with a controllable closed() promise.
 */
function createMockConnection() {
	let closedResolve: ((value: void | Error) => void) | undefined;
	const closedPromise = new Promise<void | Error>((r) => {
		closedResolve = r;
	});

	return {
		connection: {
			closed: vi.fn(() => closedPromise),
			isClosed: vi.fn(() => false),
			close: vi.fn(),
			drain: vi.fn(),
			isDraining: vi.fn(() => false),
		},
		/** Simulate connection death — resolves the closed() promise */
		resolveClose(value?: void | Error) {
			closedResolve?.(value ?? undefined);
		},
	};
}

/**
 * Creates a mock ITriggerFunctions context matching what JetStreamTrigger.trigger() uses.
 */
function createMockTriggerFunctions(): ITriggerFunctions {
	return {
		getNodeParameter: vi.fn((name: string, fallback?: any) => {
			switch (name) {
				case 'stream': return 'test-stream';
				case 'consumer': return 'test-consumer';
				case 'options': return {};
				default: return fallback;
			}
		}),
		getNode: vi.fn(() => ({
			name: 'JetStreamTrigger',
			type: 'n8n-nodes-base.jetStreamTrigger',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		})),
		getMode: vi.fn(() => 'trigger'),
		getCredentials: vi.fn(async () => ({})),
		helpers: {
			createDeferredPromise: vi.fn(),
			returnJsonArray: vi.fn((data: any) => [data]),
			prepareBinaryData: vi.fn(),
		},
		emit: vi.fn(),
		emitError: vi.fn(),
	} as unknown as ITriggerFunctions;
}

/** Wait for async microtasks/promise chains to settle */
function settle(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ──────────────────────────────────────────────────────

describe('JetStreamTrigger consume loop', () => {
	let trigger: JetStreamTrigger;
	let mockCtx: ITriggerFunctions;
	let mockDispose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		trigger = new JetStreamTrigger();
		mockCtx = createMockTriggerFunctions();
		mockDispose = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Wire up Container.get → mock NatsService → mock JetStream consumer → mock messages */
	function setupMocks(
		mock: ReturnType<typeof createMockMessages>,
		conn: ReturnType<typeof createMockConnection>,
	) {
		const mockNatsService = {
			getJetStream: vi.fn(async () => ({
				connection: conn.connection,
				js: {
					consumers: {
						get: vi.fn(async () => ({
							consume: vi.fn(async () => mock.messages),
						})),
					},
				},
				[Symbol.dispose]: mockDispose,
			})),
		};
		vi.mocked(Container.get).mockReturnValue(mockNatsService);
	}

	/**
	 * BUG: When the NATS connection dies, the `for await (const msg of messages)` loop
	 * hangs forever — it never exits and emitError is never called.
	 *
	 * FIX (Phase 3): Monitor connection.closed() alongside the consume loop.
	 * When the connection closes, force-close the consumer and emit an error.
	 *
	 * This test MUST FAIL before the fix is applied.
	 */
	it('should emit error when connection closes unexpectedly', async () => {
		// Iterator hangs forever — simulates normal "waiting for messages" state
		const mock = createMockMessages({ hangForever: true });
		const conn = createMockConnection();
		setupMocks(mock, conn);

		await trigger.trigger.call(mockCtx);

		// Simulate NATS server dying — connection.closed() resolves
		conn.resolveClose();
		await settle(200);

		// EXPECTED (after fix): monitoring connection.closed() detects death → emitError
		// CURRENT: connection.closed() is not monitored → loop hangs → emitError never called
		expect(mockCtx.emitError).toHaveBeenCalled();
	});

	/**
	 * BUG: The consumer's status() async iterable emits notifications like HeartbeatsMissed,
	 * but the current code never iterates it — missed heartbeats go undetected.
	 *
	 * FIX (Phase 3): Monitor messages.status() for critical events. On HeartbeatsMissed,
	 * close the consumer and emit an error so n8n can reactivate the workflow.
	 *
	 * This test MUST FAIL before the fix is applied.
	 */
	it('should emit error on heartbeats missed', async () => {
		const mock = createMockMessages({ hangForever: true });
		const conn = createMockConnection();

		// status() will yield a HeartbeatsMissed event when iterated
		mock.setStatusEvents(() =>
			(async function* () {
				yield { type: 'heartbeats_missed' as const, count: 3 };
			})(),
		);

		setupMocks(mock, conn);

		await trigger.trigger.call(mockCtx);
		await settle(200);

		// EXPECTED (after fix): monitoring messages.status() detects heartbeats missed
		//   → closes consumer → emitError
		// CURRENT: status() is not monitored → no reaction to heartbeats missed
		expect(mockCtx.emitError).toHaveBeenCalled();
		expect(mock.messages.close).toHaveBeenCalled();
	});

	/**
	 * EXISTING BEHAVIOR (should pass): When closeFunction is called (graceful shutdown),
	 * closing=true is set before messages.close(). The .then() handler checks closing
	 * and skips emitError.
	 */
	it('should not emit error on graceful close', async () => {
		const mock = createMockMessages({ hangForever: true });
		const conn = createMockConnection();
		setupMocks(mock, conn);

		const result = await trigger.trigger.call(mockCtx);

		// Graceful shutdown: closeFunction sets closing=true then closes messages
		await result.closeFunction!();
		await settle(100);

		// closing=true prevents emitError in the .then() handler
		expect(mockCtx.emitError).not.toHaveBeenCalled();
	});

	/**
	 * EXISTING BEHAVIOR (should pass): When the consume loop exits without error
	 * (empty iterator / consumer closed server-side), the .then() success handler
	 * calls emitError with 'JetStream consumer closed unexpectedly'.
	 */
	it('should emit error when consume loop exits unexpectedly', async () => {
		// Empty iterator — simulates consumer closing without error
		const mock = createMockMessages({ completeImmediately: true });
		const conn = createMockConnection();
		setupMocks(mock, conn);

		await trigger.trigger.call(mockCtx);
		await settle(100);

		// consume() resolves → .then() success handler → closing is false → emitError
		expect(mockCtx.emitError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'JetStream consumer closed unexpectedly',
			}),
		);
	});
});

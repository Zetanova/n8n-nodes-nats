import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Module mocks (hoisted by vitest) ────────────────────────────

vi.mock('typedi', () => {
	const container = { get: vi.fn() };
	return { default: container, Service: () => (target: any) => target };
});

vi.mock('@nats-io/transport-node', () => ({
	connect: vi.fn(),
}));

vi.mock('@nats-io/nats-core', () => ({}));

vi.mock('@nats-io/jetstream', () => ({
	jetstream: vi.fn(),
}));

vi.mock('../common', () => ({
	natsConnectionOptions: vi.fn((creds: any) => ({ servers: creds.servers ?? 'nats://localhost:4222' })),
}));

import { connect } from '@nats-io/transport-node';
import { NatsService } from '../Nats.service';
import type { IAllExecuteFunctions } from 'n8n-workflow';

// ─── Mock helpers ────────────────────────────────────────────────

function createMockNatsConnection() {
	let closedResolve: ((value: void | Error) => void) | undefined;
	const closedPromise = new Promise<void | Error>((r) => {
		closedResolve = r;
	});

	const connection = {
		isClosed: vi.fn(() => false),
		isDraining: vi.fn(() => false),
		close: vi.fn(),
		drain: vi.fn(),
		closed: vi.fn(() => closedPromise),
		info: { client_id: 1 },
	};

	return {
		connection,
		resolveClose(value?: void | Error) {
			closedResolve?.(value ?? undefined);
		},
	};
}

function createMockFunc(credentialId: string, credValues: Record<string, unknown> = {}): IAllExecuteFunctions {
	return {
		getCredentials: vi.fn(async () => ({ servers: 'nats://localhost:4222', ...credValues })),
		getNode: vi.fn(() => ({
			name: 'TestNode',
			credentials: { natsApi: { id: credentialId } },
		})),
		getExecutionId: vi.fn(() => 'exec-123'),
		helpers: {},
	} as unknown as IAllExecuteFunctions;
}

/** Wait for async microtasks/promise chains to settle */
function settle(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ───────────────────────────────────────────────────────

describe('NatsService connection pool', () => {
	let service: NatsService;

	beforeEach(() => {
		// Reset the static connections map between tests
		// Access via the debug method to verify state
		service = new NatsService();
		// Clear any leftover connections from previous tests
		(NatsService as any).connections = new Map();
		(NatsService as any).counter = 0;
		vi.mocked(connect).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('should create a new connection on first getConnection call', async () => {
		const mock = createMockNatsConnection();
		vi.mocked(connect).mockResolvedValue(mock.connection as any);

		const func = createMockFunc('cred-1');
		const handle = await service.getConnection(func);

		expect(connect).toHaveBeenCalledTimes(1);
		expect(handle.connection).toBe(mock.connection);

		const status = service.getConnectionStatus('cred-1');
		expect(status.exists).toBe(true);
		expect(status.refCount).toBe(1);

		handle[Symbol.dispose]();
	});

	it('should reuse connection for same credentials (refCount=2)', async () => {
		const mock = createMockNatsConnection();
		vi.mocked(connect).mockResolvedValue(mock.connection as any);

		const func = createMockFunc('cred-1');
		const handle1 = await service.getConnection(func);
		const handle2 = await service.getConnection(func);

		expect(connect).toHaveBeenCalledTimes(1);
		expect(handle1.connection).toBe(handle2.connection);

		const status = service.getConnectionStatus('cred-1');
		expect(status.refCount).toBe(2);

		handle1[Symbol.dispose]();
		handle2[Symbol.dispose]();
	});

	it('should decrement refCount on dispose and schedule idle drain', async () => {
		vi.useFakeTimers();
		const mock = createMockNatsConnection();
		vi.mocked(connect).mockResolvedValue(mock.connection as any);

		const func = createMockFunc('cred-1');
		const handle = await service.getConnection(func);

		expect(service.getConnectionStatus('cred-1').refCount).toBe(1);

		handle[Symbol.dispose]();

		const status = service.getConnectionStatus('cred-1');
		expect(status.refCount).toBe(0);
		expect(status.hasTimer).toBe(true);

		vi.useRealTimers();
	});

	it('should drain connection when idle timer fires (180s)', async () => {
		vi.useFakeTimers();
		const mock = createMockNatsConnection();
		vi.mocked(connect).mockResolvedValue(mock.connection as any);

		const func = createMockFunc('cred-1');
		const handle = await service.getConnection(func);
		handle[Symbol.dispose]();

		// Advance past idle timeout
		vi.advanceTimersByTime(180_000);

		expect(mock.connection.drain).toHaveBeenCalled();
		expect(service.getConnectionStatus('cred-1').exists).toBe(false);

		vi.useRealTimers();
	});

	it('should cancel idle timer when re-acquired before it fires', async () => {
		vi.useFakeTimers();
		const mock = createMockNatsConnection();
		vi.mocked(connect).mockResolvedValue(mock.connection as any);

		const func = createMockFunc('cred-1');
		const handle1 = await service.getConnection(func);
		handle1[Symbol.dispose]();

		// Timer is scheduled
		expect(service.getConnectionStatus('cred-1').hasTimer).toBe(true);

		// Re-acquire before timer fires
		const handle2 = await service.getConnection(func);

		expect(service.getConnectionStatus('cred-1').hasTimer).toBe(false);
		expect(connect).toHaveBeenCalledTimes(1); // still reused, not a new connection

		// Advance past timeout — should NOT drain since timer was cancelled
		vi.advanceTimersByTime(180_000);
		expect(mock.connection.drain).not.toHaveBeenCalled();

		handle2[Symbol.dispose]();
		vi.useRealTimers();
	});

	it('should create new connection when credential hash changes', async () => {
		const mock1 = createMockNatsConnection();
		const mock2 = createMockNatsConnection();
		vi.mocked(connect)
			.mockResolvedValueOnce(mock1.connection as any)
			.mockResolvedValueOnce(mock2.connection as any);

		const func1 = createMockFunc('cred-1', { servers: 'nats://host1:4222' });
		const handle1 = await service.getConnection(func1);

		// Same credential ID but different values → hash changes
		const func2 = createMockFunc('cred-1', { servers: 'nats://host2:4222' });
		const handle2 = await service.getConnection(func2);

		expect(connect).toHaveBeenCalledTimes(2);
		expect(mock1.connection.close).toHaveBeenCalled();
		expect(handle2.connection).toBe(mock2.connection);

		handle1[Symbol.dispose]();
		handle2[Symbol.dispose]();
	});

	it('should remove from pool when connection.closed() resolves', async () => {
		const mock = createMockNatsConnection();
		vi.mocked(connect).mockResolvedValue(mock.connection as any);

		const func = createMockFunc('cred-1');
		const handle = await service.getConnection(func);

		expect(service.getConnectionStatus('cred-1').exists).toBe(true);

		// Simulate connection death
		mock.resolveClose();
		await settle(50);

		expect(service.getConnectionStatus('cred-1').exists).toBe(false);

		handle[Symbol.dispose]();
	});

	it('should create new connection when existing one is closed', async () => {
		const mock1 = createMockNatsConnection();
		const mock2 = createMockNatsConnection();
		vi.mocked(connect)
			.mockResolvedValueOnce(mock1.connection as any)
			.mockResolvedValueOnce(mock2.connection as any);

		const func = createMockFunc('cred-1');
		const handle1 = await service.getConnection(func);
		handle1[Symbol.dispose]();

		// Mark connection as closed
		mock1.connection.isClosed.mockReturnValue(true);

		const handle2 = await service.getConnection(func);

		expect(connect).toHaveBeenCalledTimes(2);
		expect(handle2.connection).toBe(mock2.connection);

		handle2[Symbol.dispose]();
	});
});

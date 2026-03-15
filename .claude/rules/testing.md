---
last-refined: 2026-03-15
---

# Testing

## Commands

| Command | Description |
|---------|-------------|
| `pnpm test` | Run all tests once (vitest run) |
| `pnpm test:watch` | Watch mode (vitest) |

## Structure

- **Framework:** vitest 4.x, config in `vitest.config.ts`
- **Pattern:** `nodes/**/*.test.ts` (colocated in `__tests__/` dirs)
- **Environment:** Node

## Mock Patterns

### Module Mocks (hoisted by vitest)

```typescript
// typedi Container — control DI resolution
vi.mock('typedi', () => {
  const container = { get: vi.fn() };
  return { default: container, Service: () => (target: any) => target };
});

// NatsService — stub class
vi.mock('../../Nats.service', () => ({
  NatsService: class {},
}));

// Message utilities (split from NATS.ts → message.ts)
vi.mock('../../Nats/actions/message', () => ({
  createNatsNodeMessage: vi.fn(),
}));
// Note: NATS.ts re-exports from message.ts — both import paths work
```

### Key Mock Helpers

| Helper | Purpose |
|--------|---------|
| `createMockMessages()` | ConsumerMessages with controllable async iterator + `status()` + `close()` |
| `createMockConnection()` | NatsConnection with controllable `closed()` promise |
| `createMockTriggerFunctions()` | n8n `ITriggerFunctions` (emit, emitError, getNodeParameter, helpers) |
| `settle(ms)` | Wait for async microtask/promise chains |

### Wiring Mocks Together

```typescript
// Container.get(NatsService) → getJetStream() → { connection, js, dispose }
const mockNatsService = {
  getJetStream: vi.fn(async () => ({
    connection: conn.connection,
    js: { consumers: { get: vi.fn(async () => ({ consume: vi.fn(async () => mock.messages) })) } },
    [Symbol.dispose]: mockDispose,
  })),
};
vi.mocked(Container.get).mockReturnValue(mockNatsService);
```

## Conventions

- **Bug fix:** write failing test first → fix → test passes. No exceptions.
- **Mock granularity:** mock at module boundaries (typedi, NatsService, n8n interfaces).
- **Async patterns:** use `settle()` helper after triggering async operations.
- **Cleanup:** `vi.restoreAllMocks()` in `afterEach`.
- **No real NATS:** all tests mock the connection — no server dependency.

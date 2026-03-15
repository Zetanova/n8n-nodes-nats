---
last-refined: 2026-03-15
---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

n8n community node package (`@zetanova/n8n-nodes-nats`) providing NATS and JetStream nodes for n8n workflow automation. Published to npm and GitHub Packages.

## Commands

- **Build:** `pnpm build` (tsc + gulp icon copy → `dist/`)
- **Dev:** `pnpm dev` (tsc --watch)
- **Lint:** `pnpm lint` (eslint with `eslint-plugin-n8n-nodes-base`)
- **Lint fix:** `pnpm lintfix`
- **Format:** `pnpm format` (prettier on nodes/ and credentials/)
- **Install:** `pnpm install` (requires pnpm >=9.1, node >=18.10)

- **Test:** `pnpm test` (vitest run)
- **Test watch:** `pnpm test:watch` (vitest)
- Test files: `nodes/**/*.test.ts`

## Architecture

### Nodes

Three n8n nodes, all sharing the `natsApi` credential:

- **Nats** (`nodes/Nats/Nats.node.ts`) — Publish to subject or send request (single/many replies). Operations dispatched via `nodes/Nats/actions/NATS.ts`.
- **JetStream** (`nodes/JetStream/JetStream.node.ts`) — Publish to JetStream or acknowledge a message. Operations dispatched via `nodes/JetStream/actions/JetStream.ts`.
- **JetStreamTrigger** (`nodes/JetStream/JetStreamTrigger.node.ts`) — Trigger node that consumes from a JetStream consumer with configurable acknowledge modes (immediately, on execution finish, later via JetStream node).

### Connection Pool

`nodes/Nats.service.ts` — Singleton `NatsService` (via typedi `@Service({ global: true })`) manages a worker-level connection pool keyed by credential ID. Connections are ref-counted, idle-drained after 180s, and invalidated on credential hash change. Uses `FinalizationRegistry` for leak safety and `Symbol.dispose` (`using` keyword) for RAII-style cleanup via `NatsConnectionHandle`.

### Shared Utilities

- `nodes/common.ts` — `natsConnectionOptions()` builds `ConnectionOptions` from credential data (handles 7 auth types: none, user/pass, token, nkey, jwt, creds, tls). `natsCredTest()` validates credentials by connecting + RTT.
- `nodes/Nats/actions/message.ts` — Message types (`NatsNodeHeaders`, `NatsNodeData`, `NatsNodeMessage`, etc.) + `createNatsNodeMessage()` converter (handles JSON auto-detect, binary, headers, error propagation). Shared by both Nats request and JetStreamTrigger.
- `nodes/Nats/actions/NATS.ts` — `publish()` and `request()` operations; re-exports message utilities from `message.ts` for backward compatibility.
- `nodes/JetStream/actions/consumer.ts` — `consumeMessages()` function orchestrating the JetStream consumer loop with acknowledge mode handling. Extracted from JetStreamTrigger for testability.
- `nodes/Nats/common.ts` — Legacy direct connection helper (not used by pooled path).

### Node Structure Convention

Each node follows: `descriptions/` (UI property definitions) + `actions/` (operation implementations + message utilities) + `*.node.ts` (entry point with `execute`/`trigger`).

## Key Dependencies

- `@nats-io/transport-node`, `@nats-io/nats-core`, `@nats-io/jetstream` (v3.x)
- `typedi` — DI container for singleton NatsService
- `n8n-workflow` — peer dependency, provides node interfaces

## Release

GitHub Actions (`.github/workflows/release.yml`) triggers on `v*.*.*` tags (excludes pre-release). Publishes to both npm and GitHub Packages.

## References

- [Best practices](.claude/rules/best-practices.md) — n8n community node conventions, linting, publishing
- [Testing conventions](.claude/rules/testing.md) — vitest setup, mock patterns, test structure
- [n8n testing guide](~/.claude/docs/n8n-testing.md) — unit/e2e testing patterns for n8n community nodes

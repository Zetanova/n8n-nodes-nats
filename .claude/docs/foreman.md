# Foreman Logbook

Domain-specific notes from team tasks.

## 2026-03-15 — Fix silent consume loop exit in JetStreamTrigger
- **correction:** NATS `for await` on `consumer.consume()` can hang silently on connection death — the async iterator may never exit. Must monitor `connection.closed()` and `messages.status()` in parallel.
- **practice:** Any NATS consume/subscribe loop needs parallel health monitors — `connection.closed()` for connection death, `messages.status()` for consumer-level failures (HeartbeatsMissed, ConsumerNotFound, etc.).
- **practice:** All async monitoring code (.then/.catch, async IIFE) must have error handlers — unhandled rejections in monitors silently defeat the monitoring purpose.
- **gotcha:** `expire` option in NATS consume is server-side validated — does NOT trigger on client when connection disconnects. Client-side monitoring is mandatory.

### docs-gaps
| File | Issue | Action |
|------|-------|--------|
| `.claude/rules/testing.md` | ~~missing~~ created | ~~Create with vitest conventions~~ DONE |

## 2026-03-15 — Research n8n node testing, refactor structure, close test gaps
- **practice:** Vitest is appropriate for n8n community nodes — n8n doesn't mandate a framework. No public test utils from n8n.
- **practice:** Split convention: message types/converters → `actions/message.ts`, consume logic → `actions/consumer.ts`. Keep `.node.ts` as thin orchestration.
- **practice:** Re-export from original module (NATS.ts) for backward compatibility after splits — avoids breaking external consumers.
- **gotcha:** Vitest 4 (Rolldown/oxc) requires `experimentalDecorators: true` in tsconfig to parse typedi `@Service` decorators.

### docs-gaps
| File | Issue | Action |
|------|-------|--------|
| `CLAUDE.md` | updated | Architecture section reflects new split files |
| `.claude/rules/testing.md` | updated | Mock path updated for message.ts split |

## 2026-03-15 — Fix publish errors (eslint + test files)
- **correction:** `prepublishOnly` script using `npm run lint -c <config>` doesn't pass `-c` through to eslint — must use `npx eslint -c <config>` directly.
- **practice:** Always exclude test file patterns (`**/*.test.ts`, `**/*.spec.ts`, `**/__tests__/**`) from n8n-nodes-base eslint overrides — the plugin enforces node structure rules that don't apply to tests.
- **gotcha:** `parserOptions.project: tsconfig.json` in eslint + test files excluded from tsconfig = parsing errors. Either exclude test files from eslint override or create a separate tsconfig for eslint.

### docs-gaps
| File | Issue | Action |
|------|-------|--------|
| `.claude/rules/best-practices.md` | missing | Create with n8n community node conventions |
| `docs/n8n-testing.md` | missing | Create n8n node testing guide (user requested via /docs-manager) |

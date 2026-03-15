# Best Practices — n8n Community Node

## Type

n8n community node package (TypeScript, pnpm, n8n-workflow peer dep).

## Testing

- **Framework:** Vitest 4.x — see `.claude/rules/testing.md` for conventions.
- **Guide:** `~/.claude/docs/n8n-testing.md` — mock patterns, e2e approaches, CI/CD requirements.
- **Mock boundaries:** typedi Container, NatsService, n8n-workflow interfaces.
- **No real NATS:** all tests mock connections — no server dependency.

## Linting

- **Plugin:** `eslint-plugin-n8n-nodes-base` — enforces node/credential/package.json structure.
- **Test exclusion:** test files (`**/*.test.ts`, `**/__tests__/**`) MUST be excluded from n8n-nodes-base overrides.
- **Prepublish:** uses `.eslintrc.prepublish.js` (stricter rules) via `npx eslint -c` — NOT `npm run lint -c`.

## Node Structure

- `descriptions/` — UI property definitions.
- `actions/` — operation implementations + message utilities.
- `*.node.ts` — thin entry point with `execute`/`trigger`.
- Split convention: message types → `actions/message.ts`, consume logic → `actions/consumer.ts`.

## Publishing

- **Registry:** npm + GitHub Packages via GitHub Actions (`v*.*.*` tags).
- **Provenance:** required from May 2026.
- **Verification:** `npx @n8n/scan-community-package @zetanova/n8n-nodes-nats`.
- **prepublishOnly:** build + lint with prepublish config.

## Dependencies

- NATS v3.x (`@nats-io/transport-node`, `@nats-io/nats-core`, `@nats-io/jetstream`).
- `typedi` for DI (singleton NatsService with connection pooling).
- `n8n-workflow` as peer dependency.

## Gotchas

- `experimentalDecorators: true` required in tsconfig for typedi `@Service` decorator (Vitest 4 / Rolldown).
- `parserOptions.project` in eslint must match a tsconfig that includes the linted files.
- NATS consume loops need parallel health monitors — `connection.closed()` + `messages.status()`.

## Recommended Tools

- **Linters:** eslint + eslint-plugin-n8n-nodes-base, prettier.
- **Testing:** vitest, vitest UI (optional).
- **RTK:** recommended for token-optimized CLI operations — see `~/.claude/docs/rtk.md`.

## References

- [n8n testing guide](~/.claude/docs/n8n-testing.md)
- [Testing conventions](.claude/rules/testing.md)
- [n8n docs](https://docs.n8n.io/integrations/creating-nodes/)

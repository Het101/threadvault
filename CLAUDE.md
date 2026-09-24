# Threadvault — notes for the coding agent

Standalone CLI. Makes an Azure Communication Services chat resource disposable by mirroring threads, participants and messages into Postgres with the host app's own user ids.

## Security

1. **Never read or print the host application's `api/.env`.** It holds live ACS connection strings and production database credentials. Reference environment variables **by name only**.
2. **Never point this tool at a production ACS resource or production database** without explicit, per-run human approval.
3. **Chat message bodies are PHI.** No message bodies in logs, test fixtures, issues, or commit messages. `src/log.ts` strips `content` / `text` / `html` / `body`. Keep it that way.
4. Do not commit, push, or open a PR without explicit human review.
5. Never add `Co-Authored-By: Claude` or `Co-Authored-By: Claude Code` to commits.

## Runtime

- Node `>=22`. Node 18 is unsupported (`globalThis.crypto.randomUUID` is missing). Node 20 is unsupported because current Azure SDK packages require `>=22`.
- TypeScript ESM. `tsx src/cli.ts` for dev, `tsup` for the published bin.
- Tests: `vitest`. Fixtures are synthetic — lorem, never clinical text, never real names.

## Domain rules earned in production

- `senderUserId` is **our UUID**, never an ACS identity. ACS identities are resource-scoped (`8:acs:<resourceGuid>_<userGuid>`) and become garbage on any resource change.
- `sentAt` is the **original** timestamp. ACS stamps its own `createdOn` on replay.
- Participants are always restored. There is no `--participants` flag. `--no-participants` exists only with a warning that names both production defects (misattribution + Forbidden on reply).
- `ACS_EXPECT_RESOURCE` is required for any ACS write. Refuse if the target GUID does not match.
- Do not use `metadata.originalSenderAcsId` on any read path. Use `metadata.originalSenderUserId`.
- Writes are dry-run unless `--commit`.
- Doctor connections run `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`.

## Layout

```
src/cli.ts            commander entry
src/config.ts         env + optional threadvault.yml
src/log.ts            PHI-safe logger
src/acs/              identity parse, retry, pool, client
src/db/               pg helpers, schema, migrate
src/doctor/           five failure-mode checks
src/mirror/           extract + sinks (jsonl | postgres)
src/migrate/          apply + rehearse
```

JSONL `Rec` field names stay byte-compatible with the original production extract format (`legacyThreadId`, `ourUserId`, `ourSenderUserId`) so existing dumps remain valid input.

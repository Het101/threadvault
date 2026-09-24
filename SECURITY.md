# Security policy

Threadvault handles two things that matter: **chat message bodies**, which in the environment it was built for are PHI, and **live credentials** for an Azure Communication Services resource and a production database. Please treat findings here accordingly.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use [GitHub's private vulnerability reporting](https://github.com/Het101/threadvault/security/advisories/new) on this repository. If that is unavailable to you, open a public issue that says only "security report, please make contact" with no detail, and we will arrange a private channel.

Please include:

- What the problem is and what an attacker gets out of it.
- The smallest reproduction you can manage.
- The version or commit you saw it on.

**Never include real message content, real connection strings, real resource GUIDs, or a database URL in a report.** A redacted `threadvault doctor --json` is almost always enough, and if it is not, say so and we will find another way.

Expect an acknowledgement within 3 working days and an assessment within 10. If a fix is warranted we will agree a disclosure timeline with you, and you will be credited in the release notes unless you would rather not be.

## Supported versions

Threadvault is pre-1.0. Security fixes land on `main` and in the next release. There are no maintained release branches yet; when 1.0 ships, the current major will be supported.

## What Threadvault promises

These are the guarantees the codebase is built to keep. A defect in any of them is a security bug, not a feature request:

| Promise | Enforced by |
|---|---|
| Message bodies never reach logs, stdout, or an error message | `src/log.ts` strips `content` / `text` / `html` / `body`; `test/phi-guard.test.ts` fails the build if any source file writes to stdout without going through it |
| `doctor` and `verify` never read a message body at all | Bodies are discarded at the SDK boundary in `src/acs/read.ts` |
| ACS access keys and database passwords never appear in output | `redactSecrets` in `src/log.ts`, applied to `--json` output too |
| No ACS write happens against an unintended resource | `ACS_EXPECT_RESOURCE` is required for any write, and the target is probed and compared first |
| No write happens by accident | Every writing command is a dry run until `--commit` |
| `doctor` cannot modify anything | Its Postgres session is opened `READ ONLY` |
| Remote database connections are encrypted **and** verified | `sslFor` in `src/db/pg.ts`; `PG_SSL_NO_VERIFY` exists but is not the default |
| Secrets do not enter the git history | `.githooks/pre-commit` blocks keys, live database URLs, and `.env` files |

## Things that are not vulnerabilities

- **The JSONL extract contains message bodies in the clear.** That file *is* the backup; it cannot do its job otherwise. Protect the path you write it to, and do not commit it. `.gitignore` covers `*.jsonl`.
- **The replay ledger contains ACS identities.** They are resource-scoped identifiers, not credentials, and are useless without the connection string.
- **`PG_SSL_NO_VERIFY=true` disables certificate verification.** It is an opt-in escape hatch for a private CA, documented as such, and off by default.

## Known accepted advisories

CI fails the build on any **high or critical** advisory. These moderates are known, assessed, and accepted:

| Advisory | Where | Why it is accepted |
|---|---|---|
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — `uuid` missing buffer bounds check | `@azure/communication-chat` -> `@azure/communication-signaling` -> `uuid@8.3.2` | Not reachable. The bug needs `uuid` called with a caller-supplied `buf`; Threadvault never calls `uuid` and never uses the realtime signaling path at all — it only makes REST list/send calls. The only npm-offered fix is downgrading `@azure/communication-chat`, which would reintroduce the Node compatibility problems this project already resolved. |

Re-assessed whenever the Azure SDK is bumped. If you believe one of these *is* reachable, that is exactly the kind of report worth sending.

## Running it safely

- Point it at a **non-production** resource first. `migrate rehearse` exists so you can prove the four durability goals on something disposable.
- Give the database user only the rights the command needs. `doctor` needs `SELECT`.
- Keep `--state` and your JSONL extracts out of shared drives and version control.
- Run `migrate plan` before `migrate apply`, and `migrate verify` after. Neither writes anything.

# OmicOS OSS implementation checkpoint

Updated: 2026-10-25. Branch: `feat/omicos-oss-runtime`. Work is ongoing.

## Implemented and verified

- Harness release baseline updated to `0.2.1-rc.3`, Cordis `4.0.5`, Schemastery `3.18.5`.
- Obsolete client-runtime removed; current UI renderer contract and job progress API adapted.
- Private Core removed from the default installation graph; compatibility mode retained explicitly.
- Independent Node Host / public Python worker protocol with no model loop or private runtime dependency.
- Persistent per-project Python and separate R namespaces, queue, stable invocation deduplication, cancellation and bounded output.
- SQLite WAL execution/memory ledger with transactional receipts, one-time JSON migration preserving originals, lazy durable project registry, incomplete-job recovery, project-level heartbeat lock, distinct kernel generations.
- Figure capture/integrity checks, variable inspection, sourced memory CRUD and notebook export.
- Standalone responsive React scientific workspace; separate store route/window; DSH entry links.
- Host-only cloud device pairing and owner-only credential file; browser snapshots redact credentials.
- Live price catalog, order quote/confirmation, checkout, QR, server-authoritative polling, subscription refresh,
  cancellation/restoration, account-switch invalidation, order-number recovery.
- Loopback, Host, same-origin, CSRF, bounded JSON, explicit execution approval and artifact containment checks.
- Paid-order/invoice UI, explicit invoice application/withdrawal, live lab pricing and owner-filtered seat management/top-up payment; browser flow tested against an isolated mock cloud.
- Workspace data browser, bounded text previews, prepared CSV/TSV/H5AD/RDS loading cells and approved AnnData metadata inspection; real AnnData tests verify X remains unchanged.
- DSH entry resolves the active session workspace through the formal Host controller instead of silently opening the Host process working directory.
- Cloud credentials are bound to their origin; changing cloud bases never forwards previously saved tokens.
- Durable SSE scientific events with Last-Event-ID replay, slow-reader backpressure and snapshot recovery; frontend retry is restricted to pre-dispatch CSRF rejection and preserves operation IDs.
- Python/R workers and environment probes inherit a deliberate runtime variable projection; additional scientific variables require explicit name allowlisting. A real Python test verifies a synthetic Host secret is absent.
- Execution receipts and notebooks include actual interpreter/package versions and environment fingerprints without process environment variables or credentials.
- License notices are generated from actual esbuild inputs for every inlined npm dependency and shipped with source/build/test scripts.
- Public plugin metadata and icon, source/build packaging for standalone CLI.
- Python/R interpreter/package metadata diagnostic endpoint/tool and UI; real R 4.5.2 + jsonlite tests cover variable continuity, cancellation and PDF/PNG integrity.
- Project-fixed Scientist chat bridge through the formal Harness session controller; durable session binding, request IDs, safe history projection, cancellation and workspace validation. Standalone CLI has no model engine; chat is available when opened from the DSH Host.
- Scoped OmicOS Scientist preset and four original public scientific checklists; real Loader/preset mounting tested.

Verification at this checkpoint:

- TypeScript host/client typecheck passed; Node 22.13.1 and current local Node runtime exercised.
- 131 tests passed (including the scientific-environment run), including real Python and real rc.3 Cordis + ToolRuntime cold-load.
- Clean npm-packed production installation (no dev dependencies, no Harness, no private Core) executed Python and served its bundled workspace.
- Built standalone process exercised in actual headless Chrome: Python produced 42; mock cloud login,
  quote, confirmation and QR succeeded; no page errors; mobile layout had no horizontal overflow.
- GitHub Actions workflow added for Node 22.13.1/24, scientific fixtures, clean package and browser smoke; remote CI execution is not yet claimed.
- Reproducible browser/package scripts are checked in under `scripts/`; screenshots now default to ignored `test-results/oss-browser/`. No real payments were made.

## Still to implement / verify (not claimed complete)

### Finish and harden M1

- Full profile browser coverage remains to be checked; the complete suite passed on actual Node 22.13.1, and a packed standalone installation passed without Harness/private Core.
- Full DSH web-profile/browser mounting and hot reload, beyond actual Host service cold-load tests.
- Actual DSH chat/provider/approval browser integration validation; full scientific Skill migration beyond the four bundled checklists.
- Durable payment/order listing beyond the current account-scoped recent-order pointer; verify upstream listing APIs.
- Real staging account / payment sandbox / actual merchant callbacks and entitlement refresh contract.
- Cross-process runtime sharing: current safe behavior is exclusive ownership, not two local servers sharing a worker.
- Runtime installer/downloader and environment provisioning, with user-approved installation and rollback.
- Broader event-ledger provenance coverage, retention and large-history paging. SQLite migration and durable execution receipts are implemented.
- Agent-token streaming and event-driven chat beyond the scientific SSE stream.
- OS keychain integration; current credentials are restricted local files.

### M2–M4 capability migration

- Richer dataset/AnnData charts, upload/import workflows and broader R environment provisioning/platform matrix.
- Notebook cell editing/re-execution semantics, richer figure review/Studio.
- Isolated scientific reviewer and structured evidence/method-version ledger.
- Agent delegation constraints, scientific plans/approvals, session and long-term memory tree/consolidation.
- Immutable Pipeline definitions and checkpointed/resumable execution.
- SSH/SLURM/cloud Runner profiles, compute credits/jobs, optional research/database connectors.
- MCP/A2A integration, scheduled goals, project dossier and enterprise/team capabilities.
- Broader lab collaboration, cloud usage/resource storefront and expiry reminders UI.
- Channels, desktop/system bridge/pets, audit replay, legacy project migration and release documentation.

See `OMICOS_OSS_DESIGN.md` for full scope, capability mapping, boundaries and acceptance criteria.
Do not mark the overall goal complete when only this checkpoint passes.

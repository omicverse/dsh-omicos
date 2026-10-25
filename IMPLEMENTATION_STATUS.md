# OmicOS OSS implementation checkpoint

Updated: 2026-10-25. Branch: `feat/omicos-oss-runtime`. Work is ongoing.

## Implemented and verified

- Harness release baseline updated to `0.2.1-rc.3`, Cordis `4.0.5`, Schemastery `3.18.5`.
- Obsolete client-runtime removed; current UI renderer contract and job progress API adapted.
- Private Core removed from the default installation graph; compatibility mode retained explicitly.
- Independent Node Host / public Python worker protocol with no model loop or private runtime dependency.
- Persistent per-project Python namespace, queue, stable invocation deduplication, cancellation and bounded output.
- Atomic metadata, incomplete-job recovery, project-level heartbeat lock, distinct kernel generations.
- Figure capture/integrity checks, variable inspection, sourced memory CRUD and notebook export.
- Standalone responsive React scientific workspace; separate store route/window; DSH entry links.
- Host-only cloud device pairing and owner-only credential file; browser snapshots redact credentials.
- Live price catalog, order quote/confirmation, checkout, QR, server-authoritative polling, subscription refresh,
  cancellation/restoration, account-switch invalidation, order-number recovery.
- Loopback, Host, same-origin, CSRF, bounded JSON, explicit execution approval and artifact containment checks.
- Public plugin metadata and icon, source/build packaging for standalone CLI.
- Python interpreter/package metadata diagnostic endpoint/tool.
- Project-fixed Scientist chat bridge through the formal Harness session controller; durable session binding, request IDs, safe history projection, cancellation and workspace validation. Standalone CLI has no model engine; chat is available when opened from the DSH Host.
- Scoped OmicOS Scientist preset and four original public scientific checklists; real Loader/preset mounting tested.

Verification at this checkpoint:

- TypeScript host/client typecheck passed.
- 108 tests passed, including real Python and real rc.3 Cordis + ToolRuntime cold-load.
- Built standalone process exercised in actual headless Chrome: Python produced 42; mock cloud login,
  quote, confirmation and QR succeeded; no page errors; mobile layout had no horizontal overflow.
- Browser screenshots: workspace-level `outputs/omicos-oss/`. No real payments were made.

## Still to implement / verify (not claimed complete)

### Finish and harden M1

- Recheck packed artifact on a clean install without private packages; synchronize final lockfile.
- Full DSH web-profile/browser mounting and hot reload, beyond actual Host service cold-load tests.
- Actual DSH chat/provider/approval browser integration validation; full scientific Skill migration beyond the four bundled checklists.
- Durable payment/order listing beyond the current account-scoped recent-order pointer; verify upstream listing APIs.
- Real staging account / payment sandbox / actual merchant callbacks and entitlement refresh contract.
- Cross-process runtime sharing: current safe behavior is exclusive ownership, not two local servers sharing a worker.
- Runtime installer/downloader and environment provisioning, with user-approved installation and rollback.
- SQLite/event-ledger migration: current atomic JSON metadata is a single-owner interim implementation.
- Stream replay/SSE; workspace currently polls bounded execution state.
- OS keychain integration; current credentials are restricted local files.

### M2–M4 capability migration

- R, richer dataset/AnnData state and data file browser/import.
- Notebook cell editing/re-execution semantics, richer figure review/Studio.
- Isolated scientific reviewer and structured evidence/method-version ledger.
- Agent delegation constraints, scientific plans/approvals, session and long-term memory tree/consolidation.
- Immutable Pipeline definitions and checkpointed/resumable execution.
- SSH/SLURM/cloud Runner profiles, compute credits/jobs, optional research/database connectors.
- MCP/A2A integration, scheduled goals, project dossier and enterprise/team capabilities.
- Lab seat purchase/management, invoices, cloud usage/resource storefront, expiry reminders UI.
- Channels, desktop/system bridge/pets, audit replay, legacy project migration and release documentation.

See `OMICOS_OSS_DESIGN.md` for full scope, capability mapping, boundaries and acceptance criteria.
Do not mark the overall goal complete when only this checkpoint passes.

# OmicOS OSS implementation checkpoint

Updated: 2026-10-25. Branch: `feat/omicos-oss-runtime`. Work is ongoing.

## Implemented and verified

- Harness release baseline updated to `0.2.1-rc.3`, Cordis `4.0.5`, Schemastery `3.18.5`.
- Obsolete client-runtime removed; current UI renderer contract and job progress API adapted.
- Private Core removed from the default installation graph; explicit Core mode retains its original account/kernel/capability console and delegated tool surface. OSS Scientist chat is not advertised in Core mode; workspace resolution waits for the active session identity. Real Cordis tests cover Core routing and missing chat, and the actual Harness browser renders the retained console against an isolated legacy DTO fixture.
- Independent Node Host / public Python worker protocol with no model loop or private runtime dependency.
- Persistent per-project Python and separate R namespaces, queue, stable invocation deduplication, cancellation and bounded output.
- SQLite WAL execution/memory ledger with transactional receipts, one-time JSON migration preserving originals, lazy durable project registry, incomplete-job recovery, project-level heartbeat lock, distinct kernel generations.
- Figure capture/integrity checks, variable inspection, sourced memory CRUD and notebook export.
- Standalone responsive React scientific workspace; separate store route/window; DSH entry links.
- Host-only cloud device pairing and owner-only credential file; browser snapshots redact credentials.
- Live price catalog, order quote/confirmation, checkout, QR, server-authoritative polling, subscription refresh,
  cancellation/restoration, account-switch invalidation, order-number recovery.
- Durable SQLite order recovery receipts for subscription and lab-seat checkouts, scoped by cloud origin/account; paginated local history omits payment links. Reopening requires fresh authoritative status, matching amount/provider and a future expiry. Paid/expired/mismatched/unknown links are hidden. Checkout completion is journaled for its original owner even if logout races; local storage failure returns the successful order with a warning, never a retry. Browser reload restores the QR without a new checkout.
- Loopback, Host, same-origin, CSRF, bounded JSON, explicit execution approval and artifact containment checks.
- Paid-order/invoice UI, explicit invoice application/withdrawal, live lab pricing and owner-filtered seat management/top-up payment; browser flow tested against an isolated mock cloud.
- Workspace data browser, bounded text previews, prepared CSV/TSV/H5AD/RDS loading cells and approved AnnData metadata inspection; real AnnData tests verify X remains unchanged.
- DSH entry resolves the active session workspace through the formal Host controller instead of silently opening the Host process working directory.
- Every cloud mutation carries the rendered account/origin/login-generation identity and is rejected before dispatch when stale; automatic refresh never replays account-mismatched billing actions. Project execution and workspace resolution remain account-independent.
- Cloud credentials are bound to their origin; changing cloud bases never forwards previously saved tokens.
- Durable SSE scientific events with Last-Event-ID replay, slow-reader backpressure and snapshot recovery; frontend retry is restricted to pre-dispatch CSRF rejection and preserves operation IDs.
- Python/R workers and environment probes inherit a deliberate runtime variable projection; additional scientific variables require explicit name allowlisting. A real Python test verifies a synthetic Host secret is absent.
- Execution receipts and notebooks include actual interpreter/package versions and environment fingerprints without process environment variables or credentials.
- License notices are generated from actual esbuild inputs for every inlined npm dependency and shipped with source/build/test scripts.
- Local ordered Pipeline executor v1 with content-addressed definitions, embedded versioned references, fixed JSON bindings, declared file hashes, isolated Python/R namespaces, human gates, background execution, SQLite revisioned run journal and checkpoint restoration. Recovery checks inputs, checkpoint bytes and actual environment before restore code; changed environments require explicit acceptance, and partial side effects require review. Unknown work never replays automatically; start IDs deduplicate, stale gate revisions reject, and declared file conflicts block overlapping live runs. Workbench and approved Agent tools expose these operations; R plots and hashed artifacts have real execution coverage.
- Namespace-dependent execution is fenced at the worker queue by expected generation; a lost process cannot silently become a fresh kernel for a later Pipeline step. POSIX worker families use a responsive Node supervisor and Host-lifetime socket, with group cancellation/termination; compiled CLI browser tests confirm actual Python exits after Host SIGKILL before its delayed side effect. Windows process-family lifecycle and Electron-host deployment remain unverified.
- Public plugin metadata and icon, source/build packaging for standalone CLI.
- Python/R interpreter/package metadata diagnostic endpoint/tool and UI; real R 4.5.2 + jsonlite tests cover variable continuity, cancellation and PDF/PNG integrity.
- Project-fixed Scientist chat bridge through the formal Harness session controller; durable session binding, request IDs, safe history projection, cancellation and workspace validation. Standalone CLI has no model engine; chat is available when opened from the DSH Host.
- Persistent nbformat-4 Notebook documents with code/Markdown/raw cells, reorder/edit/save/import/export, optimistic revision conflicts and stable retry IDs. Cell execution uses the existing project Python/R kernel, preserves immutable execution links, invalidates edited outputs and never runs imports automatically. Agent read/update/run tools honor the existing approval boundary. Imported rich outputs and attachments are preserved on export and marked unverified, never rendered as executable browser HTML.
- Revisioned topic/fact/summary memory tree with project, private-session and project-local long-term scopes; proposals, explicit confirmation/promotion, immutable history, CAS/stable operation receipts and atomic consolidation. Source revision changes/withdrawal invalidate dependent summaries; dependent-source consolidation rolls back. Native schema-v1 and original JSON facts migrate without losing confirmation/history. The workbench and approved Agent tools expose paginated search/edit/confirm/withdraw; the scoped Scientist receives only effective confirmed context through the public Harness assembly hook. Actual model-request browser fixtures exclude unrelated private notes and pending guesses.
- Scoped OmicOS Scientist preset and four original public scientific checklists; real Loader/preset mounting tested.

- Workbench pages, APIs, assets and SSE require owner authentication before exposing state. Harness uses its connection service; standalone launch links establish origin-bound signed HttpOnly cookies using private persisted signing state.

Verification at this checkpoint:

- TypeScript host/client typecheck passed; the complete 167-test scientific suite passed on actual Node 22.13.1. Current local Node also exercised real Python/R, packaged CLI, full Harness Web and standalone browser flows.
- 167 tests passed (including the scientific-environment run), including real Python and real rc.3 Cordis + ToolRuntime cold-load.
- Clean npm-packed production installation (no dev dependencies, no Harness, no private Core) executed Python and served its bundled workspace.
- Browser Pipeline flow fixed a definition, persisted its background run over page reload, approved a human gate, and verified actual output/journal. Native Node 22.13.1 tests cover checkpoint restoration after Host restart, changed-file/environment blocking, namespace isolation, true cancellation and interrupted-work deduplication.
- Browser memory flow saves a proposal, confirms it, inspects immutable history, reloads it and withdraws it; full Harness mock-provider requests contain active shared facts and exclude private/unconfirmed notes.
- Browser Notebook flow executed two cells sharing the Python namespace, downloaded verified outputs, and restored source/results after reloading the page.
- Built standalone process exercised in actual headless Chrome: Python produced 42; mock cloud login,
  quote, confirmation and QR succeeded; no page errors; mobile layout had no horizontal overflow.
- Actual isolated Harness Web rc.3 profile: unauthenticated workbench/page/assets/session return 401; after Harness cookie bootstrap all return 200. Full mock-provider chat and main-window approval flow verified: no file before approval; real Python writes 42 after Allow once; assistant history survives reload.
- GitHub Actions workflow added for Node 22.13.1/24, scientific fixtures, clean package and browser smoke; remote CI execution is not yet claimed.
- `pnpm test:harness-browser` creates a temporary profile with the published rc.3 CLI, synthetic local model and isolated credentials; verifies the actual OmicOS tab opens its project workbench, and tests main-window approval before Python side effects. Added to the Node 24 CI job; remote CI results are not yet claimed.
- Reproducible browser/package scripts are checked in under `scripts/`; screenshots now default to ignored `test-results/oss-browser/`. No real payments were made.

## Still to implement / verify (not claimed complete)

### Finish and harden M1

- Additional profiles and platforms remain unverified. The pinned Web baseline has the browser coverage described above; hot reload/remount and further platform behavior still need checks.
- Hot reload/remount behavior remains to be checked; published full Web profile mounting, owner authentication, mock model chat and actual main-window approval have browser coverage.
- Real external provider/BYOK service contracts and full scientific Skill migration beyond the four bundled checklists. The actual DSH controller/provider/approval path has isolated local mock coverage.
- Official cross-device complete order listing remains to be verified; local durable recovery receipts are implemented. Paid-order records use the existing invoicing endpoint; no unverified remote pending-order listing API is invented.
- Real staging account / payment sandbox / actual merchant callbacks and entitlement refresh contract.
- Cross-process runtime sharing: current safe behavior is exclusive ownership, not two local servers sharing a worker.
- Runtime installer/downloader and environment provisioning, with user-approved installation and rollback.
- Broader event-ledger provenance coverage, retention and large-history paging. SQLite migration and durable execution receipts are implemented.
- Agent-token streaming and event-driven chat beyond the scientific SSE stream.
- OS keychain integration; current credentials are restricted local files.

### M2–M4 capability migration

- Richer dataset/AnnData charts, upload/import workflows and broader R environment provisioning/platform matrix.
- Richer Notebook figure rendering/review and Figure Studio; basic persistent cell editing/import/export/re-execution is implemented.
- Isolated scientific reviewer and structured evidence/method-version ledger.
- Agent delegation constraints and scientific plans/approvals; global cross-project memory/dossier indexing. Project-local session/long-term memory tree and explicit consolidation are implemented.
- Broader Pipeline orchestration/templates, mixed-language composition and remote Runner adapters. Ordered local Python/R definitions, human gates and durable checkpoint recovery are implemented; exhaustive I/O capture and exactly-once external side effects are not claimed.
- SSH/SLURM/cloud Runner profiles, compute credits/jobs, optional research/database connectors.
- MCP/A2A integration, scheduled goals, project dossier and enterprise/team capabilities.
- Broader lab collaboration, cloud usage/resource storefront and expiry reminders UI.
- Channels, desktop/system bridge/pets, audit replay, legacy project migration and release documentation.

See `OMICOS_OSS_DESIGN.md` for full scope, capability mapping, boundaries and acceptance criteria.
Do not mark the overall goal complete when only this checkpoint passes.

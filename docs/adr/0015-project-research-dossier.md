# ADR 0015: Project research dossier with explicit evidence snapshots

Status: implemented for project-local authored findings and bounded source-record snapshots. Global indexing, automatic scientific review and redacted replay/data bundles remain separate work.

## Evidence and authority

A project-owned private schema-1 SQLite journal stores titles, findings, limitations, tags, 1–10 explicit source pins, immutable entry revisions, current pointers and stable actor-bound operation receipts. Entries are limited to 2 MB; oversized captures fail before mutation. Host source resolvers read actual project records rather than accepting proposed snapshot payloads from a model. No private session memory or chat is automatically copied.

Supported sources are committed terminal Python/R executions, a specific committed Pipeline execution with its dispatch method bindings, completed file-import receipts, current method versions/reviews, current Figure Studio records, editable Notebook documents and scientific plans. Scope is explicit per source: execution and plan success do not establish scientific validity; imported Notebook outputs remain unverified; import receipts describe commit-time dataset identity and do not read/check current file bytes. Figure captures explicitly check artifact bytes, but those bytes are not embedded in the dossier. No source lookup runs new scientific code or contacts cloud services; ordinary project startup retains its separate environment verification behavior.

Each source payload/scope is canonicalized and SHA-256 pinned with a capture timestamp. Each full entry has its own digest. Edits and explicit recapture create a new draft; existing review does not carry over. Source changes are never silently applied to historical entries. Search and 50-entry discovery pages operate on authored titles/findings/limitations/tags. Revision history returns summaries; exact historical snapshots are opened separately so a page cannot transfer fifty 2 MB documents. Agent proposal replies and normal reads return source references/digests rather than duplicating all snapshots into model context.

## Human interpretation and freshness

Only owner-authenticated/CSRF-protected workbench controls review or withdraw entries. Review requires current entry revision, a human note and fresh comparisons against every selected source. A changed/unavailable source rejects assessment until explicit recapture. Per-source comparison timestamps/hashes are retained in the review. Checks are sequential observations, not a global transaction across all source services. Review records compilation and human interpretation, not independent scientific or legal validation and not execution permission.

A previously reviewed entry remains a historical reviewed revision when a source later changes; explicit current integrity checks report `needs-review`. The UI labels that state as historical, checks the exact viewed entry revision and exports that exact revision. Withdrawal is possible even when evidence is missing and preserves its reason. Stable retry never reapplies an old review after edits or withdrawal. Older source snapshots and assessments remain readable/exportable even when the live source is unavailable.

Export is portable local JSON containing saved record snapshots, source scopes and human findings. It does not auto-upload, regenerate artifacts, embed datasets or automatically redact execution text/paths. Current source integrity is a separate explicit check, not implied by export. An isolated scientific reviewer, cross-project dossier search, source-data packaging, automatic synthesis and redacted audit replay are not implemented by this change.

## Lifecycle and verification

Dossier mutations drain before underlying project services close. A real Pipeline race exposed a terminal worker whose ledger was already closed while its cache entry still existed. Receipt lookup now skips closing workers and reads the committed ledger directly. A regression fixture holds the actual disposed-worker/cache-removal boundary and reads/captures the real receipt without a timing sleep.

Native tests cover source resolution over forged input, actor/operation and revision identity, immutable review/export/history, source staleness/withdrawal, absent/oversized sources, bounded discovery/history, restart, actual Python/Pipeline receipts and actual Figure artifact tampering. Import tests explicitly demonstrate the import-receipt-only scope after later dataset edits. HTTP/real ToolRuntime tests verify owner/CSRF/confirmation and absence of Agent review tools. Chrome captures actual Pipeline/method evidence, reviews it, withdraws the method, observes changed source identity, downloads the frozen original JSON, recaptures to draft and reads old history after reload. Concrete full-suite/platform evidence is recorded in IMPLEMENTATION_STATUS.md.

# Remote Project Data Import Implementation Plan

> Execute the authorized OmicOS OSS migration in this worktree. Follow the existing executing-plans workflow; no additional implementation confirmation is needed.

**Goal:** Import remote HTTPS datasets into a project with durable source/progress receipts, explicit resume/cancel, verified publication and no automatic scientific execution.

**Architecture:** A project-owned download service streams into private staging and commits 4 MiB chunk hashes/progress in SQLite. It records exact response representation metadata and supports Range/If-Range continuation only with a stable strong ETag and total length. Completed staging is adopted by the existing DataUploads publisher through an internal fixed-path operation, preserving its full hash, no-overwrite, directory-identity, crash-recovery and receipt semantics without copying a multi-gigabyte file twice. Remote receipts bind the source request and resulting upload receipt; reads never start network work.

**Tech Stack:** TypeScript, Node fetch/streams/fs, existing node:sqlite WAL/FULL stores, React workbench, Vitest, actual local HTTPS fixture for browser coverage.

## Decisions and scope

- Compare direct publication, a second streaming publisher and adoption by DataUploads. Use adoption to retain one publication contract and avoid duplicate large-file disk writes; do not weaken the existing immutable upload manifest.
- HTTPS only in production, credential-free URLs/requests, explicit redirect-origin allowlist, no account tokens/cookies, identity encoding, at most five redirects, 10 GiB upper bound. Expected size/SHA-256 may be provided independently; actual final hash always records exact bytes. A transport-only download is visibly distinct from matching a supplied checksum.
- Resume after restart is explicit. Verify committed local chunks before requesting more data. Require exact range offset/total/strong ETag, reject representation changes, and never silently restart over a partial file. Unknown-length/no-strong-ETag transfers can complete in one pass; interruption requires an explicitly new import or cancellation.
- Pause retains chunks; cancel removes private staging and unfinished linked upload state, never project files. Publication is serialized by the existing upload service and cannot be paused midway into an ambiguous commit.
- Preserve literal URLs only in the owner/private receipt; summaries and ordinary UI omit query strings. No automatic unpacking, authenticated connector, load, analysis or model request is included.

## Task 1 — Internal verified-stage adoption

Modify src/oss/uploads.ts to adopt only a fixed project-owned downloads/<id>.part path. Check canonical parents, regular file/size, immutable upload request replay and current upload state. Link/rename into the upload staging area under its serialization lock, fsync, then reuse finalize. Test exact hashes, no overwrite, changed directory/source, cancellation, replay and ordinary-upload regressions.

## Task 2 — Durable downloader

Create remote-import-types.ts and remote-imports.ts. Store request/response/progress/chunks/publication linkage; validate source/destination before network work; fence per-record operations and project concurrency. Implement initial download, stable-representation Range continuation, pause/cancel, failed/interrupted recovery without execution, and publication replay. Native fixtures verify real HTTP byte streams, range headers, source drift, redirect denial, no secret headers, unknown length, checksum mismatch and crash/partial-tail semantics. Fixture-only loopback support is not a production configuration.

## Task 3 — Runtime, owner HTTP and workbench

Mount the service once per owned project, dispose downloads before upload ledgers, add owner/CSRF-protected explicit actions and capability discovery. Add a remote import pane to DataBrowser with source/allowlist/checksum fields, consent, durable receipt selection/progress, pause/resume/cancel and explicit file refresh after commit. Keep existing load preparation separate.

## Task 4 — Product verification and documentation

Exercise real local HTTPS transfer via standalone Chrome, including receipt/reload/resume behavior and no execution. Run targeted tests, full native scientific suite, typecheck/build and clean package install. Inspect screenshots; record exact scope/limitations and authoritative results in README, ADR and IMPLEMENTATION_STATUS. Commit a reviewable checkpoint while leaving the overall migration goal active.

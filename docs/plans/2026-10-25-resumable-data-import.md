# Resumable project data import implementation plan

Goal: owner-approved, bounded-memory file upload with durable resumability, verified bytes and atomic no-overwrite publication. Loading data into Python/R remains a separate approved scientific execution.

Architecture: project-exclusive SQLite stores immutable upload requests (stable operation, target, size, 4 MiB chunk hashes and optional independent expected whole-file SHA-256), durable received offsets and import receipts. Browser hashes/transmits one slice at a time; no base64 or whole-dataset JSON. Private staging files are fsynced before offset commits. Recovery truncates uncommitted bytes to the durable offset and reconciles interrupted publication by inode identity, never by guessing from equal names/content.

Decisions: reject hidden/private/outside paths and preserve existing files. Use a hard link as atomic no-replace publication on the project's filesystem, with no overwrite fallback across unsupported filesystems. Final whole-file SHA-256 and size are recorded; the declared chunk manifest gives resumable browser file identity without requiring an unbounded whole-file browser hash buffer. An optional external expected whole-file hash must match before publication. Manifest identity is not scientific validity. Four active uploads/project, 10 GiB/file, 4 MiB/chunk; list/history responses are bounded.

Tasks:
1. Add upload types and native store: start/list/read, serialized chunk append, exact retry checks, final verification/publication, cancel/partial cleanup, crash recovery and disposal. Test out-of-order/corrupt/repeated chunks, conflicting destinations, staged append crash and interrupted publication ownership.
2. Wire runtime ownership plus authenticated/CSRF/protocol-protected raw PUT chunks and JSON controls. Agent surface is read-only. Test auth/CSRF/limits and that imports do not start interpreters or contact cloud.
3. Add browser slice hashing and a data import panel: progress, pause, reselect/resume after reload, expected SHA-256, destination conflicts, receipt and explicit cancellation. Keep selected file bytes/path out of persistent browser storage. Refresh data browser after committed import; preparation/loading stays separate.
4. Exercise real HTTP filesystem bytes and Chrome unknown-response/reload recovery. Run native Node 22.13 baseline, typecheck, build and clean package. Document filesystem/platform and provenance limits.

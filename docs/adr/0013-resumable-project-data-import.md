# ADR 0013: Resumable verified project file import

Status: implemented with native filesystem and Chrome coverage. This copies files into a local project; it never deserializes datasets or executes scientific code.

## Data and authority

The browser reads one 4 MiB slice at a time, computes SHA-256 chunk hashes and pins the ordered chunk manifest plus total size. It never buffers an entire large file or puts dataset bytes in JSON/localStorage. The maximum is 10 GiB/file and four active project imports. An optional independently obtained expected whole-file SHA-256 is immutable with the request. The source manifest gives exact byte identity for reselect/resume; it is not a publisher signature or a claim of scientific validity.

A private schema-1 SQLite journal stores immutable source/target requests, stable operation IDs, source checksums, durable received offsets, final hashes and terminal receipts. State/target/cleanup indexes avoid scanning every completed manifest for active reservations. Lists page at 50 summaries; exact metadata remains readable. Upload bytes and journal live in the project's private runtime directory. Owner authentication, same-origin checks, CSRF and protocol negotiation apply before raw PUT dispatch. Chunks are at most 4 MiB; both size and approved hash must match. The Agent surface only reads import state/receipts. No cloud account, private Core, scientific interpreter or model loop is required to copy bytes; ordinary project startup can still perform its separately configured environment verification.

## Chunk and commit protocol

Chunks are serialized per project and accepted only at the next durable offset. Exact retry of an earlier chunk checks its staging bytes without appending again. Out-of-order or mismatching chunks reject. Staging files are fsynced before offset commits. Unknown network results are not automatically replayed; the client reads the durable record, re-hashes a reselected local file and resumes from the confirmed offset. Only a precise pre-dispatch CSRF rejection permits a transport retry of the same offset/body.

Finalization streams a complete SHA-256 and rechecks the source chunk manifest and file identity. An external expected hash must match when supplied. The destination must be an existing permitted project directory with the same canonical path/device/inode identity recorded at start. Private/hidden/outside destinations, portable reserved names and existing file/symlink targets reject.

Publication uses an atomic **no-overwrite hard link**, followed by directory fsync and a completed receipt. There is no rename-overwrite or cross-device copy fallback. A committing record stores the verified hash before linking; after a crash, recovery adopts publication only when destination and staging are the same actual file, then verifies bytes before completing. An independently existing file with equal name/hash is not adopted. A post-commit staging cleanup failure leaves a completed receipt and pending cleanup, never demotes success or deletes/recreates the project file. Private staging deletion is also synced before cancellation/cleanup completion.

## Recovery and user control

Recovery truncates staging tails beyond the committed offset, preserves confirmed bytes and never automatically transmits or publishes pending uploads. Interrupted finalization returns to an explicit resumable state. Missing/short/invalid staging fails visibly. Cancellation aborts verification before publication where possible, waits for the serialized operation and removes private staging only. Once publication is confirmed, cancellation cannot remove the project file. Destination changes/unknown commit outcomes are preserved for inspection, not silently redirected.

The UI supports new-file approval, hashing/confirmed-byte progress, pause, exact-record lookup, source reselect after reload, wrong-source rejection, explicit finalization as part of the approved import and cancellation. Imported CSV/TSV/H5AD/RDS files use existing **prepare loading code** actions; the code still requires a separate scientific execution approval. Files may later be changed by analysis or the user. A completed import receipt describes bytes at commit time, not current integrity or data interpretation.

## Evidence and limits

Native tests exercise real multi-chunk files, replay, restart offsets, corrupt bytes, expected whole-hash rejection, destination conflicts/symlinks/replacement, empty files, cancellation, bounded discovery and both interrupted append/publication windows. HTTP tests cover owner/CSRF/explicit confirmation, binary input and absence of automatic execution/cloud calls. Browser hashing tests prove bounded slices and cancellation. Chrome deliberately loses the already-committed first chunk's response, reloads, rejects a wrong source, resumes at 4 MiB/8 MiB, verifies original full file bytes/hash and prepares an imported CSV without executing it. The actual published Harness Web profile also verifies binary PUT under its owner cookie/CSRF boundary and confirms imported file bytes without starting scientific execution. Node 22.13 baseline and clean-package evidence are in IMPLEMENTATION_STATUS.md.

The compatible same-filesystem hard-link/fsync contract is deliberate; unsupported or cross-device destinations report failure without overwriting anything. Full Windows/network-filesystem behavior and power-loss hardware guarantees are not claimed. File parsing, directory/archive import, remote object stores, broader upload policies, retention and exhaustive scientific I/O provenance remain separate work. These application checks do not sandbox other code already authorized to run as the same OS user or prevent that user from racing filesystem changes.

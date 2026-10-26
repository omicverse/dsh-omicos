# 0028 — Exact-revision streamed Pipeline metadata export

Paged presentation must not make the complete durable run inaccessible. The owner
can explicitly download one pinned run's original definition, full run JSON and
complete event journal. This is a metadata/audit export, not a self-contained
scientific replay bundle: external dataset/artifact files and separate full
execution receipts are not gathered. Existing literal values in code, parameters
and event data remain present. It is not a redacted or anonymized export.

A separate read-only SQLite connection opens a WAL snapshot after checking the
stored file identity, application/schema and requested run revision. The pinned
definition is validated with the existing content-addressed normalizer, under its
2 MB bound. Original JSON fields stream as BLOB slices of at most 64 KiB, preserving
UTF-8 byte boundaries by passing bytes unchanged. Event headers page at 100 rows;
each event data field is independently chunked. JSON validity is checked in SQLite.
The exporter never invokes the full-run JavaScript getter or constructs a complete
export object. SQLite may still load/process the stored JSON internally; this is
not a claim of bounded process RSS or normalized large-run mutation storage.

Two passes over the same snapshot compute byte length/SHA-256 and then deliver the
body. The timestamp and outer envelope are fixed before both passes. A concurrent
write cannot alter the chosen revision or journal mid-download. HTTP attaches the
exact length, SHA-256 and revision, with no-store and attachment headers. The
browser streams the native download rather than accumulating the bundle in a
frontend Blob. The UI describes the included code/parameters/paths and offers the
digest for independent verification; it does not claim an automatic client hash
check. An interrupted connection cannot legitimately complete the advertised
Content-Length. The digest identifies snapshot bytes, not scientific validity or
cryptographic proof that the original database history was never altered.

At most two snapshots may be open in the loaded export module. A ten-minute lease,
caller disconnect, early iterator return or Store shutdown closes the read
transaction and releases its slot. Hashing yields between chunks to observe
cancellation. HTTP writes await drain under backpressure and retain no unbounded
chunk queue. Drain waits observe both connection and snapshot cancellation, so
Store shutdown or lease expiry also interrupts a stalled client. Closing an export does not cancel a model, kernel or Pipeline.
Stale/missing revisions fail before attachment headers. Existing owner/project/
origin guards cover this GET; no write, execution, import or replay endpoint is
added. A SQLite snapshot may retain WAL history while a download is in progress;
lease/count limits bound that lifetime, not its possible disk volume.

Tests export a multi-megabyte Unicode run including a metadata item beyond the
history inspector's 2 MB cap, all 65 attempts and more than 200 events. They forbid
full-get use, mutate the live run after capture, verify exact original metadata,
length and hash, test leases/abort/shutdown and reject altered definitions or
malformed event JSON. HTTP coverage verifies owner authentication, required
revision, stale rejection and full downloaded bytes. A controlled slow-response
fixture verifies production pauses until drain and releases the export on close.
The standalone browser fixture downloads a real Python Pipeline snapshot and
checks its definition, attempts, length and SHA-256 without re-executing it.

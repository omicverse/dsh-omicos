# 0027 — Bounded Pipeline run presentation and history

Collection paging did not bound one repeatedly recovered run: the workbench and
Agent state tool still received every attempt, checkpoint and recovery on each
read. A large run therefore enlarged both browser state and model context.

PipelineStore now provides a run window and independent attempts/checkpoints/
recoveries history. Windows include at most the latest 20 summaries of each kind,
counts, current control revision, environment and declared inputs. Attempt output
and error previews are limited to 1,000 characters. Summary rows omit environment,
method-review bodies, file lists and artifact lists; counts and exact execution
identities remain available. Checkpoint summaries retain attempt identity and step
for explicit recovery selection. Recovery summaries retain decision flags and
fingerprints. SQLite projects rows/scalars before JavaScript deserialization;
window/history reads do not invoke full PipelineStore.get.

History pages use descending array positions with one lookahead row. Older pages
require the observed run revision, and a changed run returns 409. The UI holds one
page and cancels stale requests on run/type changes. A selected old checkpoint is
retained in the control form even when absent from the latest window. This is a
selection only: existing human confirmation, current-revision checks, file hashes,
environment comparison and recovery dispatch rules still apply. Complete execution
receipts, code/output and artifact previews remain available on demand from both
recent and historical attempts. Single exact metadata items may be inspected at
the page revision, with a 2 MB serialized-item limit enforced inside SQL before
transferring the JSON to JavaScript. Oversized items remain in durable storage;
this endpoint does not pretend they were deleted or replay them.

Workbench polling, exact-ID lookup and opt-in start/control responses use windows.
The Harness state/start/control tools also return windows, with explicit history
parameters for older metadata. Run event reading validates the header without
materializing a full run, and the UI replaces each event page rather than growing
an unbounded concatenated log.

Compatibility and limits: the absent-view HTTP read remains the original full-run
API for existing consumers and evidence capture. Invalid explicit view names fail
closed. Internal mutation/recovery still stores and materializes one JSON run;
SQLite JSON projection still scans that stored JSON. This change does not claim
normalized constant-memory mutation storage, full-run streamed exports, bounded
explicit execution receipts, snapshot isolation across processes, or exhaustive
scientific I/O provenance. Environment and raw-input evidence are retained under
their existing producer bounds.

Native tests seed 65 attempts/checkpoints and 45 recoveries, forbid full get during
window/page reads, traverse all positions without duplicates, inspect original
metadata, reject stale/invalid cursors and reject an oversized item without
forwarding it. HTTP tests cover owner authentication, window totals, pagination,
exact metadata and stale revisions. Actual rc.3 ToolRuntime reads verify windowed
state and old attempts without starting a kernel. The browser regression reads
real Python Pipeline history and checkpoint SHA-256 metadata, opens a historical
execution receipt and retains the existing approval/reload/method-review flow.

# ADR 0011: Human-governed scientific plans

Status: implemented in the OSS runtime. This is a declarative governance ledger, separate from executable Pipelines.

## Decision

A plan pins a research objective and 1–100 ordered steps with explicit input/output declarations, method/version references, risks and acceptance criteria. Native SQLite schema 1 stores current documents, immutable content-digested revisions and stable-operation receipts. Definitions are normalized and SHA-256 pinned; a human approval binds that exact definition digest. Every edit returns to draft and clears current approval and task assessments, preserving all previous revisions.

The Harness surface is read/propose only. Proposals use the existing tool approval mechanism; neither a proposal nor an approved plan grants any permission to execute code, install software, delegate, upload data or buy cloud resources. Approval/rejection/withdrawal and task decisions are exposed only through owner-authenticated, CSRF-protected workbench routes with explicit confirmation and a required human note. The UI disables decisions while source edits are unsaved. Ordinary trusted OS-user scientific code is not a sandbox: this is an application authority boundary, not protection against malicious code already authorized to run as the owner.

Completion requires real successful execution receipts from the same project or a named Pipeline run. The service resolves committed execution records, not client-submitted output. It records language, code/output hashes, environment identity and artifact metadata. Unknown, nonterminal, failed, canceled and interrupted receipts cannot complete a task. Inputs/methods are still declarations; receipt association and human assessment do not prove biological/statistical correctness, exhaustive I/O capture or current artifact-byte integrity. Figure Studio retains its separate byte validation and review semantics.

Earlier steps must be completed or explicitly skipped before later completion/skip. Blocking can record a reason and optional failed receipt. Reopening one step clears its current and downstream assessments; prior decisions remain readable in immutable history. Withdrawn/rejected plans need a new draft before approval. Stable operation retries return the current document without repeating or restoring an obsolete approval. Different payloads or actors cannot reuse an operation. Optimistic revisions prevent two windows from approving different current definitions.

## Persistence and lifecycle

The project runtime owns `research-plans.sqlite` under its exclusive private project directory. WAL/FULL commits update revision, current pointer and operation receipt atomically. Runtime disposal drains plan mutations before closing scientific/Pipeline services. Lists and revision history use 50-entry cursors, search and exact IDs; missing items on the first page are never deletion evidence. Reading, proposing and deciding never starts an interpreter or sends project data to the cloud. Source receipt lookup may read an existing Pipeline ledger, without starting its worker.

## Evidence

Native tests cover immutable history/restart, actor-bound stable retries, revision conflicts, paging, invalid definitions/cursors, task order/reopen, rejected/nonterminal evidence, real Python and isolated Pipeline receipts. HTTP tests verify owner/CSRF/explicit confirmation, no implicit execution, actual receipt association and edit invalidation. Real rc.3 ToolRuntime denies unapproved proposals and exposes no approval tool. Chrome smoke approves a plan, assesses an actual Python receipt, edits back to draft, reloads and reads the earlier source-pinned assessment. These checks do not claim isolated scientific review, autonomous planning/delegation or external scientific validity; those remain separate migration work.

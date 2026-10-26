# Research Plans Implementation Plan

**Goal:** Implement project-owned scientific plans, explicit human approval and receipt-backed task tracking without implicit execution.

**Architecture:** A private schema-versioned SQLite journal stores immutable plan revisions, current pointers and idempotency receipts. The owner-authenticated workbench alone approves/rejects plans and assesses task outcomes; Harness tools may read or propose plans. Existing execution approval remains mandatory. Revisions never grant permission to run code, install software, purchase resources or delegate work.

**Tech Stack:** TypeScript, native Node SQLite, React, existing owner/CSRF boundary and Python/R execution receipts.

## Decisions

A chat-only checklist loses durable identity and approval history. Reusing executable Pipeline gates would make exploratory plans unnecessarily executable. Use an independent declarative plan ledger instead, with explicit cross-links to existing immutable execution receipts.

- Definition: title, objective, 1–100 stable-ID ordered steps, inputs, outputs, method references, risk and acceptance criteria; each field is a declaration, not independently verified evidence.
- Every definition edit returns to draft and clears current approval/task assessments; previous revisions remain readable. Approval binds a SHA-256 definition digest and the exact current revision.
- Only owner workbench routes expose approval, rejection, withdrawal and task assessment. Agent proposals require existing Harness approval but cannot self-approve through a tool. All mutations require stable operation IDs and optimistic revisions; unknown-response retries never repeat transitions.
- Completed tasks require a real successful project or Pipeline receipt plus explicit human assessment. Failed/interrupted receipts cannot prove completion. Receipt association does not prove scientific validity, and no code executes through a plan operation.
- Earlier tasks must be completed or explicitly skipped before later completion. Skipping/blocked/reopen require human reasons. History retains previous assessments and actual receipt hashes.
- Lists/history are bounded to 50 entries. Runtime project ownership controls lifecycle; no default private Core dependency.

## Tasks and validation

1. Add plan types/store and lifecycle. Test create/edit/approve/CAS/replay/restart/history pagination; invalid or missing evidence fails closed.
2. Wire runtime receipt resolution, owner-authenticated HTTP and read/propose Harness tools. Test unauthenticated/CSRF rejection, no approval tool and real-receipt validation.
3. Add workbench plan editor, explicit human controls, evidence assessment and immutable history. Preserve unsaved edits during background reads and fence delayed selection responses.
4. Extend real Chrome smoke to create/approve/assess an existing actual Python execution, revise to draft and reload history. Run typecheck, native tests, build and clean-package smoke; document capability and remaining broader delegation/reviewer scope.

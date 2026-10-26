# ADR 0014: Versioned scientific method packs and managed execution pins

Status: implemented. This provides a method registry and application execution checks, not an independent scientific reviewer or an unrestricted executable plugin installer.

## Immutable documents, local human publication

A project owns a private schema-1 SQLite method registry. Pack schema `omicos.methods/1` contains 1–20 methods below 1 MB. Documents declare a stable key/version, title, description, guidance body, authors, credential-free HTTPS sources and license id/text. Sources are never fetched automatically and license declarations are not independently validated. Original guidance is plaintext; scripts, package-install hooks and foreign review objects are not executable inputs.

Canonical document JSON is content-addressed by SHA-256 and limited to 45000 characters, within the existing Pipeline reference limit. The key/version pair is unique and immutable: changed text, license, authors or source declarations require a new version. Pack normalization/conflict checking precedes one atomic transaction. Stable operations are payload/actor-bound; retries/reimports return current state without recreating or reapproving a withdrawn version.

New documents are drafts. Only owner-authenticated, CSRF-protected workbench controls can publish/withdraw/restore, with current review revision, explicit note and stable operation ID. All decisions remain in immutable review history. Export preserves original content and origin receipts; import never transfers another project's approval. Agent tools may read or propose a pack through existing Harness approval, but expose no publication/withdrawal tool. Proposal responses summarize identities/reviews rather than repeating all imported bodies into model context.

The existing four public built-in checklist IDs and original texts remain available. An explicit workbench action prepares them as a GPL-3.0-only pack for local review. There is no automatic catalog overwrite or private/paid Skill extraction. The installable library is implemented; broader authored scientific content and official resource licensing remain migration work.

## Managed Pipeline bindings

A managed reference is `omicos-method:<content-sha256>` with the exact canonical text, version and text hash. Registry-backed define/start/continue/recovery checks require the current local state to be published. Missing, mismatched, malformed or withdrawn managed references reject. A Pipeline service without its registry fails closed for managed references. Unmanaged external references remain declarations, not library-verified methods; this is not a universal proof that arbitrary user code follows a method.

Each scientific dispatch can carry an internal pre-dispatch callback, never supplied via HTTP/tool JSON. It runs before worker startup, after startup and immediately before writing code. Pipeline callbacks recheck managed references and journal the exact successful review revision at dispatch. This closes the window where a method is withdrawn while the interpreter is starting. Callback failures produce an interrupted receipt explicitly stating that code was not executed. Hooks are removed on terminal/disposal and do not change the ordinary execution approval contract.

Method withdrawal does not rewrite historical references/results or automatically kill already-running code. It blocks new starts, continuation/recovery and later dispatch. Cancellation/rejection remain available so a waiting workflow is not trapped. A deliberately restored exact method version can be explicitly continued, recording the newer review revision while preserving earlier attempt evidence. A new method version never silently upgrades an existing definition.

## Workbench and lifecycle

The library supports pack file/JSON editing, explicit built-in preparation/import, bounded search/review history, exact content lookup, source/license inspection, local publication/withdrawal, export and managed reference display. Existing draft text is not overwritten by background list reads. Review-note drafts reset when review identity changes. Pipeline's method picker fetches an exact published reference and only appends it to the current draft; steps/parameters are preserved and identical existing pins are a no-op. Saving/running still requires normal explicit actions.

Runtime method stores are cached per canonical project and disposed after Pipeline workers, so dispatch checks never use a deliberately closed registry. Reads/list/history are bounded to 50 records, without starting scientific kernels or contacting the cloud. Ordinary trusted OS-user code is not sandboxed; application checks cannot protect the registry against code already authorized to modify local files as its owner.

## Evidence and remaining scope

Native tests cover atomic import conflict, content/declared license retention, CAS/replay/reimport, export/import approval isolation, review/version paging, restart/tamper rejection, forged self-consistent reference bytes, absent-registry rejection, actual Python/R Pipeline pins, gate withdrawal/restoration and startup/final-dispatch rejection before file side effects. Chrome imports/reviews a method, adds its exact pin while retaining an unsaved definition, blocks a withdrawn gate, restores it, executes real Python and reads review history plus dispatch revisions `[2,4]`. The full published Harness profile retains its existing owner/approval/scoped Scientist behavior. Concrete run counts/limits are recorded in IMPLEMENTATION_STATUS.md.

This does not claim global method approval for ad hoc code, automatic scientific validity/legal verification, isolated scientific review, exhaustive dataset I/O capture, remote method discovery or full public scientific Skill content migration. Those remain explicit work items.

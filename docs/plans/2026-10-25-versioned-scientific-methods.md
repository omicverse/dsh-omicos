# Versioned Scientific Methods Implementation Plan

Goal: installable public/owner-authored scientific method packs with immutable versions, source/license declarations, human publication and enforceable managed Pipeline pins.

Architecture: a project-owned native SQLite registry stores content-addressed method documents, unique key/version pairs, immutable review events/current pointers and stable operation receipts. Pack import is atomic and never imports approval from another project. Existing four built-in checklists remain backward compatible and can be explicitly imported for local review. Method text is guidance, never a new authority or independently validated scientific evidence.

Decisions:
- Pack schema `omicos.methods/1`, 1–20 methods, ≤1 MB; each document has key/version/title/description/body, declared authors, HTTPS sources and license id/text. Canonical document text is ≤45000 characters so existing Pipeline reference bounds remain valid. No remote fetch, scripts, executable install hooks or package installation.
- New content is draft. Same key/version with changed bytes conflicts; publish a new version instead. Human-only publication/withdrawal/restoration requires current review revision, explicit note and stable operation. Export retains origin receipts but import ignores foreign approval. Reimport/retry cannot restore withdrawn approval.
- A managed reference uses `omicos-method:<content-sha256>` with exact document text/version/hash. Define/start/continue/recovery and actual scientific dispatch check current local publication. Missing, forged or withdrawn managed references reject before code. Already-running code is not auto-killed; next stages cannot proceed. Unmanaged references remain explicitly declared, not library-verified.
- Execution records retain the review revision used at dispatch. The pre-dispatch check is an internal callback, not user-supplied JSON or a new permission grant; ordinary code/tool approval remains mandatory.

Tasks:
1. Implement validated method pack registry, bounded search/review history/export and built-in pack bridge. Test atomic conflicts, content identity, stable replay, status transitions, restart and paging.
2. Add managed Pipeline reference checks and internal scientific dispatch hooks. Test a real Python method-bound run, withdrawal at a gate and before dispatch, rejected forged pins and preserved old method revisions.
3. Add owner/CSRF workbench routes, read/propose Agent tools and Method Library UI with explicit publish/withdraw and reference preparation. Preserve unsaved Pipeline edits when adding a method reference; never start a workflow from method selection.
4. Browser validation imports/reviews a method, inserts an exact pin into a draft Pipeline, executes approved real code, withdraws and verifies future run rejection, and restores history after reload. Run native Node 22.13 baseline, typecheck/build/clean package/real Harness as applicable. Document broader scientific content/reviewer gaps.

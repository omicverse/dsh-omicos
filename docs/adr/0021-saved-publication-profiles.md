# ADR 0021: Versioned project publication preferences

Status: implemented. Journal certification and physical page presets are separate.

Projects store named PDF preferences in a private SQLite registry: DPI, explicit
attachment policy and optional contained-project font path/SHA/license declaration,
plus a name/description. Font files, scientific data, assembly geometry and export
consent are not copied. Saving does not read/install fonts, run science or approve
an export. Every actual export still verifies current source/font bytes and asks
for confirmation. Missing fonts may be saved as future preferences but fail the
usual checks if exported before the correct bytes are available.

The registry uses immutable revisions, content digests, compare-and-swap edits,
archive/restore revisions, and actor-bound stable operation receipts that return
the exact committed revision on retry, even after later updates. Input is copied
before queueing; shutdown rejects new saves and drains accepted writes. There are
at most 100 profiles including archives, with 50-entry search/history pages and
exact-ID/version retrieval. Names/descriptions and complete records are bounded;
unknown export fields remain invalid. The database has application/schema guards,
WAL/FULL transactions and a nofollow regular-file opener; it is not shared across
Host processes outside the project's existing exclusive ownership model.

The workbench explicitly loads a selected version, resets PDF confirmation/hash,
and exposes save-as-new, history and archive/restore. Saving a normal preference
also resets consent; archiving preserves the last saved settings rather than
silently saving unsaved form edits. A historical version is usable, but updating
from a stale version fails until the user rereads the current record.

When exporting an applied saved version, the request separately includes its ID,
revision and digest. The Host checks that immutable record and exact normalized
settings, then includes the saved preference in source-mode provenance. It does
not silently substitute the latest configuration. A saved-version acknowledgement
header is required by the client before accepting the download, so an older Host
cannot ignore the reference. Editing export settings clears that reference.
Page-only mode preserves its no-attachment/no-Info contract and does not embed
the preference record; only the response acknowledges the verified preference.
Preference/version identity is not scientific review or legal verification.

No global/cloud preferences, font installation, automatic export, journal profile
claim or cross-project authorization transfer is introduced. The optional font
path is rechecked against the target project's actual containment/private-file
rules at export; a declaration is not proof of embedding permission.

Native tests cover persistence/reopen, immutable history, exact operation replay,
CAS, copied queued inputs, archive/restore, shutdown draining, discovery/history
bounds, saved-reference matching and invalid database/symlink rejection. Owner/CSRF
HTTP tests cover saves and both bound PDF policies; source-mode PDF attachments
are inspected for the exact preference digest, while page-only has no attachments.
Client tests reject an omitted saved-version acknowledgement. Browser integration
covers loading historical DPI, editing/saving, archive/restore, consent reset and
actual PDF download with the exact selected version.

Local checkpoint: all 267 tests across 46 files passed under actual Node 22.13.1; typechecks/build, clean packed install and full standalone browser regression passed. Browser evidence covers historical DPI restoration, save/update/archive/restore, consent reset and acknowledged actual page-only PDF download with SHA verification; no page errors. Remote CI execution is not claimed.

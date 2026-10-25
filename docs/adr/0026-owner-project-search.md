# 0026 — Owner-only federated project search

The owner workbench needs cross-project discovery of memory and research dossier
text without implicitly activating scientific workers, importing evidence into a
model context, or broadening a Scientist session's data scope.

A separate owner-authenticated GET endpoint searches only the Host's registered
canonical project paths. It opens existing SQLite metadata read-only and checks
application/schema identity; it does not create projects, acquire scientific
workers, migrate databases or invoke source resolvers. Linked/moved metadata is
rejected. Missing or incompatible sources are reported per page, without
preventing the owner from continuing to other registered sources.

Each request scans at most 50 raw rows in one project and one record type, with
one lookahead row. Memory reads reuse revision digest and scope validation;
dossier reads reuse entry/source snapshot digest validation. Returned results
contain project, record kind/identity/revision/digest/state and 500-character text
previews, never dossier evidence bodies or memory source payloads. Default search
excludes session-private notes and proposals. An explicit owner checkbox permits
those records. No Agent tool exposes this endpoint and no result is automatically
injected into an Agent context. Confirmed/reviewed states are human declarations,
not independent scientific validation; withdrawn/superseded entries retain their
states in results.

The continuation cursor binds the registered project list, exact query and
private-note choice. Registry changes require restarting the search. Cursor
values are navigation state, not authorization capabilities: every request is
owner-authenticated again. Empty pages can advance using raw row positions.
The UI keeps one page, aborts stale requests on query/scope changes, and lets the
owner switch to a source project. It searches Unicode text case-insensitively in
JavaScript; it is a federated scan, not an FTS index, relevance ranking, frozen
cross-project snapshot or current-source integrity assessment. Metadata may change
between pages. Owner access does not make arbitrary local code safe; this does
not replace OS-user isolation.

Tests use real SQLite memory and dossier records for digest/scope-preserving
search, private opt-in, source attribution, missing-project noncreation, linked
metadata rejection, raw-page progression and cursor/query/registry binding.
HTTP tests verify owner authentication, invalid input and a cold kernel after
private search. The standalone browser fixture checks the owner-facing search
and source-project action against an actual confirmed memory.

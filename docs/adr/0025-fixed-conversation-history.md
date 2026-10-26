# 0025 — Bounded fixed-conversation history

The workbench must let users inspect older conversation text while Harness
continues to own persistence, Agent creation, model execution and approvals.

The optional ScienceChat history port uses the public SessionController.page
API. Each request first verifies the durable binding's exact session identity and
workspace through a cold follow opening, then reads at a fixed inclusive
throughSeq and exclusive beforeSeq. Pages request at most 50 messages; public
text is limited to 200,000 characters, with 100,000 per message. Pagination uses
the first raw event sequence rather than the first visible message, so a page
containing only internal events can still advance. A non-advancing response is
rejected. Invalid cursors are rejected before controller dispatch, and shutdown
aborts the read. The API retains owner, project and request-origin guards.

The UI provides a separate single-page history view instead of appending all
pages to a growing live transcript. Live updates cannot move the selected
historical cut. Newest history explicitly starts a fresh cut. Project/session
changes abort outstanding requests and stale results are ignored. Only public
user/assistant text is projected; tool arguments, reasoning and injected context
are excluded. This is historical event text: replacements within one page are
applied, but cross-page replacements may retain older versions. The UI states
that limit; this feature does not claim a globally reconstructed current surface
or multimodal history.

Native tests cover cold reads without creation/prompting, boundary validation,
non-advancing cursors, private-text exclusion and disposal. HTTP tests cover
owner authentication and invalid cursor rejection before dispatch. The actual
published Harness browser fixture opens historical text after a streamed reply
and asserts that reading adds no model requests. Local synthetic-provider
coverage does not establish production-provider, Windows, Electron or remote CI
coverage.

# ADR 0024: Fixed Scientist conversation live text through Harness follow

Status: implemented for the pinned rc.3 public controller. Rich multimodal history,
full-history paging and reasoning/tool presentation are separate work.

The workbench previously polled a completed-message snapshot every 3.5 seconds.
The optional ScienceChat port now supports a live observer backed directly by
`SessionController.follow({assistantStream:true})`. It never starts another model
loop or writes a duplicate chat log. A cold read/follow creates no Agent and sends
no prompt; only the existing explicit send path creates/binds the fixed Scientist
session. Request IDs, controller deduplication, cancel semantics and shared project
memory/kernel ownership remain unchanged.

## Public projection and identity

Before returning any snapshot, the Host checks the exact bound session ID and
workspace. Further snapshot/reset frames are checked too. The projector recognizes
only declared user/assistant text messages and visible text stream chunks, including
compact reconnect text baselines. It does not forward raw frames, reasoning,
tool argument JSON, tool outputs or injected context. Surface replacements remove
the replaced messages. Live text is provisional and disappears on durable settlement
or abandonment; interrupted durable text remains explicitly labeled. Dense durable
cursor/presentation revision/index gaps close the observer so reconnect obtains an
authoritative baseline; no prompt or model request is replayed for recovery.

Projection windows are bounded to 50 visible messages, 200k transcript characters,
100k live text characters and 4096 block positions. Truncated text is labeled;
complete durable history remains Harness-owned. The bridge permits at most 32
observers. Public text is still user/model content, not automatically anonymized.
The browser renders plain text, not model-provided HTML.

## HTTP, backpressure and lifecycle

An owner-authenticated project `chat-events` GET serves full public projections as
SSE. The first controller snapshot is validated before successful SSE headers are
written. Output is coalesced at approximately 100 ms, including after drain; a
blocked reader retains only the latest pending state instead of accumulating token
frames. Heartbeats carry no private data. There is no durable SSE event ID for
cursorless partial text: every connection starts from a current controller baseline.

Window closure/iterator return aborts only that observation. It does not call
controller.cancel or stop scientific work. Explicit Stop still uses the existing
controller cancellation operation. Host bridge disposal aborts and drains its owned
iterators, including paused and unopened consumers. It does not terminate Agents
owned by the surrounding Harness. Optional-controller dependency teardown clears
the old port before waiting for observer cleanup.

The client opens a stream only for a bound session and advertised stream support.
It reconnects through EventSource, clears disconnected provisional text and retains
confirmed history. Polling is recovery/legacy behavior, with an occasional safety
refresh while live. Pending REST/SSE/send completions are fenced across project
and component generations; an old response cannot replace another project's draft
or stream. A cached snapshot cannot roll back an active newer stream projection.
No long-lived credentials are placed in a stream URL, and no new approval bypass
or automatic message retry is added.

## Evidence

Pure projection tests cover compact/live text, durable replacement, reasoning/
argument/context exclusion, truncation and cursor gaps. Native bridge tests cover
cold reads, exact identity checks including resets, unused/paused iterator cleanup
and no implicit model cancellation. Controlled backpressure tests publish 1000
updates to a blocked reader and check only the newest pending state is retained.
Actual owner/401 HTTP tests cover event headers, delivery and observer cleanup.
The isolated published Harness Web regression delays a synthetic provider response
so the browser must show partial text before a committed reply, and verifies a
mid-reply reload can reconstruct that partial baseline without another model call.
This is a local fixture/provider test, not a claim of paid production-provider,
remote CI, Windows or Electron streaming coverage.

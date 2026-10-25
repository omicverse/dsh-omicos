# ADR 0022: Harness route generation ownership and remount verification

Status: implemented for the pinned rc.3 Cordis/WebServer lifecycle tested below.
Live module-watcher replacement with active Scientist sessions and the full
Windows/Electron/remote profile matrix remain separate verification work.

## Lazy route initialization

Each `/omicos/oss` dependency scope owns one lazy promise for its HTTP handler.
The previous `handler ??= createOssHandler(await runtime, ...)` cached only the
resolved function: concurrent requests waiting on startup could each construct
a handler with a different CSRF nonce. The new owner caches initialization before
awaiting it, so pending first requests share one handler/nonce. A queued factory
that has not started is fenced if the scope closes first.

The scope closes its route owner before unregistering the prefix. New arrivals
and requests still awaiting handler initialization receive a noncacheable 503
and never enter the retired handler. Factory rejection after teardown is also
handled by that unavailable path; active startup errors retain the carrier's
normal error handling. There is no automatic retry, second Agent loop, new
credential source or fallback to weaker approval. Already-dispatched authorized
operations retain the runtime's own cancellation/receipt rules; this helper does
not claim atomic rollback of scientific/file side effects.

## Actual lifecycle evidence

A native integration test uses the published rc.3 Cordis, Loader, LLM/session
services, ToolRuntime, AgentPresetRegistry and real WebServer listener. Its
connection adapter uses actual standalone LocalOwnerAuth to exercise owner/401
HTTP behavior; that adapter is not a claim of full Harness Connection equivalence.
The separate published Harness Web browser regression tests that real connection.

The integration unloads/remounts OmicOS on the same project and state directory:

- exactly the same one-copy scientific tool roster, preset and route returns;
- the owned running Python PID is gone before unloading finishes, unfinished work
  is durably interrupted, and its delayed filesystem side effect never appears;
- another runtime's actual Python PID/namespace continues, and a separately registered Host route remains;
- completed receipt identity, project memory and saved publication preferences
  survive; replaying a completed operation ID does not start a new worker;
- a new plugin generation starts cold; no arbitrary Python namespace is claimed
  to survive a full unload, and no interrupted operation automatically replays;
- replacing only WebServer removes its old SSE listener and remounts the route,
  while the scientific runtime, worker PID, variables and tool roster persist;
- controlled startup delay verifies unload awaits initialization/cleanup before
  a fresh mount may acquire project ownership. This tests a delayed real runtime,
  not an assertion that every external filesystem failure mode is reproduced.

Independent real-HTTP tests synchronize eight requests before releasing startup
and assert a single factory call; a teardown during pending startup yields 503
without a handler dispatch. Build artifacts are not concurrently rewritten by
the new lifecycle test. Existing active-Agent MCP transport cleanup tests remain
separate; no broad live-session/module-watcher guarantee is inferred from them.

Local checkpoint: all 271 tests across 48 files passed under actual Node 22.13.1; typechecks/build and clean packed installation passed. The isolated published full Harness rc.3 browser profile also passed real owner/approval, actual Python and scoped MCP calls, conversation reload and entry/popup checks without page errors. This does not claim remote CI or an active-session module-watcher reload.

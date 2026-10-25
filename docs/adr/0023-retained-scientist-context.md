# ADR 0023: Retained Scientist scopes follow the current Host provider

Status: implemented for the retained preset/scoped-Agent lifecycle below. A full
module-watcher upgrade during live model streaming remains separate verification.

The rc.3 preset registry retains a retired preset generation while an Agent is
still bound to it. Removing/re-registering the OmicOS Host therefore does not
necessarily create a new Agent or emit `agent/created` again. Native reproduction
showed that the retained Scientist could read current memory after remount, but
its old MCP bridge had been disposed and no new MCP tools appeared.

Scientist now prepares its concrete Agent's MCP context both at creation and
before prompt assembly using the currently injected `omicosScience` provider.
The bridge reuses one attachment per Agent and consults current project config
and Host-owned grants; it never copies an old enable decision or credential value.
It waits for the initial public Harness MCP plugin projection to settle, retaining
failed connection diagnostics rather than treating registration as transport-health
or authorization proof. Repeated preparation does not start another instance.

Harness collects prompt tools and sections before the `system-prompt/assemble`
waterfall. Merely registering tools inside that waterfall is too late for the
already-collected model request. When preparation changes/initializes the MCP
projection (including a new Host identity or connection revision/phase), Scientist asks the public SystemPrompt service to assemble again with
the same context. A per-context weak guard permits one refresh, avoids recursive
preparation, and lets the authoritative registry/filter/order/instruction logic
run normally. It does not hand-build tool schemas or bypass policy. Memory is
added once, remains literal untrusted context, and comes from the current project
service. Cold transcript/context reads without a concrete Agent context do not
start MCP connections. While the Host provider is absent, a retained live Scientist
context explicitly fails before a new model request can continue with missing
scientific tools/memory; it does not silently fall back to another persona.

Context cancellation stops waiting promptly. It does not claim to revoke an
already authorized Agent-owned server; Agent/Host teardown still stops that
transport through its existing lifecycle. Agent creation rollback owns its scope
if creation itself is canceled. Every actual managed MCP call still checks the
current record/grant and requires Harness approval. Explicit disable/revoke remains
in force after another Host remount, including for the retained Agent.

Native evidence uses the actual published rc.3 Cordis Loader, preset registry,
Scope/SystemPrompt/ToolRuntime and MCP plugin, with a scoped Agent identity/event
carrier and an actual stdio JSON-RPC fixture. The test mounts through the official
preset binding API, retains that binding across Host replacement and inspects the
returned prompt's actual tool schema and server instructions, not just a later UI
registry. It verifies current memory once, old process exit, a new single live
transport, unchanged approval requirements, no duplicate connection on another
assembly, no global persona/memory/MCP leakage, and disabled grants across a
further remount. Protocol discovery may use multiple transient probe processes;
that is not counted as duplicate live Agent connections.

A separate delayed-negotiation fixture verifies canceled context preparation,
continued Agent ownership, successful later preparation without another instance,
and actual process exit on teardown. A resources-only fixture also verifies refreshed instructions even when no new mcp__ tool name appears, and preserves approval for resource reads. This does not replace full live-model/module-
watcher, Electron, Windows or remote-profile tests. Public Harness controller/model
and approval behavior retain their separate isolated browser regression.

Local checkpoint: all 273 tests across 48 files passed under actual Node 22.13.1; typechecks/build, clean packed installation and the isolated published full Harness Web profile also passed. Browser checks retain real owner authentication, explicit approval, Python execution, scoped stdio MCP calls, conversation reload and no page errors. Remote CI and mid-stream module-watcher replacement are not inferred.

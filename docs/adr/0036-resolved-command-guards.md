# 0036 — Guard resolved commands through the native command owner

Date: 2026-10-25
Status: implemented and verified in the shared-Host browser; physical foreground acceptance pending

Pointer capture cannot veto Electron menu/keyboard IPC. The pinned public derivative
adds optional `shortcuts.guardCommands`: a synchronous, disposable veto after the
command owner resolves an action as handled. It does not change bindings, native
focus/ownership checks or command execution. Canceled keyboard actions remain
consumed. Blocked/pass/repeated input does not prompt, and a thrown guard prevents
the action. Each registration disposes independently.

OmicOS registers through the public service when available. Session creation checks
visible main editors. Sidebar close/refresh resolves the current Session/tab through
the native sidebar controller. Desktop window fallback collects retained editors too;
modal closing remains native. Only dirty-editor labels are collected, never text or
MCP credentials. Earlier published engines without the optional method keep their
pointer guard and are not claimed to provide this new keyboard coverage.

Evidence: 115 focused shortcut tests include the service's real adapter/registry path
fed by a controlled Desktop preload fixture, keyboard/menu vetoes, release, exceptions
and unavailable/repeated commands. The full GUI check passed 10,902 tests before the
additional service case; source artifacts and aggregate checks passed. After installing
the exact missing Chromium revision, nine shortcut Web replay scenarios passed.
The initial full Web replay had widespread browser-launch failures; the full suite has
not been rerun and is not claimed green.

Actual Electron again passed all eight pages after waiting for successful Session API
connections and feature controls, rather than only panel headers. Foreground native
input acceptance is not yet proven: the current macOS session reports locked and the
native focus check correctly refuses input. The driver checks focus before editing,
uses controlled discard choices only while testing and restores the original confirm
function in cleanup. It never disables native focus protection or installs a model or
account fixture in the user preview.

The real Harness root served by the already-running native Host also passed actual
browser keyboard cancel/accept for main-editor navigation and scoped sidebar closure.
It used the registered Scientist preset, no API/model/account fixture, zero memory
proposal writes and no page errors. This is the same Host/scientific runtime, not a
second app server. It proves OmicOS guard registration and dirty-editor wiring in the
assembled application while leaving physical native foreground acceptance explicit.

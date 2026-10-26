# 0033 — OmicOS is the Harness application shell

Date: 2026-10-25
Status: implemented first application milestone; full application audit pending

## Context

The user clarified that the deliverable is the Harness application turned into
OmicOS, rather than a standalone scientific dashboard linked from a plugin tab.
Existing OSS scientific services and cloud commerce should remain available.
Native sessions, models, Agent loops, approvals and plugins must remain intact.

## Decision

Use the pinned public Harness application and its application-level composition
contracts. OmicOS contributes the function rail, brand, welcome/product languages,
document title, theme tokens, native scientific main panels and dockable scientific
tab types. The native frame, workspace/session browser, conversations, credential
settings, approvals and plugin system remain the runtime owners. No second model
loop, fake data source, iframe or screenshot facsimile replaces those components.

The rail is mounted through the additive shell-overlay seat, marks its actual frame
ancestor and reserves real frame width. It does not target hashed class names or
assume that sessions live in a global browser array. The marker and stylesheet are
lifecycle-owned and removed on unload. Main panel selection uses the public layout
controller; scientific tabs use the public right-sidebar registry and Session identity.

Product language packs have distinct BCP47-style IDs with official zh/en fallbacks;
they do not overwrite another plugin's dictionary namespace/locale pair. The owned
application profile chooses an OmicOS language; installing the plugin alone does not
silently rewrite an existing locale preference. Provider-specific DeepSeek account
identity remains accurate and distinct from OmicOS cloud subscriptions.

The app launcher starts the real published engine, isolates its home/agent settings,
keeps the user profile patch intact and writes only its generated overlay. Workspace
is the process cwd used for initial state, not a fixed override of every Session.
The app deployment defaults to the registered OmicOS Scientist; the registry's saved
user selection has normal precedence. A profile lease prevents concurrent launch
from mutating the currently running profile.

Notebook editing gets browser-tab temporary drafts because main-panel navigation
unmounts native keyed pages. Recovery is explicit, never execution or silent project
save. Existing server revision checks remain authoritative. Retained right-sidebar
scientific tabs pause their streams and polling when hidden.

## Verification and limits

Actual Chrome checks cover the keyless, unmocked root app; eight native panels;
conversation round-trip; product title/default Scientist; light/dark switching and
narrow viewport overflow. The isolated full Harness scientific fixture verifies real
Python/R Notebook execution, native approval before side effects, scoped MCP,
Scientist streaming/memory, draft recovery, the native memory side tab and the
legacy Core console. Synthetic model traffic is restricted to that disposable test,
never the user preview. Duplicate app launch was rejected before overlay mutation.

This is not a claim of private Core feature parity, real payment/provider acceptance,
or a packaged Electron release. Compact/mobile session navigation, other editors'
draft lifetimes, native window chrome, fuller scientific main-panel workflows and the
final application fidelity audit remain tracked in implementation status.

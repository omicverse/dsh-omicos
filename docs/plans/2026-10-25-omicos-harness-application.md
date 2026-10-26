# OmicOS Harness Application Implementation Plan

> Execution: implement in this working tree, with user authorization to proceed continuously.

**Goal:** Turn the running Harness application into OmicOS OSS, using the existing OmicOS visual language and navigation, while retaining native conversation, agent, approval and plugin behavior.

**Architecture:** Compose the actual Harness client through its published application slots; existing local Python/R and scientific project services remain the Host backend. Scientific pages become native main panels and conversation-side views, not links to a separate dashboard. A reproducible OmicOS profile starts the full application; no private Core source is copied.

**Tech Stack:** Harness 0.2.1-rc.3, Cordis, React 18, TypeScript, existing OSS HTTP/SSE services, Playwright.

## 1. Application shell
- `src/client/OmicosShell.tsx`, `src/client/omicos-shell.css`: native brand, welcome, scientific navigation, sage light/charcoal dark application tokens.
- `esbuild.client.mjs`: bundle CSS as explicit disposable application styles, preserve platform React identity.
- Retain native sessions, model selector, streaming, approval, settings, plugin management, keyboard shortcuts and responsive layout.

## 2. Scientific main panels
- `src/client/OmicosPanel.tsx`: project-aware Data, Notebook, Figures, Memory, Pipelines, Methods/Evidence, Runtime, cloud Store; request only the selected surface.
- `src/client/OssEntry.tsx`: replace external-workbench link with embedded project tools in the conversation.
- Keep project identity visible, session-project binding authoritative, account generation/CSRF checks unchanged; no automatic execution/download/purchase.
- Preserve unsaved editing across panel switches or explicitly guard navigation.

## 3. Full application preview
- Add a repeatable `scripts/launch-harness-preview.cjs` that installs this local plugin into a dedicated Harness profile and starts the real application on loopback.
- No simulated model or cloud account in user preview; absent provider configuration is visible and configurable through Harness settings.
- Open the actual Harness root application in Codex, rather than `/omicos/oss`.

## 4. Verification
- `pnpm typecheck`, `pnpm build`.
- Real Harness browser smoke: brand/welcome, navigation round trip, data import, Notebook, Memory, Figures, Pipelines, methods, runtime and Store, session navigation, plugin/settings access, no browser errors.
- Existing scientific Harness smoke validates native approval, streamed Agent conversation, fixed project session, memory filtering and MCP approval.
- Inspect rendered desktop and narrow screenshots; preserve dark theme and all original data protections.

## 5. Completion audit
- Match the running UI against OmicOS reference structure and palette, not merely passing registration tests.
- Verify sessions/dialogue/scientific side panel and subscription commerce each work in the main app.
- Record limitations and remaining work. Keep goal active if any objective requirement is missing.

## 6. Follow-up verified interactions (2026-10-25)
- Application defaults must be a bundle below the native user patch, not a read-only CLI override. Validate locale/default-Agent writes and full application restart with `node scripts/application-preferences-smoke.cjs`; no fake provider, no execution.
- Native Language row shadows the built-in row by priority and keeps registered third-party languages. Product variants retain OmicOS copy.
- Compact screens retain the native workspace rail and move OmicOS pages to a labeled bottom bar. Check real frame bounds and horizontal navigation, not just document overflow.
- Eight editor dirty states participate in one scope-aware pointer-navigation guard. Preserve existing Pipeline touched semantics. Test cancel/accept for multiple editors, main-memory navigation and an actual docked scientific tab close.
- Remaining: keyboard/programmatic navigation, floating/context-menu close paths, fuller native scientific journeys and actual Electron window/packaging verification.

## 7. Native close coverage
- Scope dirty tab collection by native Session and tab IDs. Track the actual context-menu origin, including inactive tabs; float close resolves its own native title/body marker. Keep native close handlers authoritative.
- Verify cancellation retains text and acceptance closes the actual tab in a running Harness. Native keyboard and programmatic transitions remain a separate unresolved surface.
- Build the pinned public Harness desktop source through its prescribed build and development launcher; retain Electron host and native bridge.

## 8. Actual native preview
- Pinned public source build:artifacts and build:check passed; Electron 44.7.0 and the official locked Office runtime are prepared.
- Use the official start:desktop launcher with isolated home/user data. Desktop profiles are Electron-owned: install OmicOS and the printed defaults bundle through the native Plugins page, never by bypassing CLI ownership checks.
- Actual native dsh-app renderer and macOS preload passed eight scientific panels, conversation return, title/no-iframe/error checks; screenshot inspected.
- Pending: native welcome/menu/Dock branding, keyboard/programmatic draft safety, actual scientific execution under Electron and final packaging/fidelity audit.

## 9. Native product identity
- Ship a pinned, digest-checked MIT source patch and license; never replace native bridges with a web wrapper. Verify clean-clone application, idempotence and conflicts without partial changes.
- Rebrand welcome artwork/palette, application/menu copy and development bundle identity. Preserve explicit product locale choice in the native shell.
- Add direct local entry through the existing isolated skip operation; retain provider-specific DeepSeek connection actions. Test pending-action exclusion, visible failure and no credential/sign-in side effects.
- Verify actual Electron welcome, local entry, application identity and menu before rerunning eight native scientific pages.

## 10. Native resolved-command guards
- Add an optional, disposable guard registration to the pinned source command service. Evaluate guards only after owner resolution; consume canceled keyboard input, leave pass/blocked/repeat inputs inert and preserve all binding/menu behavior.
- Register editor checks through this interface when available. Main session creation collects main edits; sidebar close resolves the current Session/tab; window fallback includes retained editors. Modal-close actions remain native.
- Published engines without the optional interface retain their existing pointer guard; the native derivative is the application verification target.
- Verify real native input through Electron's input API and its actual keyboard bridge, with cancel/accept for main navigation and scoped tab closure. Run focused registry/service tests, required GUI checks and the source build checks.

## 11. Current acceptance evidence and next audit
- Source GUI: 652 files / 10,902 tests passed before the final service case; final focused shortcut suite: 115 tests passed. Source artifacts/aggregate checks and OmicOS typecheck/build/client tests passed.
- Initial full Web replay could not launch its missing Chromium. Installed exact Chromium 1228; nine relevant Web shortcut replay cases now pass. The full replay suite is not claimed green.
- Actual native main pages now wait for successful Session requests and concrete feature controls; all eight pass.
- Same native Host, real browser frontend: Scientist selector, actual keyboard main navigation and scoped tab-close cancel/accept pass with zero memory proposals, no model/account fixture and no page errors. Physical native input is still gated by the locked macOS session; do not bypass focus protection.
- Next: align default scientific main-page project selection with the selected native Session; audit remaining programmatic navigation and the complete goal against current artifacts.

## 12. Main scientific pages follow the current Session

The main slot now consumes the public native Session list and resolves the Session
retained by `mainView`. Its editor subtree is keyed by Session identity. Scientific
pages use the existing authoritative Session-to-project endpoint, show a pending
placeholder instead of selecting the first registry entry, and preserve an explicit
manual choice made before the binding response returns. Session-bound sidebars keep
their fixed scope; main pages retain their visible project selector.

Validation: root typecheck/build and three client-bundle/Harness tests pass. The
actual native application passes all eight page checks with no renderer errors.
`test:shared-host-project` uses the running native Host's complete browser frontend
and its real Session/project responses; it checks the selected Session workspace,
manual selection, a second page's default, and an explicit selection surviving a
delayed real binding response. It does not start another scientific
runtime or create model/account fixtures. Different-workspace Session switching is now verified below; the final full
visual/workflow audit remains open.


## 13. Cross-workspace Session identity acceptance

`pnpm test:shared-host-session-scope` registers an existing isolated test directory
through the public Harness Workspace RPC, then uses the actual conversation
workspace picker to select the default workspace and the fixture workspace. It
observes two distinct native Session IDs in authoritative project-binding requests,
checks both main-page paths, returns to the conversation and opens the native
Memory sidebar. The sidebar shows the fixture Session CWD and has no independent
project selector. No model calls, synthetic account or second runtime are used.
The test returns the conversation to the default workspace afterward.

Result: passed with two distinct Sessions, matching sidebar scope, and zero
renderer errors (`test-results/shared-host-session-scope.log`). The rendered
conversation/sidebar was inspected in `workspace-session-scope.png`.

Visual follow-up: the actual macOS frame retains an upstream blue/violet wash in
the workspace column. The browser frontend uses the sage palette, but native
visual acceptance still needs this frame detail corrected.


## 14. Native workspace palette

The owned rail effect tags the actual workspace column in the pinned Harness
frame and restores its prior attribute on disposal. A scoped product style paints
that column using the current OmicOS surface token, overriding macOS's upstream
blue/violet vibrancy wash without changing native workspace/session owners or
editing hashed upstream CSS classes. The opaque fill also remains appropriate
when Reduce Transparency is enabled.

Verification: typecheck/build and three client bundle/Harness tests pass. The
native application smoke passes eight functional pages and toggles both themes
through the real appearance control. It asserts `background-image: none` and
computed backgrounds `rgb(238, 244, 241)` / `rgb(37, 40, 36)`, captures settled
light/dark screenshots, and restores the original appearance. Both native images
were inspected; no renderer errors occurred. Evidence:
`test-results/workspace-palette-native.log`, `omicos-native-light.png`, and
`omicos-native-dark.png`.


## 15. Real data-to-Notebook-to-memory workflow

`pnpm test:shared-host-data-notebook` uses the complete frontend of the existing
native Host and an isolated fixture workspace registered through its public RPC.
The browser approves import of a fresh 28-byte CSV, waits for the completed upload
receipt, previews its exact contents and prepares the real file-loading code.
It verifies that these steps send no Notebook execution requests. It then creates
a Notebook, transfers that prepared code through the editor and explicitly clicks
the save-and-approve cell action. The real persistent Python kernel returns the
CSV sum 42. The test matches the returned Notebook and execution identities/code,
asserts exactly one confirmed run, navigates away and reopens the saved Notebook
to verify persistence of the output.

It next saves a memory proposal citing that exact local execution ID, verifies
the Host pins it as a `local-receipt`, explicitly confirms the version, and checks
the returned memory view is effective. Synthetic acceptance text is clearly
labeled as a software fixture. The test uses no synthetic model, account, Agent
loop, direct database setup, or second scientific runtime, and returns to the
default conversation workspace afterward.

The current interaction is manual copy of prepared code into Notebook; the
interface states that explicitly. One-click code handoff is a possible usability
improvement, not a behavior this test invents or claims exists. Evidence lives in
`test-results/application-data-notebook.log`, `application-data-notebook.png`, and
`application-confirmed-memory.png`.


## 16. Method publication and gated Pipeline

`test:shared-host-method-pipeline` operates the full native-Host browser frontend.
It imports fresh synthetic method text as a draft, publishes it through explicit
owner review, retrieves the exact content-hash Pipeline reference, and saves a
two-stage Python definition with that reference unchanged. The approved run uses
the existing independent Pipeline kernel, prints the prepared value 40 and enters
`waiting` at the manual gate. The result marker is absent at this point. Only
clicking the explicit stage-continuation action permits the second stage, which
prints 42 and reaches `succeeded`. Native method, definition and run IDs are checked.
No model/account fixture or second scientific runtime is involved; the test returns
to the default conversation workspace afterward.

Result: passed with no renderer errors. Evidence:
`test-results/application-method-pipeline.log` and
`application-method-pipeline.png`.


## 17. Real Notebook figure archive and review

`test:shared-host-figure` runs an explicitly approved Matplotlib cell in the actual
persistent kernel. It polls the public execution-receipt endpoint to a terminal
state, checks the exact code and successful execution, then chooses the returned
PNG artifact in Figure Studio. Saving a figure preserves that execution identity
and the source artifact hash. The test waits for the application's integrity
verification, decodes the displayed PNG, downloads the original via the actual
figure link and compares its SHA-256 with the execution receipt. Explicit review
requires the saved-source checkbox and review note; the resulting version is
`approved` and is rendered before the proof screenshot.

Result: passed; observed execution states `running`→`succeeded`, the downloaded
PNG digest matched the source, and no renderer errors occurred. Evidence:
`test-results/application-figure.log` and `application-approved-figure.png` (visually
inspected). No fake model/account or second runtime was used. The early HTTP
Notebook response can be queued/running; it is not used as proof of completion.


## 18. Plan acceptance and four-source Dossier

`test:shared-host-plan-dossier` follows `test:shared-host-figure` and explicitly
requires its successful receipt log plus the corresponding real project records.
It creates and saves a synthetic research plan, approves the fixed version, and
records a completed assessment using the actual plotting execution. The recorded
evidence must contain the exact execution ID and PNG digest.

The method/evidence main page then captures a Dossier with four sources: that
execution, its saved Notebook, the approved figure and the accepted plan. The
returned source pins must match the requested identities. Explicit owner review
checks all four current sources and produces a reviewed revision. Downloading the
actual export link returns `omicos.dossier/1` with the exact reviewed digest.
The test returns to the default conversation workspace without executing more code.

Result: passed with four pinned/rechecked sources and zero renderer errors.
`test-results/application-plan-dossier.log` records identities/digest and
`application-reviewed-dossier.png` was visually inspected. This verifies owner
assessment and historical evidence capture; synthetic fixtures make no scientific
claims.

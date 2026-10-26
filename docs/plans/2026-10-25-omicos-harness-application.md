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
runtime or create model/account fixtures. Different-workspace Session switching and
the final full visual/workflow audit remain open acceptance items.

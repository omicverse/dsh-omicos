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

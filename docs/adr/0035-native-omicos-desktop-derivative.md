# 0035 — Native OmicOS product identity over the public Harness desktop

Date: 2026-10-25
Status: implemented and verified in the native macOS preview

The native welcome renderer and system menus live outside plugin slots. A browser
shell cannot rebrand these or replace Electron's native bridge. Carry an explicit
MIT source patch against one public Harness commit, with the upstream license and
a checksum manifest. Applying the patch never resets source changes; an actual clean
clone verifies initial application, idempotence and conflict rejection without partial
writes. The application launcher requires this derivative before using the official
source desktop launcher.

The derivative changes only product identity, welcome artwork/palette, direct local
entry and explicit product-language recognition. The existing welcome skip API opens
the workspace without credentials. Its pending operation disables competing actions;
a failure stays visible and can be retried. DeepSeek model-account and API-key actions
remain provider-specific. Native Host/IPC, sessions, Agent commands, plugin management
and approval implementations retain their original owners.

Application identity is set before Electron resolves its log paths. The preview keeps
its explicit private user-data/home paths; its existing state does not move. The macOS
development bundle has a separate OmicOS name and identifier. Packaging and update
feeds are not a completed release claim; the native derivative README owns migration
and outstanding distribution details.

Focused native welcome/locale/menu/startup/tray/quit/recovery tests and their owned
text snapshots cover the changed visible behavior. Actual Electron verification must
also inspect the welcome page, local-entry action, process application name and
localized system menu, followed by the eight scientific pages and native conversation.

The rebuilt native preview verified Chinese welcome/local entry, actual process name,
About/Quit menu labels and eight in-app pages. Real Python 42 and R mean 4 runs passed
the native custom-scheme Notebook save/approval/output path, with new Notebook and
execution IDs checked separately from output text. No model key or account was supplied.

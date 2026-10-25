# 0034 — Editable application defaults and scoped editor navigation

Date: 2026-10-25
Status: implemented for the verified interaction paths; wider lifecycle audit remains open

The initial application launcher placed language and default-Agent configuration in
its CLI overlay. Harness settings writes target the user profile patch, and its
configuration editor refuses writes overridden by CLI/home overlays. Displaying a
native settings page was therefore insufficient proof that those settings worked.

The launcher now installs a private, generated defaults bundle after the web/product
bundles and before the user profile patch. Only owned scientific-runtime launch options
remain in the CLI overlay. Native language and Agent settings can persist normally.
The application profile lease covers bundle creation/installation as well as overlay
writes. Requested signals stop the child and release that lease without reporting a
spurious application failure. A disposable real Harness test changes the language and
default Agent, fully stops/restarts the app and verifies both authoritative native
settings, clean shutdown and a cold scientific runtime.

The Language row uses a lower registration priority at the existing native row ID.
It offers product zh/en variants, avoids duplicate generic choices and retains other
registered languages. It does not replace the locale service, mutate another owner's
namespace or remove base dictionaries needed for language fallback.

Scientific navigation becomes a labeled, horizontally scrollable bottom bar below
700px. The frame reserves its actual safe-area-aware height; the original workspace
rail and native layout solver remain intact. Native window-chrome rail insets apply
only to the wider vertical layout. Chrome verifies actual geometry, off-screen button
navigation, no document overflow and the rendered page.

A small editor hook contributes dirty-editor labels to a local, synchronous collection.
No field values, proposal text or MCP configuration are serialized. Main navigation
excludes retained right-sidebar editors; project changes collect only their own pane;
native docked, floating and context-menu close actions collect that exact Session and
sidebar tab, including retained hidden bodies. The portaled menu retains its origin tab. One ordinary discard reminder covers multiple affected editors. Existing
Notebook tab drafts remain independent. Pipeline's untouched example is not a user edit.
The existing server revision/approval/execution mechanisms are unchanged.

The native browser tests exercise canceled and accepted main-memory navigation,
combined Plan/Pipeline edits and a real scientific sidebar close. The guard currently
covers pointer navigation, project selection and docked/floating/context-menu close.
Real browser gestures verify menu cancellation and float cancellation/acceptance preserve
the target editor until the user accepts. Keyboard or programmatic transitions require further work;
this ADR does not claim complete editor-lifecycle coverage or an Electron release.

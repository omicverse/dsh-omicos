# OmicOS OSS native derivative

`harness-source.json` pins the public MIT Harness revision and a reviewable patch.
`UPSTREAM_LICENSE` preserves DeepSeek's copyright and permission notice. The patch
contains independently authored OmicOS branding and local-entry changes; no private
OmicOS Core implementation is included.

From this package, apply the patch before building the source:

```sh
pnpm prepare:desktop-source --source /absolute/path/to/deepseek-harness
```

The command checks the base revision and patch digest, is idempotent, and rejects
conflicting edits without resetting the checkout. Build that source through its
`build:artifacts` and `build:check` scripts, then follow the native preview instructions
in the root README. The launcher requires the patch to be present.

The native welcome artwork, English/Chinese copy, application name, macOS development
bundle identity and localized menu identify OmicOS OSS. Product locale IDs explicitly
select English or Chinese regardless of OS language. The welcome page opens the
local workspace through the existing isolated `skip` operation; it does not store
credentials or start sign-in. DeepSeek account/API-key buttons still identify their
actual provider. Native Agent/session/plugin/approval and IPC implementations remain
owned by Harness.

## Preview migration

The OmicOS launcher keeps the same explicit private Harness home and Electron user-data
directory used by the earlier preview, so current preview sessions and settings remain
in place. Its new macOS development bundle is `OmicOS OSS Dev.app`; start it with
`pnpm start:desktop-preview`. Ordinary source launches without these explicit paths
use the new application identity for Electron's defaults; they do not import another
product's user-data directory. The internal `dsh` protocol is retained for engine
compatibility. No session format or credential schema is changed.

This is a native development derivative, not a signed release. Installer/update
configuration, native Dock artwork, complete programmatic draft lifecycle and
the final application audit remain pending. Resolved-command guards are implemented;
physical native input acceptance still needs an unlocked, focused desktop. Native Python/R Notebook execution has
passed actual approved runs; no model/account fixtures are installed in the preview.

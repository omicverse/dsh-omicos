# 0031 — Owner-approved base Python runtime bootstrap

The Node workbench must open without a working Python. Base distribution management
therefore belongs to the Host state directory, independently of project scientific
kernels and project wheel environments. It exposes owner-authenticated HTTP/UI
operations, never an automatically executable Agent tool. No private Core source
or interpreter binaries enter this repository or npm package.

A schema-versioned descriptor pins CPython version, Host platform/architecture,
HTTPS source and exact redirect-origin allowlist, SHA-256, byte count, entrypoint
and upstream license reference. An absolute offline archive uses the same checks.
The initial built-in catalog pins python-build-standalone 20261021 CPython 3.12.15
for macOS arm64. Catalog display itself performs no download. Other Linux/macOS
CPython distributions must fit the documented python/ tar.gz layout and be
explicitly supplied by the owner; this is not cross-platform validation.

Downloads have no cloud authorization/cookie headers, at most five followed
redirects and an exact declared length up to 512 MiB. Private exclusive staging
records progress; mismatches never start the interpreter. A bounded Node Worker
uses tar's streaming parser, not its filesystem extractor. It rehashes compressed
bytes, bounds decompressed bytes to 2 GiB, individual files to 256 MiB, archive
entries to 20000 and all paths to 40000, and limits metadata. ASCII paths remain
inside python/, including valid dotfiles such as .empty. Traversal, case aliases,
duplicate/conflicting paths, devices/FIFOs and nested compression are rejected.
Regular files are created exclusively, owner-only. Deferred symbolic links must
resolve within python/ using actual OS symlink semantics; hardlinks are copied as
independent regular files. No archive ownership or privileged mode is restored.
The full file/link/directory inventory is hashed and checked after probing, on
selection and on startup. Worker/V8 limits are not an OS or total-memory sandbox.

Only after extraction does a watchdog-owned native process verify exact CPython
version/architecture/platform, contained executable/prefix, ssl/sqlite3/zlib,
venv and ensurepip. It has bounded output and a 30-second deadline. The complete
installation has a 30-minute deadline. Closing/canceling waits for actual worker/
process exit before cleanup is possible; fd4 lifetime supervision kills owned
native process groups if the Host dies. Unfinished receipts become interrupted;
there is no automatic download, native execution or replay on startup.

WAL/FULL SQLite receipts retain operation identity and descriptor hash. A global
process-identity lease excludes another live Host, even another manager in the
same process. Only ESRCH establishes a dead owner; an ambiguous/reused PID fails
closed. Selection uses revision CAS and exact operation replay, independently of
installation; stale operations cannot undo newer selections. History is paged.
At most 100 installation receipts are accepted. Explicit partial cleanup retains
receipts, and ready/selected distributions are not deletable by that action.

The current kernel does not switch. A saved base selection applies to a new Host
only; explicit operator Python overrides it, and project selected venvs remain
separate. A corrupt selected base keeps the workbench available but blocks Python
execution and environment creation/verification, including otherwise tempting
fallback calls to external python3. Owner rollback takes effect at the next Host
start. R remains independent. Scientific kernels using the managed base run in
isolated Python mode. Environment inventory probes now also pass -B: -I ignores
PYTHONDONTWRITEBYTECODE, and probing without -B would create new standard-library
cache files and invalidate the base distribution.

Runtime cache descendants and aliases are excluded from project browsing and
import destinations. Native code retains the user's OS permissions and trust
obligation; a hash proves the selected bytes, not benign behavior. No automatic
OS package installation, R binary installation, Windows implementation, active
kernel replacement, remote updater or distribution-signature PKI is claimed.

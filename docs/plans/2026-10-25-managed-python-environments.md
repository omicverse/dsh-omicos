# Managed Python Environments Implementation Plan

Goal: explicit project-owned Python environment provisioning, hash-locked wheel installation, progress/cancellation/recovery and reversible next-Host selection.

Architecture: project-exclusive native SQLite tracks immutable installation requests, bounded logs and terminal records. Each installation gets a permanent unique venv path, with no inherited system site packages. Existing Python supplies venv/ensurepip; the runtime never downloads or installs a base Python interpreter implicitly. A separate responsive Node supervisor owns each installer process group and kills it on Host death. Interrupted installs never resume automatically. Current kernels remain untouched; selection is applied before the next Host exposes its project service, including local Pipeline defaults.

Design alternatives: mutating the existing interpreter would destroy reproducibility and rollback; renaming a staged venv breaks absolute entry-point paths. Use unique fixed installation directories and atomically commit ready metadata after dependency/import metadata validation. Failed/partial environments remain unselectable. Rollback selects a prior ready environment or the configured external interpreter; no environment deletion or active-kernel restart is implicit.

Tasks:
1. Add validated lock input: normalized exact package/version records, SHA-256 hashes, max 200 packages. Only wheels, no source builds, URLs, options, markers or arbitrary indexes; default PyPI or explicit project-contained offline wheel directory.
2. Implement a durable manager and supervisor: create venv, pip install with require-hashes/only-binary, pip check, enumerate installed distributions and hash the installed-file manifest. Track 64000-character log tail, stages, stable request IDs, cancellation, restart interruption and per-project one installer.
3. Implement explicit next-Host selection with revision CAS and an audit history; revalidate environment manifest before selecting and at startup. Never silently fall back if selected environment is missing/tampered. Preserve external interpreter fallback as an explicit rollback choice.
4. Wire owner/CSRF workbench HTTP and read-only Agent discovery. Agent tools cannot install/select environments. UI shows current interpreter separately from next-start selection and requires explicit install/selection actions.
5. Validate with actual offline wheels and isolated Python, bad hashes/dependencies, cancellation/Host shutdown, restart selection/rollback and no repeated installation on request retry. Extend Chrome with real base venv creation and selection while the current kernel retains its objects. Typecheck/native baseline/build/package.

Bounds: POSIX verified first; Windows/Electron, base interpreter/runtime-binary download, R provisioning and public multi-platform lock catalogs remain explicit follow-up work. Hashes pin package bytes, not scientific validity or publisher trust. Trusted Python packages can execute as the user, including import hooks; this is not a sandbox.

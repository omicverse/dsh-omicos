# OmicOS OSS for DeepSeek Harness

An open scientific workspace: a persistent local Python process, execution records,
reproducible notebooks, figures with integrity hashes, sourced project memory,
and an optional official OmicOS cloud subscription store.

**Development preview (0.3.0).** This branch implements the first scientific and
commerce vertical slice. It does not yet provide all OmicOS Core capabilities.
See [implementation status](IMPLEMENTATION_STATUS.md) and the
[complete migration design](OMICOS_OSS_DESIGN.md). No private Core binary is
required by the OSS backend; the old Core adapter remains opt-in.

## Run the standalone workspace

Requirements: Node.js 22.13+ or Node.js 24+, pnpm, and Python 3 available as `python3`. Optional R cells require Rscript and jsonlite.
Scientific packages are optional and must be installed in your chosen environment.
The runtime does **not** silently install dependencies, upload data or replay cells.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start:oss --workspace /absolute/path/to/research-project
```

Open `http://127.0.0.1:18620/omicos/oss`. The store has its own window at
`http://127.0.0.1:18620/omicos/oss/store`.

Other flags: `--python /path/to/venv/bin/python`, `--port 18620`,
`--rscript /path/to/Rscript`, `--state-dir /private/state/directory`, and `--cloud-base https://auth.omicos.cn`.
The service binds only to loopback; exposing it as a public server is unsupported.

The standalone CLI runs explicit Python cells without Harness. When this same
workspace is opened from the DSH OmicOS entry, it also provides Agent chat through
the existing Harness session controller. Each project keeps one fixed Scientist
session; no second LLM loop is started. Without a Harness connection, the chat
panel explains how to connect and local Python remains available. Tool approval
is currently completed in the Harness main window.

## Install in Harness

The baseline is the official `dsh-v0.2.1-rc.3` release, Cordis 4.0.5, and
Schemastery 3.18.5. The obsolete `dsh-client-runtime` dependency is removed.
Build this checkout, then add its absolute path to your web profile:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-omicos
```

The OmicOS conversation tab opens the independent workspace and store. Scientific
tools use the calling session's workspace; an explicit config workspace takes
precedence. An initial project also follows the Host working directory.

```yaml
- id: omicos
  config:
    backend: oss
    workspace: /absolute/path/to/research-project
    python: /absolute/path/to/venv/bin/python
    upstreamBaseUrl: https://auth.omicos.cn
```

The web profile also gains an **OmicOS Scientist** Agent preset. Select it for
scientific conversations; other presets do not inherit its persona. It shares
the same Host model loop and project kernels.

The OSS tool surface is:

- `omicos_science_context`: variables, recent scientific executions and project memory.
- `omicos_run_python`: approved Python execution, optionally asynchronous.
- `omicos_run_r`: approved persistent R execution with PDF/PNG capture.
- `omicos_execution_status`: actual execution state and bounded output.
- `omicos_cancel_execution`: request cancellation, then query the terminal state.
- `omicos_project_memory_write`: approved changes to sourced project facts.
- `omicos_workspace_files`: bounded project data inventory with private-path protection.
- `omicos_inspect_anndata`: approved metadata-only audit without changing expression values.
- `omicos_scientific_skill`: public AnnData/QC/differential-expression/figure checklists.
- `omicos_environment`: interpreter and installed scientific package metadata.
- `omicos_cloud_store`: cloud account and store/workspace entry points; no payment tool.

Python and memory-write tools use Harness's pre-execution approval mechanism.
Without an approval service/channel they fail closed. Other tool-policy denials
are preserved. Python runs with your operating-system permissions; this is a
trusted research environment, **not a Python security sandbox**.

## Scientific state and recovery

One project owns one Python namespace and an optional separate R namespace, shared by their cells and bound sessions.
Each project has a single execution queue. Different projects use separate
workers. A project lock prevents competing runtime processes from corrupting its
metadata; close the original runtime before opening the same project elsewhere.

- `.omicos-oss/project.sqlite`: transactional executions, bounded stdout, sourced memory and sequenced scientific receipts (SQLite WAL).
- `.omicos-oss/artifacts/`: generated figures, recorded with SHA-256 and byte size.
- Existing `executions.json` / `memories.json`: retained as migration backups; imported once and never used to overwrite newer database records.
- `.omicos-oss/runtime.lock/`: process ownership and heartbeat, not project data.

Use stable operation IDs when retrying a request. Reusing an ID with different
code/session is rejected. Host restarts preserve history, artifacts and memory,
**not live Python objects**. Unfinished executions become `interrupted`, never
silently rerun. A failed/canceled cell can leave partial variable or file changes.
R history and variables are separate from Python; both languages use the project ledger. The interface makes this distinction explicit. Notebook export preserves source,
outputs, execution identity, kernel generation and artifact references.

Figures created with matplotlib are saved after successful cells; R graphics are captured as PDF with a PNG preview when supported. Figures are displayed
in the workspace. The file endpoint checks workspace containment and integrity.
No object pickle is automatically loaded on restart.

The data browser previews bounded text and prepares CSV/TSV/H5AD/RDS loading code
for review; it does not execute or deserialize a dataset just because it is selected.
AnnData inspection reports layers, raw/embedding metadata and uniqueness, leaving
normalization/log state explicitly unknown unless supported by separate evidence.

Project references persist in the Host state directory and reopen lazily after a restart.
Deleted/moved projects are not recreated by addressing an old project ID.
The workspace follows durable scientific events over SSE and resumes after the last
committed event ID, with polling as a recovery path. Host restart refreshes the
CSRF nonce only after an explicit pre-dispatch rejection; unknown execution or
checkout outcomes are never automatically retried.

Each execution also records its actual interpreter/package versions and a kernel
environment fingerprint; it does not dump process environment variables or keys.

The ledger uses the [Node SQLite API](https://nodejs.org/api/sqlite.html). Its
receipts establish execution/code/artifact identity, not full I/O provenance or
scientific validity.

## Official cloud store

Local work does not require an OmicOS account. The store supports device-code
login, live server catalog prices, monthly/quarterly/yearly selection, order
confirmation, WeChat/Alipay QR, order polling/recovery, current subscription,
and cancel/restore subscription management. Unsupported sales-only combinations
are disabled or rejected by the server. The store also provides paid-order records,
order-bound invoice applications/withdrawals, live lab seat pricing and owner-only
seat changes. Seat expansion orders use the same payment panel. Advanced cloud
resource/usage management remains in the migration queue.

Credentials stay in the Host's private state directory (`~/.omicos-oss/cloud.json`
by default), in an owner-readable file. They are not put in browser storage,
URLs or Agent responses. This preview uses a private credential file rather
than an OS keychain. Device approval happens in the official browser page; the
workspace never requests passwords or SMS codes.

Only official server order status activates the displayed cloud entitlement.
The client does not call payment webhooks, support mock payment activation, or
restart charged analysis after purchase. Closing an order panel stops its polls,
not the cloud order itself. Account changes invalidate quotes and stale responses.
If order creation times out, do not repeatedly create or pay orders; verify order
state through the official account before retrying.

Commerce UI and protocol were exercised against an isolated mock cloud and real
browser. Production checkout, merchant callbacks and real account entitlement
renewal have **not** been validated by these tests.

## Legacy Core compatibility

Set `backend: core` to use the original delegated Core Agent tools. Install the
Core package separately if desired; it is no longer downloaded as an OSS package
dependency. The legacy adapter may attach to/start Core according to its config.
It has a separate Core-managed cloud identity; OSS login does not migrate it.
Read [legacy Core instructions](LEGACY_CORE.md) for the existing tool/command
surface. This compatibility backend is not the standalone open-source path.

## Verify

Browser and package checks are reproducible from this repository. For browser checks,
install a Playwright Chromium build (`pnpm exec playwright install chromium`) or
set `OMICOS_BROWSER_EXECUTABLE` to an existing compatible Chrome executable.
`OMICOS_SCIENCE_TEST_PYTHON` selects an environment with AnnData/pandas for the
optional full scientific checks. R checks run when Rscript/jsonlite are available.
Screenshots contain synthetic test data and go to ignored `test-results/`.


```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
pnpm test:package
```

Tests include real Python processes, project isolation and ownership, cancellation,
restart recovery, actual Harness rc.3 tool runtime/approval denial, cloud account
isolation, one-use checkout confirmations, CSRF/origin/Host checks and notebook
export. A green test suite is not evidence that every Core capability has migrated.

## License

GPL-3.0-only, retained from this plugin. Build-generated `lib/third-party-*.txt`
files include the exact license notices for inlined npm dependencies; build/test
scripts and source are included in the package. New OSS runtime code does not copy private
Core implementation files. Official cloud service availability, paid resources,
third-party data and models have their own terms; they are not included by the
plugin license. Review each proposed Core extraction before public distribution.

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

Open the full launch link printed by the command. It contains a private, per-process
owner credential that is exchanged for an HttpOnly browser cookie and removed from
the address bar. Keep this link private. The store opens from the workbench.
When hosted by Harness, both windows use its existing local owner authentication.

Normal snapshots contain the latest 100 executions, not the complete archive.
Use the history browser or `omicos_execution_history` to page earlier summaries;
exact receipt IDs, operation deduplication, original images and Notebook exports
remain available. Older Notebook cells can load their archived result explicitly.
The complete legacy Notebook download streams all cells in bounded pages, without
replaying code. See [execution history decisions](docs/adr/0009-execution-history-windows.md).

Notebook documents are stored in each project's private runtime directory. Create or
import an `.ipynb`, edit/reorder cells, save and explicitly approve individual runs.
Imports never execute. Python and R use their respective shared project kernels;
changing a cell invalidates its displayed/exported execution output. Revision
conflicts require reloading and merging, so another window's edits are not overwritten.
Imported rich outputs are retained for export with an unverified marker and are
never executed as browser HTML. The current import limit is 2 MB / 500 cells.

The AnnData explorer inspects the current Python object, then previews an existing
embedding, obs distribution or one explicitly selected X/layer/raw feature. Every
inspection/plot requires approval. Seeded uniform sampling is capped at 10000 rows;
sparse/backed reads use small row chunks and never densify the full expression
matrix. More than 20 sampled categories reject. Missing coordinates/colors and the
preview-subset hash are recorded in the execution; no normalization, logarithm,
filtering or embedding computation is implicit. See
[AnnData exploration boundaries](docs/adr/0008-bounded-anndata-exploration.md).

Figure Studio curates actual Python/R and Pipeline artifacts with versioned captions,
declared methods/data references and explicit human review. Every edit resets review
to draft; old captions and assessments remain in history. Download the original figure
and its version-specific provenance JSON. Byte size/SHA-256 are checked on every
download; a changed source is rejected and never regenerated automatically. Python
plots include PNG/PDF/SVG, R retains PNG/PDF, and Notebook cells show their actual PNG
outputs. Vector files are downloads, not executable inline documents. See
[Figure Studio architecture](docs/adr/0005-figure-studio.md).

Scientific plans now retain a pinned objective, ordered steps, inputs/outputs,
method references, risks and acceptance criteria. The Agent can read/propose; you
approve/reject in the workbench. Task completion needs your assessment and an actual
successful project or Pipeline execution receipt. Editing resets approval and current
assessments; reopening a step clears downstream assessments while preserving history.
Plan approval never executes code or bypasses tool approval, and declared methods and
human acceptance are not independent scientific validation. See
[research plan decisions](docs/adr/0011-human-governed-research-plans.md).

Research memory now has a topic tree with sourced facts, session-private notes and
project-local long-term entries. Save a proposal, review its sources and explicitly
confirm its version before the Scientist can use it. Summaries pin source revisions;
changing or withdrawing a source removes dependent stale summaries from automatic
context. Consolidation retains all original history. Promoting private session content
requires a separate sharing approval. Long-term memory is currently scoped to one
project. Declared file/citation references are not automatically read or verified.
See [memory architecture](docs/adr/0004-scoped-revisioned-memory.md).

The Python environment panel can explicitly create an independent managed venv.
Provide exact package versions and SHA-256 wheel hashes, including all dependencies;
leave the package array empty for a base environment. Only binary wheels install,
from public PyPI or a project-relative offline wheel directory. Nothing installs on
reads or Agent calls. Installations show bounded logs and can be canceled; unfinished
files can be explicitly removed while keeping receipts. Failures never replace the
previous environment. No base Python interpreter or R installer is bundled.

Select a ready environment (or external Python for rollback) for the **next Host
start**. The current kernel and its variables stay intact. Selected files are checked
before selection/startup; changed/missing environments block new Python work while
the workbench remains available for rollback. Python Pipeline defaults follow the
next-start choice and recovery retains environment checks. This currently has POSIX
coverage; Windows/Electron, full base-runtime download and public scientific lock
catalogs remain unverified/unimplemented. See
[managed environment decisions](docs/adr/0012-managed-python-environments.md).
`pnpm test:provisioning` checks forced Host death/recovery; the optional
`pnpm test:provisioning:online` explicitly downloads one small pinned PyPI fixture
into a temporary environment. Neither uses official cloud credentials or payments.

Other flags: `--python /path/to/venv/bin/python`, `--port 18620`,
`--rscript /path/to/Rscript`, `--pass-env NCBI_API_KEY,CUSTOM_DATA_VAR`, `--state-dir /private/state/directory`, and `--cloud-base https://auth.omicos.cn`.
The service binds only to loopback; exposing it as a public server is unsupported.

The standalone CLI runs explicit Python cells without Harness. When this same
workspace is opened from the DSH OmicOS entry, it also provides Agent chat through
the existing Harness session controller. Each project keeps one fixed Scientist
session; no second LLM loop is started. Without a Harness connection, the chat
panel explains how to connect and local Python remains available. Tool approval
is currently completed in the Harness main window.

The cloud window also lists each service domain's membership and server-provided
expiry reminders, with purchase/trial/grant/seat labels. Renewal selects the correct
catalog and requires a separate order confirmation. Cancel/restore names the target
domain; older servers that do not acknowledge it are rejected before mutation.
Unknown/offline membership status is never treated as a downgrade, and local work
remains independent. See [membership boundaries](docs/adr/0006-domain-memberships.md).

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
    workerEnvNames: []
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
- `omicos_notebook_state`: list/read/export persistent Notebook documents and execution references.
- `omicos_notebook_update`: approved create/import/save with exact revision checks.
- `omicos_notebook_run`: approved saved-cell execution with stable retry IDs.
- `omicos_cloud_store`: cloud account and store/workspace entry points; no payment tool.

Python and memory-write tools use Harness's pre-execution approval mechanism.
Without an approval service/channel they fail closed. Other tool-policy denials
are preserved. Workers receive a deliberate OS/scientific runtime environment instead of the
Host’s whole environment. Arbitrary model keys/tokens are not inherited by default.
Use `workerEnvNames` (or CLI `--pass-env`) to explicitly forward additional variable
names required by a scientific integration; their values are not logged.
Python runs with your operating-system permissions; this is a
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

The full published Harness Web integration can be reproduced with
`pnpm test:harness-browser` (Playwright Chromium must be installed). It creates
an isolated temporary DSH profile, installs this local plugin, uses a local synthetic
model key and model server, and verifies owner authentication, the OmicOS entry,
fixed Scientist chat, and approval in the actual main window before real Python
execution. It does not use your normal DSH profile or call a paid model.

Orders created on this device are recorded in a private, account-and-origin-scoped
SQLite recovery ledger. The store can reopen them after a window close or restart.
The local list omits payment links and labels status as the last check; reopening
requires a fresh official query and matching amount/provider/expiry before showing
a saved QR. Paid or expired orders never regain a payable QR. A failed local save
after checkout reports a recovery warning with the successful order; it never
repeats the purchase. This is local recovery history, not a complete cross-device
cloud order listing.

With `backend: core`, the OmicOS tab retains its original account, kernel and
capability console and delegated Core tools. Its optional local workbench does
not advertise the OSS Scientist preset; use the original Harness/Core conversation
or select the OSS backend. The OSS backend never needs a private Core binary.

Cloud mutations are bound to the account and login generation visible when the
form was opened. If another window switches accounts, the Host rejects stale
subscription, invoice and seat actions before contacting the cloud, refreshes the
UI, and asks the user to review the current account. It never silently replays
those actions. Local execution and workspace resolution remain account-independent.

## Local Pipelines

The workbench can save fixed ordered Python/R definitions and run them in independent
project workers. Each definition pins code, JSON parameters, declared data paths,
optional versioned reference text and its content hash. Editing creates a new hash.
Saving never executes; the Run button approves execution, and `gate: true` pauses
before that step for a separate human decision. These workers do not inherit ad hoc
variables; they use the project working directory and configured interpreter.

Checkpoints declare durable files and explicit `restoreCode`. The Host records hashes
after successful execution. Recovery verifies original inputs/checkpoints, starts a
fresh namespace, compares actual environment metadata, and runs the pinned restore
source only after approval. Changed environments need explicit acceptance. Failure,
cancellation or interruption never triggers an automatic replay; review partial
side effects before restoring or recomputing. Four runs may hold local kernels at
once; overlapping declared output/input paths are reserved to prevent collisions.

Pipeline tools: `omicos_pipeline_state`, `omicos_pipeline_define`,
`omicos_pipeline_start`, and `omicos_pipeline_control`. Definition/start/recovery
actions use Harness approval; cancellation requests stop the named run. Full
receipts, file/artifact hashes and sequenced recovery logs remain accessible after
workers stop. The current executor is local and ordered, with one language per
definition; remote/mixed-language orchestration remains in the migration plan.

On POSIX, a bundled Node supervisor owns each scientific process group and monitors
a separate Host-lifetime socket. Abrupt Host death terminates the owned family, even
when Python/R are busy in native code. This is lifecycle management rather than a
sandbox: trusted code has OS-user permissions and can deliberately escape the group
or leave external side effects. Windows and Electron-host lifecycle behavior are
not yet verified. See [Pipeline decisions](docs/adr/0002-persistent-local-pipelines.md)
and [worker ownership](docs/adr/0003-scientific-worker-ownership.md).

Pipeline definitions and runs also have independent 50-summary pages and search/
state filters. The current pinned draft and run stay selected while browsing other
pages; a known definition SHA-256 or full run UUID can be opened directly. Older
runs keep the same start-operation deduplication and explicit recovery requirements.
Collection paging does not truncate an individual run's full evidence journal. See
[Pipeline collection decisions](docs/adr/0010-pipeline-collection-paging.md).

## Capability discovery

Run `omicos-oss --version` to inspect the installed version without opening a project.
The owner-authenticated `GET /omicos/oss/api/capabilities` describes the runtime
version, supported scientific protocol and implemented/optional/unverified features.
It never starts interpreters or contacts cloud. Send `x-omicos-protocol: 1` to API
requests; an unsupported explicit version returns HTTP 426 before dispatch. Discovery
remains accessible after owner authentication even with a mismatched header. Existing
clients without the header retain protocol-1 behavior. The workbench footer and
`omicos_runtime_capabilities` Agent tool expose the same contract.

# @omicverse/dsh-omicos

Run [OmicVerse](https://github.com/Starlitnightly/omicverse)/OmicOS bioinformatics
analyses from inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
The dsh agent keeps the wheel; this plugin gives it a persistent Python kernel
(scanpy / omicverse / R) plus the catalog of analysis skills that OmicOS ships.

> 中文简介：把 OmicOS 的生信分析能力接进 dsh。DeepSeek 负责对话与规划，
> OmicOS 负责跑分析——持久 Python 内核，`adata` 等状态跨轮累积；
> 另带账号/订阅标签页与实时执行过程可视化。

```sh
dsh plugin --profile web add @omicverse/dsh-omicos
```

## Tools

One tool runs an analysis; the rest are direct reads of the local kernel that
cost neither a turn nor a token.

| Tool | What it does |
| --- | --- |
| `omicos_analyze` | Runs a full OmicOS turn in a persistent kernel bound to the workspace. Repeated calls in one dsh session land on the same OmicOS conversation, so state accumulates. `background: true` hands it to `ctx.jobs` with live tqdm progress. |
| `omicos_capabilities` | Searches the installed skill/agent catalog (269 skills + 97 agents on a full install) and returns a ranked, bounded projection. Use it to decide whether a task is worth delegating. Omit the query for a category overview. |
| `omicos_list_variables` | What currently lives in the kernel — name, type, shape, size. |
| `omicos_query_variable` | One variable in detail. For an AnnData this includes the preprocessing state (`is_int` / `is_normalized` / `is_log1p` / `is_scaled`), which is what decides whether the next step is legal. |
| `omicos_list_generated_files` | Every file the analyses of this conversation produced. |

## Commands

`/omicos-login` (device-code pairing — sign in with phone or email in the
browser), `/omicos-status`, `/omicos-account`, `/omicos-logout`,
`/omicos-stop-kernel`.

## UI

The client bundle adds two surfaces to the web profile:

- an **OmicOS tab** next to the conversation — sign-in state, plan, expiry, and
  links to subscribe or manage the account;
- a **live tool view** on `omicos_analyze` calls — the steps, tool calls and
  stdout tail as the analysis runs, instead of a spinner that ends in a wall of
  text. Generated figures render in the settled card.

If [dsh-better-sidebar](https://github.com/dsh-external/dsh-better-sidebar) is
installed, an "OmicOS 产物" tab is registered there too; the integration is
optional and detected at runtime.

## Requirements

- **omicos-core comes with the install.** `@omicverse/omicos` is a dependency,
  so the ~21 MB platform binary lands in node_modules alongside the plugin
  rather than being fetched by `npx` in the middle of your first tool call.
  At run time the plugin still attaches to a kernel you already have running
  (desktop app or terminal) if there is one, spawns the bundled binary only
  when there is not, and only ever stops a kernel it started itself.
- An **OmicOS account** for cloud-backed models and the higher plan tiers.
  Sign in with `/omicos-login`; no token is ever persisted by this plugin — the
  approved login is handed to the local core, which keeps it.
- dsh `0.1.0-rc.6`. Note that some `@deepseek-ai/dsh-*` packages have a stale
  `latest` dist-tag pointing at `0.0.1-rc.x`, so every dsh dependency here is
  pinned exactly.

## Configuration

Override in your profile's own `cordis.patch.yml`. A patch **replaces** the
row's whole config — there is no deep merge — so restate every key you care
about:

```yaml
- id: omicos
  config:
    workspace: /path/to/project   # '' = follow each dsh session's own cwd
    autoStart: true               # spawn a kernel when none is attachable
    upstreamBaseUrl: https://auth.omicos.cn
    npmRegistry: ''               # mirror knob for the kernel spawn
```

## Security posture

- Tools run in core with `permission_mode: "full"`. A single-shot tool result
  has no room for a mid-flight approval prompt, and blocking on one deadlocks
  the turn; bridging dsh's approval UI into an OmicOS turn is planned, not done.
- Catalog search projects before it answers: the skill `source_path` (an
  absolute local path) and the verbatim `use_when` routing text are indexed but
  never returned, so they do not travel to the model.
- The plugin's HTTP routes are pinned to loopback.

## Development

```sh
pnpm install
pnpm build       # tsc + the client bundle
pnpm typecheck
pnpm test        # 88 tests against the real dsh defineTool and a mock core
```

This package publishes as ONE dependency-light artifact: the `@omicverse/omicos-*`
SDK is inlined by `esbuild.host.mjs` and kept as devDependencies, while
`@deepseek-ai/*` stays external (the harness supplies it, and a second copy of
Schema would fail config validation) and `@omicverse/omicos` stays a real
dependency (it is spawned as a child process, never imported).

`src/host/dsh-compat.ts` is the only module allowed to import `@deepseek-ai/*`.
`bridge.ts` / `kernel.ts` / `runner.ts` / `auth.ts` have no dsh dependency at
all, so a dsh API change is absorbed in the compat layer plus `tools.ts`,
`commands.ts` and `index.ts`.

GPL-3.0-only

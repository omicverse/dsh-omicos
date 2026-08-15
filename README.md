# @omicverse/dsh-omicos

OmicOS as a [deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) plugin —
**Mode A（tools）**：dsh/DeepSeek 的 agent 保持方向盘，omicos 作为生信能力接入
（详见 monorepo 根的 `DSH-PLUGIN.md`）。v0.1 host-only：零浏览器 bundle，
结果走 stock 工具卡渲染（图以 ImageBlock 进 dsh attachment store）。

## 提供什么

**工具**（注册进 `ctx.tools`，模型可调）：

- `omicos_analyze` — 跑一整个 omicos turn（scanpy/omicverse/R，持久内核，
  同一 dsh 会话的多次调用命中同一个 omicos 会话，`adata` 等状态跨调用累积）。
  `background: true` 时转入 `ctx.jobs`（kind `omicos-analysis`），tqdm 进度经
  job 的 `readOutput()` 可见。
- `omicos_query_variable` — 查内核变量摘要（AnnData 的 obs/var/layers 等）。
- `omicos_list_generated_files` — 列出本会话所有分析产出文件。

**命令**（人类面）：`/omicos-login`（`wechat` / `device`，立即返回配对码或
QR 链接，批准在后台完成）、`/omicos-status`、`/omicos-logout`、
`/omicos-stop-kernel`（只停本插件自己启动的内核，F13）。

## 安装

```sh
dsh plugin --profile <name> add @omicverse/dsh-omicos
```

包声明了 `dsh.bundle.patch`，安装后自动进入 profile 的 bundles 列表并激活
`cordis.patch.yml` 里的 `id: omicos` 行。配置在 profile 自己的
`cordis.patch.yml` 里按 id 覆写（**patch 替换整行 config，不做 deep-merge**）：

```yaml
- id: omicos
  config:
    workspace: /path/to/project
    authMethod: wechat-qr
```

配置项与默认值见 `src/host/index.ts` 的 `Config`。

## 安全姿态（v0.1）

- 工具在 core 内以 `permission_mode: "full"` 直跑（单发工具结果放不下中途审批，
  否则 turn 死锁 —— DSH-PLUGIN.md §3）；审批桥接排 v0.3。
- 插件不持久化任何 token：登录批准后立即 `POST /api/cloud/login` 交给本地
  core 的 `cloud_login.json` 保管。
- 只停自己 spawn 的内核；挂载到的外部内核（桌面 App / 终端）永不触碰。

## 已知与设计文档的偏差（均为核实后的修正）

- 命令名用连字符（`omicos-login`）：dsh 命令名约束 `/^[a-z][a-z0-9_-]*$/`，
  设计稿里的 `omicos:login` 不可注册。
- 微信登录 CLI 侧不渲染 ASCII QR：服务端只回二维码**图片** URL，payload URL
  未核实前不猜格式，先打印链接（浏览器打开后手机扫）。
- job label 不可更新（dsh 无此 API），进度改走 `readOutput()`。
- ⚠️ npm 上部分 `@deepseek-ai/dsh-*` 的 `latest` dist-tag 指向旧版
  `0.0.1-rc.x`——一切 dsh 依赖必须显式钉 `0.1.0-rc.6`（本包 peer 均为精确版本）。

## 开发

```sh
pnpm --filter @omicverse/dsh-omicos typecheck
pnpm --filter @omicverse/dsh-omicos test    # 31 tests: bridge/kernel/runner + tools/commands（真 defineTool + MockCore）
pnpm --filter @omicverse/dsh-omicos build
```

`src/host/dsh-compat.ts` 是唯一允许 import `@deepseek-ai/*` 的模块（防腐层）；
`bridge.ts` / `kernel.ts` / `runner.ts` / `auth.ts` 零 dsh 依赖，churn 时只有
compat 与 `tools.ts` / `commands.ts` / `index.ts` 需要动。

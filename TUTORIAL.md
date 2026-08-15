# dsh-omicos 使用教程（v0.1，本地安装版）

> 状态：包**尚未发布到 npm**，当前走本地路径安装（`link:`），以下每一步
> （除最后的真实对话 turn）都在 2026-08-14 真机验证过。发布到 npm 后，
> 第 2 步换成 `add @omicverse/dsh-omicos` 即可，其余不变。

## 0. 前提

- Node ≥ 18（实测 v25）、pnpm（`dsh plugin` 内部调用它）
- 不需要全局安装 dsh，全程 `npx` 并**显式钉版** `@0.1.0-rc.6`
  （⚠️ 部分 `@deepseek-ai/dsh-*` 包的 `latest` tag 指向旧版，别裸装）
- dsh 的所有状态在 `~/.dsh`（可用 `DSH_HOME` 环境变量改位置）

## 1. 构建插件（monorepo 内）

```bash
cd omicos-ext && pnpm install && pnpm build
```

## 2. 装进 dsh 的 web profile

```bash
npx -y @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add \
  /Users/fernandozeng/Desktop/analysis/omicos-project/omicos-ext/apps/dsh-plugin
```

首次运行会自动初始化 `web` profile（`dsh-base` + `dsh-web-app`）；本包声明了
`dsh.bundle.patch`，安装后自动进入 `dsh.profile.bundles` 并激活。验证：

```bash
npx -y @deepseek-ai/dsh@0.1.0-rc.6 --profile web --dump-config
```

末尾应有 `# == @omicverse/dsh-omicos` 与 `- id: omicos` 行。

## 3. 配置

**DeepSeek key**（dsh 自己的大脑）：环境变量 `DEEPSEEK_API_KEY`，或写进
`~/.dsh/.credentials.yaml`（明文文件，注意权限）。

**omicos 插件配置**（可选）：编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: omicos
  config:
    workspace: /path/to/你的分析目录   # 空 = dsh 启动时的 cwd
    authMethod: wechat-qr             # 或 device-code（默认）
    npmRegistry: https://registry.npmmirror.com   # 大陆网络建议
```

⚠️ patch 是**整行替换** config，不做 deep-merge——要改就把关心的键全写上。
改配置 = 重启 dsh 生效。

## 4. 启动

```bash
cd 你的分析目录
DEEPSEEK_API_KEY=sk-xxx npx -y @deepseek-ai/dsh@0.1.0-rc.6 --profile web
```

浏览器打开输出的地址（默认 `http://127.0.0.1:3080`）。
⚠️ 该端口只有 Host-header 防线、无认证，别绑 0.0.0.0。

## 5. 连接 / 登录 OmicOS 内核

两种情况：

- **本机已在跑 OmicOS**（桌面 App 或 `omicos serve`，且 workspace 相同）：
  插件自动挂载现成内核，**登录都不用**，直接跳到第 6 步。
- **没有现成内核**：首次调用 omicos 工具时自动 `npx @omicverse/omicos` 启动
  一个（首次下载平台二进制可能要几分钟）。然后在对话框输入：
  - `/omicos-login` —— 立即返回设备码配对链接（或 `/omicos-login wechat`
    返回微信扫码链接），在浏览器/手机上批准；
  - `/omicos-status` —— 查看批准结果与内核状态。
  token 由本地 omicos 内核保管，插件不落任何凭据。

## 6. 使用

直接和 DeepSeek 对话，它会在需要时调用 omicos 工具：

- 「用 omicos 读取 `data/pbmc.h5ad`，做质控和聚类，画 UMAP」
  → `omicos_analyze`，图直接渲染在工具卡里，同一会话内 `adata` 状态**跨调用累积**
- 「我现在的 adata 是什么状态？」→ `omicos_query_variable`（更便宜）
- 「这个会话产出过哪些文件？」→ `omicos_list_generated_files`
- 长任务：让它「后台跑」→ 转 `omicos-analysis` job，用 dsh 的 job 工具轮询，
  tqdm 进度在 job 输出里可见

其他命令：`/omicos-logout`（只登出本机内核）、`/omicos-stop-kernel`
（只停插件自己启动的内核，外部内核永不触碰）。

## 7. 卸载 / 排障

```bash
npx -y @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web remove @omicverse/dsh-omicos
```

- 插件没生效 → 先 `--dump-config` 看 `id: omicos` 行在不在
- 工具报「无法连接内核」→ `/omicos-status`；确认 workspace 目录与正在跑的
  omicos 实例一致（发现锚点是 `<workspace>/.omicos/serve.pid`）
- v0.1 安全姿态：omicos 侧工具以 `permission_mode: "full"` 免审批直跑
  （单发工具结果放不下中途审批）；介意就等 v0.3 的审批桥接

## 验证边界（诚实声明）

已真机验证：安装识别、bundles 激活、`--dump-config`、模块导入、web UI 带插件
层启动无报错、以及插件所有逻辑的 31 个单测（真 defineTool + 真 HTTP/SSE mock）。
**未跑过**：带 DEEPSEEK_API_KEY 的完整真实对话 turn（需要真实 key）。

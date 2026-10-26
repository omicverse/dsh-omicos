import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleDict } from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  installNavigationGuard,
  registerUnsavedCommands
} from './unsaved-navigation.js'
import type {
  ILayout,
  MainPanelId
} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { registerOmicosLanguageRow } from './OmicosLanguage.js'
import { OmicosPanel, type OmicosPage } from './OmicosPanel.js'
import { OmicosSidebarHeader } from './OmicosSidebar.js'
import { OmicosStarters } from './OmicosStarters.js'
import componentStyles from './oss.css?inline'
import shellStyles from './omicos-shell.css?inline'

export const OMICOS_PAGES: ReadonlyArray<{
  id: OmicosPage
  label: string
  icon: string
}> = [
  { id: 'data', label: '数据盘', icon: 'data' },
  { id: 'notebook', label: 'Notebook', icon: 'notebook' },
  { id: 'figures', label: '图库', icon: 'figures' },
  { id: 'memory', label: '记忆', icon: 'memory' },
  { id: 'pipelines', label: '科研流程', icon: 'pipelines' },
  { id: 'methods', label: '方法与证据', icon: 'methods' },
  { id: 'runtime', label: '运行环境', icon: 'runtime' },
  { id: 'store', label: '订阅商城', icon: 'store' }
]

export function OmicosMark({ size = 28 }: { size?: number }): JSX.Element {
  return (
    <svg
      className="omicos-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M9 4c0 9 14 15 14 24M23 4c0 9-14 15-14 24" />
        {[7, 12, 20, 25].map((y, index) => (
          <path
            key={y}
            d={`M${index === 1 || index === 2 ? 13 : 10} ${y}h${index === 1 || index === 2 ? 6 : 12}`}
          />
        ))}
      </g>
    </svg>
  )
}
function PanelIcon({
  kind,
  size = 18
}: {
  kind: string
  size?: number
}): JSX.Element {
  const paths: Record<string, string> = {
    data: 'M4 5c0-3 16-3 16 0v14c0 3-16 3-16 0ZM4 5c0 3 16 3 16 0M4 12c0 3 16 3 16 0',
    notebook: 'M5 3h14v18H5ZM9 3v18M12 8h4M12 12h4',
    figures: 'M3 4h18v16H3ZM3 16l6-6 5 5 3-3 4 4M15 8h.01',
    memory: 'M4 5h16v14H4ZM8 9h8M8 13h6',
    pipelines: 'M5 5h4v4H5ZM15 15h4v4h-4ZM7 9v8h8M9 7h8v8',
    methods: 'M5 4h6v16H5ZM13 4h6v16h-6M8 8v8M16 8v8',
    runtime:
      'M5 6h14v12H5ZM9 3v3M15 3v3M9 18v3M15 18v3M2 10h3M19 10h3M2 14h3M19 14h3',
    store: 'M4 9h16v12H4ZM3 9l2-6h14l2 6M9 21v-7h6v7'
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  )
}
const PRIMARY_PAGES: ReadonlyArray<OmicosPage> = [
  'data',
  'notebook',
  'figures',
  'memory',
  'store'
]
const RAIL_EXPANDED_KEY = 'omicos.rail.expanded'

function readRailExpanded(): boolean {
  try {
    return localStorage.getItem(RAIL_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

function RailGlyph({ children }: { children: JSX.Element }): JSX.Element {
  return <span className="omicos-rail-ic">{children}</span>
}

function OmicosRail({
  layout,
  toggleTheme,
  hostPanels
}: {
  layout: ILayout
  toggleTheme: () => void
  hostPanels: () => ReadonlyArray<{ id: string; label: string }>
}): JSX.Element {
  const rail = useRef<HTMLElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const moreMenu = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(readRailExpanded)
  const [moreOpen, setMoreOpen] = useState(false)
  const selected = useSyncExternalStore(
    layout.panelInfo.subscribe,
    layout.panelInfo.getSnapshot
  ).activePanelId
  const primary = PRIMARY_PAGES.map(
    (id) => OMICOS_PAGES.find((page) => page.id === id)!
  )
  const overflow = OMICOS_PAGES.filter((page) => !PRIMARY_PAGES.includes(page.id))
  const hostEntries = moreOpen ? hostPanels() : []
  const overflowActive =
    overflow.some((page) => selected === `omicos-${page.id}`) ||
    (selected !== null && !selected.startsWith('omicos-'))
  useEffect(() => {
    const frame = rail.current?.closest('[data-shell-overlay]')?.parentElement
    if (!frame) return
    const workspaceColumn = frame.firstElementChild
    const previousWorkspace = workspaceColumn?.getAttribute(
      'data-omicos-workspace-column'
    )
    workspaceColumn?.setAttribute('data-omicos-workspace-column', '')
    const previous = frame.getAttribute('data-omicos-frame')
    frame.setAttribute('data-omicos-frame', '')
    return () => {
      if (previousWorkspace == null)
        workspaceColumn?.removeAttribute('data-omicos-workspace-column')
      else
        workspaceColumn?.setAttribute(
          'data-omicos-workspace-column',
          previousWorkspace
        )
      if (previous === null) frame.removeAttribute('data-omicos-frame')
      else frame.setAttribute('data-omicos-frame', previous)
    }
  }, [])
  useEffect(() => {
    document.documentElement.toggleAttribute('data-omicos-rail-expanded', expanded)
    try {
      localStorage.setItem(RAIL_EXPANDED_KEY, expanded ? '1' : '0')
    } catch {
      // Appearance preference only; the rail still works without storage.
    }
    return () => document.documentElement.removeAttribute('data-omicos-rail-expanded')
  }, [expanded])
  useEffect(() => {
    if (!moreOpen) return
    const close = (event: Event): void => {
      const target = event.target as Node
      if (moreMenu.current?.contains(target) || moreButton.current?.contains(target))
        return
      setMoreOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMoreOpen(false)
      moreButton.current?.focus()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [moreOpen])
  const pageButton = (page: (typeof OMICOS_PAGES)[number]): JSX.Element => (
    <button
      key={page.id}
      type="button"
      className="omicos-rail-page"
      title={page.label}
      aria-label={page.label}
      aria-current={selected === `omicos-${page.id}` ? 'page' : undefined}
      onClick={() => {
        setMoreOpen(false)
        layout.selectPanel(`omicos-${page.id}` as MainPanelId)
      }}
    >
      <RailGlyph>
        <PanelIcon kind={page.icon} size={20} />
      </RailGlyph>
      <span className="omicos-rail-label">{page.label}</span>
    </button>
  )
  return (
    <nav
      ref={rail}
      className="omicos-rail"
      data-expanded={expanded ? '' : undefined}
      aria-label="OmicOS 功能导航"
    >
      <div className="omicos-rail-top">
        <button
          type="button"
          className="omicos-rail-page omicos-rail-brand"
          aria-expanded={expanded}
          title={expanded ? '收起导航' : '展开导航'}
          aria-label={expanded ? '收起导航' : '展开导航'}
          onClick={() => setExpanded((value) => !value)}
        >
          <RailGlyph>
            <OmicosMark size={24} />
          </RailGlyph>
          <span className="omicos-rail-label">
            {expanded ? '收起导航' : '展开导航'}
          </span>
        </button>
      </div>
      <div className="omicos-rail-nav">
        <button
          type="button"
          className="omicos-rail-page"
          title="对话"
          aria-label="对话"
          aria-current={selected === null ? 'page' : undefined}
          onClick={() => {
            setMoreOpen(false)
            layout.selectPanel(null)
          }}
        >
          <RailGlyph>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M4 19l1-4a8 8 0 1 1 4 4ZM8 10h8M8 14h5" />
            </svg>
          </RailGlyph>
          <span className="omicos-rail-label">对话</span>
        </button>
        {primary.map(pageButton)}
        <button
          ref={moreButton}
          type="button"
          className="omicos-rail-page"
          title="更多"
          aria-label="更多"
          
          aria-expanded={moreOpen}
          aria-current={overflowActive ? 'page' : undefined}
          onClick={() => setMoreOpen((value) => !value)}
        >
          <RailGlyph>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </RailGlyph>
          <span className="omicos-rail-label">更多</span>
        </button>
      </div>
      {moreOpen ? (
        <div ref={moreMenu} className="omicos-rail-more">
          {overflow.map((page) => (
            <button
              key={page.id}
              type="button"
             
              aria-current={selected === `omicos-${page.id}` ? 'page' : undefined}
              onClick={() => {
                setMoreOpen(false)
                layout.selectPanel(`omicos-${page.id}` as MainPanelId)
              }}
            >
              <PanelIcon kind={page.icon} size={18} />
              <span>{page.label}</span>
            </button>
          ))}
          {hostEntries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={selected === entry.id ? 'page' : undefined}
              onClick={() => {
                setMoreOpen(false)
                layout.selectPanel(entry.id as MainPanelId)
              }}
            >
              <PanelIcon kind="runtime" size={18} />
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="omicos-rail-foot">
        <button
          type="button"
          className="omicos-rail-page"
          title="切换深浅外观"
          aria-label="切换深浅外观"
          onClick={toggleTheme}
        >
          <RailGlyph>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
            </svg>
          </RailGlyph>
          <span className="omicos-rail-label">外观</span>
        </button>
      </div>
    </nav>
  )
}
function OmicosMainPanel({
  page,
  useSessions
}: PropsRuntime<'main'> & { page: OmicosPage }): JSX.Element {
  const sessionId = useSessions(
    (state) =>
      Object.values(state.byId).find(
        (session) => (session.retainedBy.mainView ?? 0) > 0
      )?.id
  )
  return (
    <OmicosPanel
      key={sessionId || 'unselected'}
      page={page}
      sessionId={sessionId}
      allowProjectSelection
    />
  )
}
function OmicosDocumentTitle({
  useSessions,
  usePanelInfo
}: PropsRuntime<'shell.overlay'>): null {
  const conversation = usePanelInfo((info) => info.activePanelId === null)
  const title = useSessions(
    (state) =>
      Object.values(state.byId).find(
        (session) => (session.retainedBy.mainView ?? 0) > 0
      )?.title
  )
  useEffect(() => {
    const previous = document.title
    const next = conversation && title ? `${title} — OmicOS OSS` : 'OmicOS OSS'
    document.title = next
    return () => {
      if (document.title === next) document.title = previous
    }
  }, [conversation, title])
  return null
}
function ShellAppearance(): null {
  useEffect(() => {
    const previous = document.documentElement.getAttribute('data-omicos-shell')
    document.documentElement.setAttribute('data-omicos-shell', '')
    return () => {
      if (previous === null)
        document.documentElement.removeAttribute('data-omicos-shell')
      else document.documentElement.setAttribute('data-omicos-shell', previous)
    }
  }, [])
  return null
}

/** Brand, navigation and scientific pages live in the real Harness shell. */
export function registerOmicosShell(ctx: Context): void {
  registerUnsavedCommands(ctx)
  ctx.effect(
    () =>
      installNavigationGuard(() =>
        ctx.slots
          .entriesOfSlot('sidebar.panellist')
          .map((entry) => resolveSlotLabel(entry.options.label) || '')
          .filter(Boolean)
      ),
    'omicos: unsaved editor navigation'
  )
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.omicosShell = ''
    style.textContent = componentStyles + '\n' + shellStyles
    document.head.append(style)
    return () => style.remove()
  }, 'omicos: application appearance')
  ctx.inject(['locale'], (sub) => {
    registerOmicosLanguageRow(sub)
    for (const language of [
      { id: 'zh-x-omicos', label: '中文 · OmicOS', fallback: 'zh' },
      { id: 'en-x-omicos', label: 'English · OmicOS', fallback: 'en' }
    ]) {
      sub.effect(
        () => sub.locale.addLanguage(language),
        `omicos: ${language.id} language`
      )
      const zh = language.fallback === 'zh'
      const dictionaries: Record<string, LocaleDict> = {
        common: { 'brand.localBuild': 'OmicOS OSS' },
        conversation: {
          'hero.headline': zh
            ? '和 OmicOS 一起，探索下一次发现'
            : 'Your next discovery starts here',
          'hero.preview': 'OSS',
          'placeholder.hero': zh
            ? '描述你的科研问题，/ 使用命令，@ 引用文件或会话'
            : 'Ask a research question, / commands, @ files or conversations'
        },
        'settings.models': {
          welcomeTitle: zh ? '欢迎使用 OmicOS OSS' : 'Welcome to OmicOS OSS',
          welcomeBody: zh
            ? 'OmicOS OSS 将科研对话、数据、Notebook、图表、记忆与科研流程整合在一个应用中。本地科研无需云订阅；对话模型可使用你自己的 API Key。\n\n此版本基于开源 Harness，会话、Agent、工具审批和插件由同一套运行机制管理。执行和联网操作遵循当前会话的权限设置。OmicOS 云服务在订阅商城中单独管理。'
            : 'OmicOS OSS brings research conversations, data, notebooks, figures, memory and pipelines into one application. Local science needs no cloud subscription; connect your own model API key.\n\nBuilt on open-source Harness, with native sessions, agents, approvals and plugins. Execution and network access follow the current session permissions. Manage optional OmicOS cloud services separately in the Store.'
        },
        'settings.account': {
          loginTitle: zh ? '配置 OmicOS 对话模型' : 'Connect a model to OmicOS',
          loginDescription: zh
            ? '添加模型 API Key，或使用 DeepSeek 账号连接模型。项目和科研文件保存在本地；OmicOS 云订阅在订阅商城中单独管理。'
            : 'Add a model API key or connect a DeepSeek account. Research files stay local. OmicOS cloud subscriptions are managed separately in the Store.',
          backToHarness: zh ? '返回 OmicOS' : 'Back to OmicOS'
        }
      }
      for (const [namespace, dictionary] of Object.entries(dictionaries))
        sub.effect(
          () => sub.locale.register(namespace, language.id, dictionary),
          `omicos: ${namespace} product copy`
        )
    }
  })
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'omicos-appearance' },
      ShellAppearance
    )
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'omicos-document-title' },
      OmicosDocumentTitle
    )
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'omicos-sidebar-header' },
      OmicosSidebarHeader
    )
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'omicos-starters' },
      OmicosStarters
    )
  )
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register(
      { name: 'sidebar.brand.mark', priority: -20 },
      OmicosMark
    )
  )
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name', priority: -20 }, () => (
      <span className="omicos-wordmark">
        OmicOS <small>OSS</small>
      </span>
    ))
  )
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register(
      { name: 'conversation.hero.brand.mark', priority: -20 },
      OmicosMark
    )
  )
  ctx.inject(['sidebarRightTabs'], (sub) => {
    for (const page of OMICOS_PAGES.filter(
      (page) => page.id !== 'store' && page.id !== 'runtime'
    )) {
      const id = `@omicverse/dsh-omicos/${page.id}`
      sub.effect(
        () =>
          sub.sidebarRightTabs.register({
            id,
            kind: `omicos-${page.id}`,
            keepMounted: true,
            title: () => page.label,
            guide: [
              {
                id: page.id,
                order: -50,
                title: () => page.label,
                description: () => '当前会话的 OmicOS 科研项目'
              }
            ]
          }),
        `omicos: ${page.id} sidebar type`
      )
      sub.slots.inject('sidebar.right.pane.tab', () =>
        sub.slots.register(
          { name: 'sidebar.right.pane.tab', key: id },
          ({ sessionId, useTabInfo }) => {
            const { tab } = useTabInfo()
            return (
              <OmicosPanel
                page={page.id}
                sessionId={sessionId}
                visible={tab.visible}
              />
            )
          }
        )
      )
    }
  })
  ctx.inject(['layout', 'theme'], (sub) => {
    sub.slots.inject('shell.overlay', () =>
      sub.slots.register(
        {
          name: 'shell.overlay',
          id: 'omicos-navigation',
          inject: () => ({
            layout: sub.layout,
            hostPanels: () =>
              sub.slots
                .entriesOfSlot('sidebar.panellist')
                .map((entry) => ({
                  id: String(entry.options.id ?? ''),
                  label: resolveSlotLabel(entry.options.label) || ''
                }))
                .filter((entry) => entry.id && entry.label),
            toggleTheme: () =>
              sub.theme.setTheme(
                sub.theme.getTheme().active.colorScheme === 'dark'
                  ? 'light'
                  : 'dark'
              )
          })
        },
        OmicosRail
      )
    )
  })
  for (const page of OMICOS_PAGES) {
    const key = `omicos-${page.id}`
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        { name: 'main', key, inject: () => ({ page: page.id }) },
        OmicosMainPanel
      )
    )
  }
}

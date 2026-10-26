import { useCallback, useEffect, useState } from 'react'
import { confirmUnsavedNavigation } from './unsaved-navigation.js'
import { api, HOST_REFRESH_EVENT, type Session } from './oss-api.js'
import { DataBrowser } from './DataBrowser.js'
import { NotebookPane } from './NotebookPane.js'
import { FigureStudioPane } from './FigureStudioPane.js'
import { FigureAssembliesPane } from './FigureAssembliesPane.js'
import { MemoryTreePane } from './MemoryTreePane.js'
import { PipelinePane } from './PipelinePane.js'
import { ResearchPlanPane } from './ResearchPlanPane.js'
import { DossierPane } from './DossierPane.js'
import { MethodLibraryPane } from './MethodLibraryPane.js'
import { EnvironmentPane } from './EnvironmentPane.js'
import { BaseRuntimePane } from './BaseRuntimePane.js'
import { ManagedEnvironmentPane } from './ManagedEnvironmentPane.js'
import { McpConnectionsPane } from './McpConnectionsPane.js'
import { ExecutionHistory } from './ExecutionHistory.js'
import { AnnDataExplorer } from './AnnDataExplorer.js'
import { useScienceSnapshot } from './useScienceSnapshot.js'
import { Store } from './OssWorkbench.js'

export type OmicosPage =
  | 'data'
  | 'notebook'
  | 'figures'
  | 'memory'
  | 'pipelines'
  | 'methods'
  | 'runtime'
  | 'store'
const labels: Record<OmicosPage, [string, string]> = {
  data: ['数据盘', '你的数据、对象与分析素材'],
  notebook: ['Notebook', '把探索过程留下，随时继续'],
  figures: ['图库', '从分析结果，到可以发表的图'],
  memory: ['记忆', '让已经确认的发现，成为下一步的起点'],
  pipelines: ['科研流程', '每一步分析，都有迹可循'],
  methods: ['方法与证据', '组织方法，核对证据，推进研究'],
  runtime: ['运行环境', '管理本地 Python、R 与科研扩展'],
  store: ['订阅商城', '按需连接 OmicOS 云端科研能力']
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** Actual main-panel surface; no iframe, second app or second Agent implementation. */
export function OmicosPanel({
  page = 'data',
  sessionId,
  visible = true,
  allowProjectSelection = !sessionId
}: {
  page?: OmicosPage
  sessionId?: string
  visible?: boolean
  allowProjectSelection?: boolean
}): JSX.Element {
  const [session, setSession] = useState<Session>()
  const [projectId, setProjectId] = useState('')
  const [domain, setDomain] = useState('')
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    const result = await api<Session>('session')
    setSession(result)
    setError('')
  }, [])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    const load = () => {
      void api<Session>('session', undefined, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) {
            setSession(result)
            setError('')
          }
        },
        (error) => {
          if (!controller.signal.aborted) setError(message(error))
        }
      )
    }
    load()
    const timer = setInterval(() => {
      if (visible && !document.hidden) load()
    }, 20000)
    window.addEventListener(HOST_REFRESH_EVENT, load)
    return () => {
      controller.abort()
      clearInterval(timer)
      window.removeEventListener(HOST_REFRESH_EVENT, load)
    }
  }, [visible])
  useEffect(() => {
    setDomain('')
  }, [
    session?.account.generation,
    session?.account.server,
    session?.account.user?.id
  ])
  useEffect(() => {
    if (!sessionId) return
    let live = true
    setProjectId('')
    void api<{ id: string }>('open-session-project', { sessionId }).then(
      (project) => {
        if (live) {
          setProjectId((current) => current || project.id)
          void refresh()
        }
      },
      (error) => {
        if (live) setError(message(error))
      }
    )
    return () => {
      live = false
    }
  }, [sessionId, refresh])
  useEffect(() => {
    if (!session?.account.login) return
    let live = true
    const timer = setInterval(() => {
      void api('login/poll', {}, undefined, session.account)
        .then(() => {
          if (live) return refresh()
        })
        .catch((error) => {
          if (live) setError(message(error))
        })
    }, 2500)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [session?.account.login?.user_code, refresh])
  const project =
    session?.projects.find((project) => project.id === projectId) ||
    (!sessionId ? session?.projects[0] : undefined)
  return (
    <div className="oss omicos-panel" data-omicos-page={page}>
      <header className="omicos-panel-head">
        <div>
          <h1>{labels[page][0]}</h1>
          <p>{labels[page][1]}</p>
        </div>
        <span className="omicos-edition">OmicOS OSS</span>
      </header>
      <div className="omicos-panel-content">
        {error && (
          <p className="oss-error" role="alert">
            {error}
            <button
              onClick={() =>
                void refresh().catch((error) => setError(message(error)))
              }
            >
              重试
            </button>
          </p>
        )}
        {!session ? (
          <p role="status">正在连接 OmicOS…</p>
        ) : page === 'store' ? (
          <>
            <div className="omicos-cloud-status">
              <span>
                {session.account.logged_in
                  ? session.account.user?.email || session.account.user?.id
                  : '本地科研无需登录；订阅云服务时连接账号。'}
              </span>
              <button
                onClick={() =>
                  void api(
                    session.account.logged_in ? 'logout' : 'login',
                    {},
                    undefined,
                    session.account
                  )
                    .then(refresh)
                    .catch((error) => setError(message(error)))
                }
              >
                {session.account.logged_in ? '退出云账号' : '登录 OmicOS 云'}
              </button>
            </div>
            {session.account.login && (
              <section className="oss-confirm">
                <h2>连接 OmicOS 云账号</h2>
                <p>
                  在
                  <a
                    href={session.account.login.verification_uri}
                    target="_blank"
                    rel="noreferrer"
                  >
                    官方配对页面
                  </a>
                  输入配对码：
                </p>
                <strong className="oss-pair-code">
                  {session.account.login.user_code}
                </strong>
              </section>
            )}
            <Store
              key={`${session.account.server}:${session.account.generation}:${session.account.user?.id || 'anonymous'}`}
              account={session.account}
              refresh={refresh}
              visible={visible}
              domain={domain}
              setDomain={setDomain}
            />
          </>
        ) : (
          <>
            <div className="omicos-project-bar">
              <span>工作区</span>
              {!allowProjectSelection ? (
                <strong>
                  {project?.workspace || '正在定位当前会话的项目…'}
                </strong>
              ) : (
                <select
                  aria-label="科研工作区"
                  value={project?.id || ''}
                  onChange={(event) => {
                    if (
                      confirmUnsavedNavigation(
                        event.currentTarget.closest('.omicos-panel') ||
                          undefined
                      )
                    )
                      setProjectId(event.target.value)
                  }}
                >
                  {!project && (
                    <option value="" disabled>
                      {sessionId ? '正在定位当前会话项目…' : '请选择科研工作区'}
                    </option>
                  )}
                  {session.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.workspace}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {project ? (
              <ProjectSurface
                key={`${project.id}:${page}`}
                page={page}
                projectId={project.id}
                visible={visible}
              />
            ) : (
              <p>
                从左侧打开一个项目会话，或在 OmicOS 启动配置中指定工作目录。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ProjectSurface({
  page,
  projectId,
  visible
}: {
  page: OmicosPage
  projectId: string
  visible: boolean
}): JSX.Element {
  const [language, setLanguage] = useState<'python' | 'r'>('python')
  const [prepared, setPrepared] = useState('')
  const { snapshot, error, refresh } = useScienceSnapshot(
    projectId,
    language,
    visible
  )
  return (
    <>
      {error && (
        <p role="alert" className="oss-error">
          {error}
        </p>
      )}
      {(page === 'notebook' || page === 'runtime') && (
        <div className="omicos-language-bar">
          <label>
            分析语言
            <select
              aria-label="分析语言"
              value={language}
              onChange={(event) =>
                setLanguage(event.target.value as 'python' | 'r')
              }
            >
              <option value="python">Python</option>
              <option value="r">R</option>
            </select>
          </label>
        </div>
      )}
      {page === 'data' && (
        <>
          <DataBrowser
            projectId={projectId}
            visible={visible}
            prepare={(language, code) => {
              setLanguage(language)
              setPrepared(code)
            }}
          />
          {prepared && (
            <section className="oss-card">
              <h2>已准备 {language === 'r' ? 'R' : 'Python'} 导入代码</h2>
              <p>将代码复制到 Notebook，确认后运行。</p>
              <pre>{prepared}</pre>
              <button onClick={() => setPrepared('')}>关闭</button>
            </section>
          )}
          <AnnDataExplorer
            projectId={projectId}
            visible={visible}
            variables={language === 'python' ? snapshot?.variables || [] : []}
          />
        </>
      )}
      {page === 'notebook' && (
        <>
          <NotebookPane
            projectId={projectId}
            language={language}
            onLanguage={setLanguage}
            executions={snapshot?.executions || []}
            refresh={refresh}
          />
          <ExecutionHistory
            projectId={projectId}
            language={language}
            visible={visible}
          />
        </>
      )}
      {page === 'figures' && (
        <>
          <FigureStudioPane projectId={projectId} visible={visible} />
          <FigureAssembliesPane projectId={projectId} visible={visible} />
        </>
      )}
      {page === 'memory' && (
        <MemoryTreePane projectId={projectId} visible={visible} />
      )}
      {page === 'pipelines' && (
        <>
          <ResearchPlanPane
            projectId={projectId}
            visible={visible}
            executions={snapshot?.executions || []}
          />
          <PipelinePane projectId={projectId} visible={visible} />
        </>
      )}
      {page === 'methods' && (
        <>
          <MethodLibraryPane projectId={projectId} visible={visible} />
          <DossierPane projectId={projectId} visible={visible} />
        </>
      )}
      {page === 'runtime' && (
        <>
          <article className="oss-card">
            <BaseRuntimePane visible={visible} />
          </article>
          <article className="oss-card">
            <ManagedEnvironmentPane projectId={projectId} visible={visible} />
          </article>
          <EnvironmentPane projectId={projectId} language={language} />
          <McpConnectionsPane projectId={projectId} visible={visible} />
        </>
      )}
    </>
  )
}

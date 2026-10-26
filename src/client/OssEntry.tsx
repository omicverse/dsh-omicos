import { useEffect, useState } from 'react'
import { AccountTab } from './AccountTab.js'
import { api, type Session } from './oss-api.js'
import { OmicosPanel, type OmicosPage } from './OmicosPanel.js'
const pages: Array<[OmicosPage, string]> = [
  ['data', '数据'],
  ['notebook', 'Notebook'],
  ['figures', '图表'],
  ['memory', '记忆'],
  ['pipelines', '流程'],
  ['methods', '方法'],
  ['runtime', '环境'],
  ['store', '商城']
]
/** The conversation view is an in-app scientific surface, never a dashboard link. */
export function OssEntry({ sessionId }: { sessionId?: string }): JSX.Element {
  const [backend, setBackend] = useState<Session['backend']>()
  useEffect(() => {
    const abort = new AbortController()
    void api<Session>('session', undefined, abort.signal)
      .then((session) => {
        if (!abort.signal.aborted) setBackend(session.backend)
      })
      .catch(() => {
        /* OmicosPanel reports connection errors. */
      })
    return () => abort.abort()
  }, [])
  const [page, setPage] = useState<OmicosPage>('data')
  if (backend === 'core')
    return (
      <div className="omicos-core-entry">
        <p>OmicOS · Core 兼容模式</p>
        <AccountTab />
      </div>
    )
  return (
    <div className="omicos-conversation-tools">
      <nav className="omicos-science-tabs" aria-label="会话科研工具">
        {pages.map(([id, label]) => (
          <button
            key={id}
            aria-current={page === id ? 'page' : undefined}
            onClick={() => setPage(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <OmicosPanel page={page} sessionId={sessionId} />
    </div>
  )
}

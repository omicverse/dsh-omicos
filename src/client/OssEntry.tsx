import { useEffect, useState } from 'react'
import { api, type Session } from './oss-api.js'
export function OssEntry({ sessionId }: { sessionId?: string }): JSX.Element {
  const [session, setSession] = useState<Session>()
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { let alive = true; void api<Session>('session').then(async result => { if (alive) setSession(result); if (sessionId) { const project = await api<{ id: string }>('open-session-project', { sessionId }); if (alive) setProjectId(project.id) } }).catch( error => { if (alive) setError(String(error)) }); return () => { alive = false } }, [sessionId])
  return <section style={{ padding: 28, lineHeight: 1.8 }}><small>OmicOS OSS</small><h2>科研工作台</h2><p>持久 Python、数据对象、执行记录、图表、Notebook 与项目记忆。</p><p><a href={`/omicos/oss${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`} target="_blank" rel="noreferrer">打开独立科研工作台 ↗</a></p><p><a href="/omicos/oss/store" target="_blank" rel="noreferrer">打开订阅商城窗口 ↗</a></p><p>云账号：{session ? session.account.logged_in ? session.account.user?.email || session.account.user?.id : '未登录；本地科研无需账号' : '正在连接…'}</p>{session?.projects.map(project => <p key={project.id}><code>{project.workspace}</code></p>)}{error && <p role="alert">{error}</p>}</section>
}

import { useEffect, useState } from 'react'
import { api } from './oss-api.js'
export function EnvironmentPane({ projectId, language }: { projectId: string; language: 'python' | 'r' }): JSX.Element {
  const [info, setInfo] = useState<{ python?: string; version?: string; executable?: string; packages: Record<string, string | null> }>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setInfo(undefined); setError('') }, [projectId, language])
  const probe = async () => { setBusy(true); setError(''); try { setInfo(await api(`project/${projectId}/environment?language=${language}`)) } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) } }
  return <article className="oss-card"><h2>{language === 'r' ? 'R' : 'Python'} 环境</h2><p>检查所选解释器和科研包版本，不会自动安装依赖。</p>{error && <p className="oss-error" role="alert">{error}</p>}{info && <><p>{info.python || info.version}<br /><code>{info.executable}</code></p>{Object.entries(info.packages).map(([name, version]) => <div className="oss-row oss-variable" key={name}><span>{name}</span><small>{version || '未安装'}</small></div>)}</>}<button disabled={busy} onClick={() => void probe()}>{busy ? '检查中…' : '检查环境'}</button></article>
}

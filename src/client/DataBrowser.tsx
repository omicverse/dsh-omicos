import { RemoteImportPane } from './RemoteImportPane.js'
import { DataImportPane } from './DataImportPane.js'
import { useCallback, useEffect, useState } from 'react'
import { api } from './oss-api.js'
import type { WorkspaceFile } from '../oss/files.js'
export function DataBrowser({ projectId, prepare, visible }: { projectId: string; visible: boolean; prepare: (language: 'python' | 'r', code: string) => void }): JSX.Element {
  const [path, setPath] = useState('')
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [truncated, setTruncated] = useState(false)
  const [preview, setPreview] = useState<{ path: string; bytes: number; text?: string; truncated?: boolean; kind: string }>()
  const [error, setError] = useState('')
  const reload = useCallback(async () => { const data = await api<{ entries: WorkspaceFile[]; truncated: boolean }>(`project/${projectId}/files?path=${encodeURIComponent(path)}`); setFiles(data.entries); setTruncated(data.truncated); setError('') }, [projectId, path])
  useEffect(() => { let alive = true; void api<{ entries: WorkspaceFile[]; truncated: boolean }>(`project/${projectId}/files?path=${encodeURIComponent(path)}`).then(data => { if (alive) { setFiles(data.entries); setTruncated(data.truncated); setError('') } }, error => { if (alive) setError(String(error)) }); return () => { alive = false } }, [projectId, path])
  const inspect = async (file: WorkspaceFile) => { try { setPreview(await api(`project/${projectId}/file-preview?path=${encodeURIComponent(file.path)}`)); setError('') } catch (error) { setError(String(error)) } }
  const prepareLoad = (file: WorkspaceFile) => {
    const name = file.path.toLowerCase(); const literal = JSON.stringify(file.path)
    if (name.endsWith('.h5ad')) prepare('python', `import anndata as ad\n# Read-only backed view; no full expression-matrix load\nadata = ad.read_h5ad(${literal}, backed='r')\nadata`)
    else if (name.endsWith('.csv') || name.endsWith('.tsv')) prepare('python', `import pandas as pd\ntable = pd.read_csv(${literal}${name.endsWith('.tsv') ? ", sep='\\t'" : ''})\ntable.head()`)
    else if (name.endsWith('.rds')) prepare('r', `object <- readRDS(${literal})\nstr(object, max.level=1)`)
  }
  return <article className="oss-card"><div className="oss-row"><h2>项目数据</h2><button onClick={() => void reload().catch(error => setError(String(error)))}>刷新文件</button></div><div className="oss-row"><code>/{path}</code>{path && <button onClick={() => { setPath(path.split('/').slice(0, -1).join('/')); setPreview(undefined) }}>上一级</button>}</div>{error && <p role="alert" className="oss-error">{error}</p>}<DataImportPane key={projectId} projectId={projectId} directory={path} visible={visible} committed={reload} /><RemoteImportPane key={`remote:${projectId}`} projectId={projectId} directory={path} visible={visible} committed={reload} /><div className="oss-data-files">{files.map(file => <div className="oss-data-file" key={file.path}><button className="oss-file-name" onClick={() => { if (file.directory) { setPath(file.path); setPreview(undefined) } else void inspect(file) }}>{file.directory ? '▸ ' : ''}{file.name}</button><small>{file.directory ? '目录' : `${(file.bytes / 1024).toFixed(1)} KiB`}</small>{/\.(h5ad|csv|tsv|rds)$/i.test(file.path) && <button onClick={() => prepareLoad(file)}>准备加载代码</button>}</div>)}</div>{files.length === 0 && <p>此目录暂无可展示数据。可从本机导入文件，或将数据放入项目目录后刷新。</p>}{truncated && <p>当前目录只展示前 300 项，请进入具体子目录查看。</p>}{preview && <details open><summary>{preview.path} · {(preview.bytes / 1024).toFixed(1)} KiB</summary>{preview.text === undefined ? <p>二进制科研文件不作文本预览，可准备加载代码后检查。</p> : <pre className="oss-output">{preview.text}</pre>}{preview.truncated && <p>仅预览文件开头 64 KiB。</p>}</details>}<p><small>加载按钮只准备代码；批准运行后才读取数据。隐藏目录、外部符号链接和 Host 凭据不会在这里展示。</small></p></article>
}

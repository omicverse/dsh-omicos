import { useEffect, useState } from 'react'
import { api } from './oss-api.js'
import type { RuntimeCapabilities as Capabilities } from '../oss/capabilities.js'
const labels = { available: '已实现', configured: '已配置 · 待环境核对', optional: '可选服务', unavailable: '尚未实现 / 当前不可用', unverified: '尚未验证' }
export function RuntimeCapabilities(): JSX.Element {
  const [open, setOpen] = useState(false); const [version, setVersion] = useState(0); const [result, setResult] = useState<Capabilities>(); const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    const controller = new AbortController(); setError(''); setResult(undefined)
    void api<Capabilities>('capabilities', undefined, controller.signal).then(value => { if (!controller.signal.aborted) setResult(value) }, error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)) })
    return () => controller.abort()
  }, [open, version])
  return <details className="oss-card oss-capabilities" onToggle={event => setOpen(event.currentTarget.open)}><summary>运行时能力与协议诊断</summary><p>此清单不启动 Python/R、不安装依赖，也不查询云端。已配置的环境仍需在项目环境面板核对。</p>{error && <p role="alert" className="oss-error">{error}</p>}{result ? <><p>OmicOS OSS {result.runtimeVersion} · {result.backend} · 协议 {result.protocol.minimum}–{result.protocol.maximum}</p><div className="oss-table-wrap"><table><thead><tr><th>能力</th><th>当前状态</th><th>范围与条件</th></tr></thead><tbody>{result.features.map(feature => <tr key={feature.id}><td><code>{feature.id}</code></td><td>{labels[feature.state] || feature.state}</td><td>{feature.description}{feature.requires?.length ? <p>需要：{feature.requires.join(' · ')}</p> : null}{feature.limits?.map(limit => <p key={limit}>{limit}</p>)}</td></tr>)}</tbody></table></div></> : !error && open ? <p>正在读取本机能力…</p> : null}<button onClick={() => setVersion(value => value + 1)}>刷新能力诊断</button></details>
}

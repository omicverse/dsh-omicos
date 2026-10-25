import { useEffect, useRef, useState } from 'react'
import { api } from './oss-api.js'
import type { RemoteImport } from '../oss/remote-import-types.js'
type Listing = {
  entries: Array<
    Pick<
      RemoteImport,
      | 'id'
      | 'target'
      | 'state'
      | 'received'
      | 'total'
      | 'sha256'
      | 'expectedSha256'
      | 'uploadId'
      | 'updatedAt'
      | 'error'
    > & { source: string; resumable: boolean }
  >
  next?: number
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
export function RemoteImportPane({
  projectId,
  directory,
  visible,
  committed
}: {
  projectId: string
  directory: string
  visible: boolean
  committed: () => Promise<void>
}): JSX.Element {
  const prefix = `project/${projectId}/remote-import-`
  const [expanded, setExpanded] = useState(false),
    [url, setUrl] = useState(''),
    [origins, setOrigins] = useState(''),
    [name, setName] = useState(''),
    [size, setSize] = useState(''),
    [expected, setExpected] = useState(''),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [listing, setListing] = useState<Listing>({ entries: [] }),
    [before, setBefore] = useState<number>(),
    [id, setId] = useState(''),
    [record, setRecord] = useState<RemoteImport>(),
    [lookup, setLookup] = useState('')
  useEffect(() => setApproved(false), [directory])
  const operation = useRef<{ key: string; id: string }>(),
    refreshed = useRef(new Set<string>())
  const operationId = (request: unknown) => {
    const key = JSON.stringify(request)
    if (operation.current?.key !== key)
      operation.current = { key, id: crypto.randomUUID() }
    return operation.current.id
  }
  useEffect(() => {
    if (!visible || !expanded) return
    const controller = new AbortController()
    let pending = false
    const read = async () => {
      if (pending) return
      pending = true
      try {
        const list = await api<Listing>(
          `${prefix}list${before ? `?before=${before}` : ''}`,
          undefined,
          controller.signal
        )
        if (!controller.signal.aborted) setListing(list)
        if (id) {
          const current = await api<RemoteImport>(
            `${prefix}document?id=${encodeURIComponent(id)}`,
            undefined,
            controller.signal
          )
          if (!controller.signal.aborted) {
            setRecord(current)
            if (
              current.state === 'completed' &&
              !refreshed.current.has(current.id)
            ) {
              await committed()
              refreshed.current.add(current.id)
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(message(error))
      } finally {
        pending = false
      }
    }
    void read()
    const timer = window.setInterval(() => void read(), 1000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [prefix, before, id, visible, expanded, committed])
  const action = async (task: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  const edit = () => setApproved(false)
  const start = () =>
    void action(async () => {
      if (!approved) throw Error('请确认访问来源与导入目标')
      const source = new URL(url)
      const request = {
        url: source.href,
        allowedOrigins: [
          source.origin,
          ...origins.split(/[\s,]+/).filter(Boolean)
        ],
        directory,
        name,
        ...(size.trim() ? { expectedBytes: Number(size) } : {}),
        ...(expected.trim() ? { expectedSha256: expected.trim() } : {})
      }
      const current = await api<RemoteImport>(`${prefix}start`, {
        confirmed: true,
        import: { ...request, operationId: operationId(request) }
      })
      setId(current.id)
      setRecord(current)
      setApproved(false)
      setBefore(undefined)
    })
  const command = (command: 'resume' | 'pause' | 'cancel') =>
    void action(async () => {
      if (!record) return
      if (
        command === 'cancel' &&
        !window.confirm(
          '取消这次远程导入并删除私有暂存？已提交的项目文件不会删除。'
        )
      )
        return
      if (command === 'resume' && !approved)
        throw Error('恢复会重新访问原来源，请先确认')
      const current = await api<RemoteImport>(`${prefix}${command}`, {
        confirmed: true,
        id: record.id
      })
      setRecord(current)
      if (command === 'resume') setApproved(false)
    })
  return (
    <section aria-label="远程数据导入">
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>从远程地址导入数据</summary>
        <p>
          由本机访问 HTTPS 来源，分块保存并计算完整
          SHA-256，校验后发布到项目。每文件最多 10
          GiB，不覆盖同名文件，不自动解压、加载或执行。OmicOS 云账号令牌和浏览器
          Cookie 不会发送到下载来源。
        </p>
        {error && (
          <p role="alert" className="oss-error">
            {error}
          </p>
        )}
        <p>
          新导入目录：<code>/{directory}</code>
        </p>
        <label>
          数据 HTTPS 地址
          <input
            aria-label="远程数据 HTTPS 地址"
            maxLength={4000}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              edit()
            }}
          />
        </label>
        <label>
          额外允许跳转的 HTTPS 来源（每行一个来源，不填路径）
          <textarea
            aria-label="远程数据允许跳转来源"
            value={origins}
            onChange={(event) => {
              setOrigins(event.target.value)
              edit()
            }}
            placeholder="https://release-assets.githubusercontent.com"
            maxLength={12000}
          />
        </label>
        <label>
          导入文件名
          <input
            aria-label="远程数据目标文件名"
            maxLength={240}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              edit()
            }}
          />
        </label>
        <label>
          独立来源的预期字节数（可选）
          <input
            aria-label="远程数据预期字节数"
            inputMode="numeric"
            value={size}
            onChange={(event) => {
              setSize(event.target.value)
              edit()
            }}
          />
        </label>
        <label>
          独立来源的 SHA-256（可选）
          <input
            aria-label="远程数据预期 SHA-256"
            maxLength={64}
            value={expected}
            onChange={(event) => {
              setExpected(event.target.value)
              edit()
            }}
          />
        </label>
        <p>
          <small>
            未提供预期哈希时，收据只证明实际下载的字节，并未与独立发布的校验和比对。断点续传要求来源提供强
            ETag 和稳定长度；来源改变时保留暂存并停止，不会默默从头替换。
          </small>
        </p>
        <label className="oss-checkbox">
          <input
            aria-label="批准访问远程数据来源"
            type="checkbox"
            checked={approved}
            onChange={(event) => setApproved(event.target.checked)}
          />
          我已核对地址、目标与可选校验和，批准从新地址下载，或恢复当前记录的原地址
        </label>
        <button
          className="oss-primary"
          disabled={busy || !approved || !url.trim() || !name.trim()}
          onClick={start}
        >
          批准下载新数据文件
        </button>
        <div className="oss-toolbar">
          <button
            disabled={busy || !before}
            onClick={() => setBefore(undefined)}
          >
            远程导入第一页
          </button>
          <button
            disabled={busy || !listing.next}
            onClick={() => setBefore(listing.next)}
          >
            更早的远程导入
          </button>
        </div>
        <label>
          远程导入记录
          <select
            aria-label="远程导入记录"
            value={id}
            onChange={(event) => {
              setId(event.target.value)
              setRecord(undefined)
              setApproved(false)
            }}
          >
            <option value="">选择导入记录</option>
            {id && !listing.entries.some((item) => item.id === id) && (
              <option value={id}>{id}</option>
            )}
            {listing.entries.map((item) => (
              <option key={item.id} value={item.id}>
                {item.target} · {item.state} · {item.received}/
                {item.total ?? '?'} B
              </option>
            ))}
          </select>
        </label>
        <div className="oss-toolbar">
          <label>
            完整记录编号
            <input
              aria-label="远程导入完整编号"
              maxLength={150}
              value={lookup}
              onChange={(event) => setLookup(event.target.value)}
            />
          </label>
          <button
            disabled={busy || !lookup.trim()}
            onClick={() => {
              setId(lookup.trim())
              setRecord(undefined)
              setApproved(false)
            }}
          >
            读取指定远程导入
          </button>
        </div>
        {record && (
          <section aria-label="远程导入详情">
            <strong data-remote-import-state>{record.state}</strong>
            <p>
              来源：
              <code>
                {(() => {
                  const source = new URL(record.resolvedUrl || record.url)
                  return source.origin + source.pathname
                })()}
              </code>
              <br />
              原目标：<code>{record.target}</code>
              <br />
              已持久化：
              <span data-remote-import-received>{record.received}</span> /{' '}
              {record.total ?? '未知'} B<br />
              编号：<code>{record.id}</code>
            </p>
            {record.error && <p className="oss-note">{record.error}</p>}
            {record.sha256 && (
              <p>
                实际 SHA-256：
                <code data-remote-import-sha256>{record.sha256}</code>
                <br />
                {record.expectedSha256
                  ? record.state === 'completed'
                    ? '已与预期 SHA-256 匹配'
                    : '提交前仍需确认预期哈希'
                  : '未提供独立预期哈希，仅记录传输字节'}
              </p>
            )}
            <details>
              <summary>来源与导入收据</summary>
              <pre>
                {JSON.stringify(
                  {
                    id: record.id,
                    source: (() => {
                      const source = new URL(record.url)
                      return source.origin + source.pathname
                    })(),
                    allowedOrigins: record.allowedOrigins,
                    target: record.target,
                    etag: record.etag,
                    total: record.total,
                    received: record.received,
                    expectedBytes: record.expectedBytes,
                    expectedSha256: record.expectedSha256,
                    sha256: record.sha256,
                    uploadId: record.uploadId,
                    createdAt: record.createdAt,
                    updatedAt: record.updatedAt
                  },
                  null,
                  2
                )}
              </pre>
            </details>
            <button
              disabled={busy || record.state !== 'downloading'}
              onClick={() => command('pause')}
            >
              暂停远程下载
            </button>
            <button
              disabled={
                busy ||
                !approved ||
                !['paused', 'failed'].includes(record.state)
              }
              onClick={() => command('resume')}
            >
              批准恢复原来源下载
            </button>
            <button
              disabled={
                busy ||
                ['publishing', 'completed', 'canceled'].includes(record.state)
              }
              onClick={() => command('cancel')}
            >
              取消远程导入并清理暂存
            </button>
            <p>
              <small>
                刷新页面不会自动恢复网络请求。正在发布时需等待完整导入收据；完成后的收据记录导入时的字节，后续分析仍可能修改项目文件。
              </small>
            </p>
          </section>
        )}
      </details>
    </section>
  )
}

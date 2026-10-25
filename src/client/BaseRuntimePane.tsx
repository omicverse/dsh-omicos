import { useEffect, useRef, useState } from 'react'
import { api } from './oss-api.js'
import type {
  BaseRuntimeInstall,
  BaseRuntimeSelection,
  BaseRuntimeSpec
} from '../oss/base-runtime-types.js'
type Listing = {
  entries: Array<
    Pick<BaseRuntimeInstall, 'id' | 'state' | 'downloaded' | 'error'> & {
      title: string
      version: string
      bytes: number
    }
  >
  selection: BaseRuntimeSelection
  next?: number
  platform: string
  arch: string
  installSupported: boolean
  operatorOverride: boolean
  currentInterpreter: string
  currentUnavailable?: string
  catalog: BaseRuntimeSpec[]
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
export function BaseRuntimePane({
  visible
}: {
  visible: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(false),
    [listing, setListing] = useState<Listing>(),
    [before, setBefore] = useState<number>(),
    [descriptor, setDescriptor] = useState(''),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [selected, setSelected] = useState(''),
    [record, setRecord] = useState<BaseRuntimeInstall>(),
    [choice, setChoice] = useState(''),
    [history, setHistory] = useState<BaseRuntimeSelection[]>([]),
    [historyBefore, setHistoryBefore] = useState<number>()
  const initialized = useRef(false)
  const operation = useRef<{ key: string; id: string }>()
  const operationId = (request: unknown) => {
    const key = JSON.stringify(request)
    if (operation.current?.key !== key)
      operation.current = { key, id: crypto.randomUUID() }
    return operation.current.id
  }
  const readList = async () => {
    const result = await api<Listing>(
      `base-runtime-list${before ? `?before=${before}` : ''}`
    )
    setListing(result)
    return result
  }
  useEffect(() => {
    if (!expanded || !visible) return
    const controller = new AbortController()
    let pending = false
    const read = async () => {
      if (pending) return
      pending = true
      try {
        const list = await api<Listing>(
          `base-runtime-list${before ? `?before=${before}` : ''}`,
          undefined,
          controller.signal
        )
        if (!controller.signal.aborted) {
          setListing(list)
          if (!initialized.current) {
            initialized.current = true
            setChoice(list.selection.runtimeId || '')
          }
        }
        if (selected) {
          const value = await api<BaseRuntimeInstall>(
            `base-runtime-document?id=${encodeURIComponent(selected)}`,
            undefined,
            controller.signal
          )
          if (!controller.signal.aborted) setRecord(value)
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(message(error))
      } finally {
        pending = false
      }
    }
    void read()
    const timer = window.setInterval(() => void read(), 2000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [expanded, visible, before, selected])
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
  const install = () =>
    void action(async () => {
      if (!approved) throw Error('请确认信任发行来源')
      const spec = JSON.parse(descriptor) as BaseRuntimeSpec
      const value = await api<BaseRuntimeInstall>('base-runtime-install', {
        spec,
        operationId: operationId({ install: spec }),
        confirmed: true
      })
      setSelected(value.id)
      setRecord(value)
      setApproved(false)
      await readList()
    })
  return (
    <section aria-label="基础 Python 运行时">
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>基础 Python 运行时 · 按需下载</summary>
        <p>
          无需预装 Python。下载独立发行包，核对精确大小和
          SHA-256，检查解压路径后运行解释器验证。安装包以当前系统用户权限运行；只批准你信任的来源。安装完成后还需选择并重启
          Host，科研包在独立项目环境中安装。
        </p>
        {error && (
          <p className="oss-error" role="alert">
            {error}
          </p>
        )}
        {listing && (
          <>
            <p>
              Host：{listing.platform} / {listing.arch}
              <br />
              当前解释器：<code>{listing.currentInterpreter}</code>
              <br />
              下次启动基础运行时：
              <code>
                {listing.selection.runtimeId || '外部 Python（默认 python3）'}
              </code>{' '}
              · 修订 {listing.selection.revision}
            </p>
            {listing.operatorOverride && (
              <p>
                当前 Host 显式指定了
                Python。沿用相同启动配置时，这里的基础选择不会启用；清空 Harness
                的 Python 配置或移除 --python 后再重启。
              </p>
            )}
            {listing.currentUnavailable && (
              <p className="oss-error" role="alert">
                {listing.currentUnavailable}
              </p>
            )}
            {listing.catalog.map((spec) => (
              <button
                key={spec.sha256}
                disabled={busy}
                onClick={() => {
                  setDescriptor(JSON.stringify(spec, null, 2))
                  setApproved(false)
                }}
              >
                填写 {spec.title} 的锁定清单
              </button>
            ))}
          </>
        )}
        <label>
          发行清单 JSON
          <textarea
            aria-label="基础 Python 发行清单 JSON"
            className="oss-code"
            value={descriptor}
            onChange={(event) => {
              setDescriptor(event.target.value)
              setApproved(false)
            }}
            spellCheck={false}
            maxLength={20000}
          />
        </label>
        <p>
          清单固定版本、平台、下载地址、允许跳转的 HTTPS
          来源、精确字节数、SHA-256、解释器路径和许可证。也可填写绝对路径{' '}
          <code>archiveFile</code> 安装离线归档；校验规则相同。当前支持 macOS /
          Linux，Windows 与 R 基础发行包尚未接入。
        </p>
        <label className="oss-checkbox">
          <input
            type="checkbox"
            aria-label="信任基础 Python 发行来源"
            checked={approved}
            onChange={(event) => setApproved(event.target.checked)}
          />
          我已核对发行来源、哈希与许可证，批准下载和运行此解释器进行验证
        </label>
        <button
          className="oss-primary"
          disabled={
            busy ||
            !approved ||
            !descriptor.trim() ||
            !listing?.installSupported
          }
          onClick={install}
        >
          批准安装基础 Python
        </button>
        <div className="oss-toolbar">
          <button
            disabled={busy || !before}
            onClick={() => setBefore(undefined)}
          >
            安装记录第一页
          </button>
          <button
            disabled={busy || !listing?.next}
            onClick={() => setBefore(listing?.next)}
          >
            更早的基础运行时
          </button>
        </div>
        <label>
          基础运行时安装记录
          <select
            aria-label="基础运行时安装记录"
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value)
              setRecord(undefined)
            }}
          >
            <option value="">选择安装记录</option>
            {selected &&
              !listing?.entries.some((item) => item.id === selected) && (
                <option value={selected}>{selected}</option>
              )}
            {listing?.entries.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {item.state} · {item.downloaded}/{item.bytes}{' '}
                bytes
              </option>
            ))}
          </select>
        </label>
        {record && (
          <section aria-label="基础运行时安装详情">
            <strong data-base-runtime-state>{record.state}</strong>
            <p>
              <code>{record.id}</code>
              <br />
              <code>{record.interpreter}</code>
              <br />
              下载：{record.downloaded} / {record.spec.bytes} bytes
            </p>
            {record.error && (
              <p className="oss-error" role="alert">
                {record.error}
              </p>
            )}
            <details>
              <summary>来源、许可证与验证记录</summary>
              <pre>
                {JSON.stringify(
                  {
                    spec: record.spec,
                    manifestSha256: record.manifestSha256,
                    files: record.files,
                    unpackedBytes: record.unpackedBytes,
                    probe: record.probe
                  },
                  null,
                  2
                )}
              </pre>
            </details>
            <button
              disabled={
                busy ||
                !['downloading', 'extracting', 'verifying'].includes(
                  record.state
                )
              }
              onClick={() =>
                void action(async () => {
                  setRecord(
                    await api('base-runtime-cancel', {
                      id: record.id,
                      confirmed: true
                    })
                  )
                  await readList()
                })
              }
            >
              取消基础运行时安装
            </button>
            <button
              disabled={
                busy ||
                !['failed', 'canceled', 'interrupted'].includes(record.state)
              }
              onClick={() =>
                void action(async () => {
                  if (
                    !window.confirm(
                      '删除此次未完成安装的归档和解压文件？安装记录仍会保留。'
                    )
                  )
                    return
                  setRecord(
                    await api('base-runtime-remove', {
                      id: record.id,
                      confirmed: true
                    })
                  )
                  await readList()
                })
              }
            >
              清理此次未完成安装
            </button>
          </section>
        )}
        <h3>选择下次 Host 的基础 Python</h3>
        <p>
          当前内核继续使用原解释器。显式配置的 Python
          优先于这里的选择；项目已选择的独立 venv
          仍保留。选择时与下次启动时都会校验完整文件清单，文件漂移会阻止执行并保留回滚入口。
        </p>
        <label>
          下次基础运行时
          <select
            aria-label="下次基础 Python 运行时"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">回退到外部 Python</option>
            {choice && !listing?.entries.some((item) => item.id === choice) && (
              <option value={choice}>{choice}</option>
            )}
            {listing?.entries
              .filter((item) => item.state === 'ready')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.id.slice(0, 8)}
                </option>
              ))}
          </select>
        </label>
        <label>
          或填写历史 ready 运行时编号
          <input
            aria-label="历史基础 Python 运行时编号"
            maxLength={150}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
          />
        </label>
        <button
          disabled={busy || !listing}
          onClick={() =>
            void action(async () => {
              if (!listing) return
              const selection = {
                revision: listing.selection.revision,
                runtimeId: choice || null
              }
              await api('base-runtime-select', {
                selection: {
                  ...selection,
                  operationId: operationId({ select: selection })
                },
                confirmed: true
              })
              await readList()
            })
          }
        >
          批准保存下次基础运行时
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const page = await api<{
                entries: BaseRuntimeSelection[]
                next?: number
              }>('base-runtime-history')
              setHistory(page.entries)
              setHistoryBefore(page.next)
            })
          }
        >
          读取基础运行时选择历史
        </button>
        {history.length > 0 && (
          <details open>
            <summary>基础运行时选择修订</summary>
            <pre>{JSON.stringify(history, null, 2)}</pre>
            <button
              disabled={busy || !historyBefore}
              onClick={() =>
                void action(async () => {
                  const page = await api<{
                    entries: BaseRuntimeSelection[]
                    next?: number
                  }>(`base-runtime-history?before=${historyBefore}`)
                  setHistory(page.entries)
                  setHistoryBefore(page.next)
                })
              }
            >
              更早的基础运行时选择
            </button>
          </details>
        )}
      </details>
    </section>
  )
}

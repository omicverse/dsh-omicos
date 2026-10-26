import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './oss-api.js'
import { normalizeAnnDataPlot, plotAnnDataCode } from '../oss/anndata.js'
import type { AnnDataPlot } from '../oss/anndata.js'
import type { Execution, Variable } from '../oss/types.js'
interface Audit { variable: string; shape: number[]; obs_columns: string[]; obs_schema?: Array<{ name: string; dtype: string }>; layers: string[]; obsm: string[]; embedding_shapes?: Record<string, number[]>; raw_shape: number[] | null; transform_state: string }
const stopped = new Set(['succeeded', 'failed', 'canceled', 'interrupted'])
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export function AnnDataExplorer({ projectId, variables, visible }: { projectId: string; variables: Variable[]; visible: boolean }): JSX.Element {
  const prefix = `project/${projectId}/`
  const [variable, setVariable] = useState('adata'); const variableRef = useRef(variable); variableRef.current = variable
  const [audit, setAudit] = useState<{ data: Audit; generation?: string }>()
  const [plot, setPlot] = useState<AnnDataPlot['plot']>('embedding'); const [embedding, setEmbedding] = useState('X_umap'); const [axes, setAxes] = useState<[number, number]>([0, 1])
  const [color, setColor] = useState<AnnDataPlot['color']>('none'); const [field, setField] = useState(''); const [source, setSource] = useState<AnnDataPlot['source']>('X'); const [layer, setLayer] = useState(''); const [maxPoints, setMaxPoints] = useState(5000); const [seed, setSeed] = useState(0)
  const [features,setFeatures]=useState('');const [groupBy,setGroupBy]=useState('');const [threshold,setThreshold]=useState(0)
  const [current, setCurrent] = useState<{ kind: 'inspect' | 'plot'; variable: string; execution: Execution }>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const pending = useRef<{ key: string; operationId: string }>()
  const active = Boolean(current && !stopped.has(current.execution.state))
  const inspected = audit?.data.variable === variable ? audit : undefined
  const proposal = useMemo(() => { try { const settings = normalizeAnnDataPlot({ variable, plot, embedding, axes, color, field, source, layer, maxPoints, seed,features:features.split('\n').filter(value=>value.length>0),groupBy,threshold }); return { settings, code: plotAnnDataCode(settings) } } catch (error) { return { error: message(error) } } }, [variable, plot, embedding, axes, color, field, source, layer, maxPoints, seed,features,groupBy,threshold])
  useEffect(() => {
    if (!current || !active || !visible) return
    const controller = new AbortController(); const id = current.execution.id; let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        if (document.hidden) { timer = setTimeout(poll, 2000); return }
        const execution = await api<Execution>(`${prefix}execution?id=${encodeURIComponent(id)}`, undefined, controller.signal)
        if (controller.signal.aborted) return
        setCurrent(value => value?.execution.id === id ? { ...value, execution } : value)
        if (stopped.has(execution.state)) {
          return
        }
      } catch (error) { if (controller.signal.aborted) return; setError(message(error)) }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1000)
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer) }
  }, [prefix, current?.execution.id, active, visible])
  const adopted = useRef('')
  useEffect(() => {
    if (!current || !stopped.has(current.execution.state) || adopted.current === current.execution.id) return
    adopted.current = current.execution.id
    if (current.execution.state !== 'succeeded') { setError(current.execution.error || current.execution.state); return }
    setError('')
    if (current.kind !== 'inspect' || variableRef.current !== current.variable) return
    try { const data = JSON.parse(current.execution.output.trim()) as Audit; if (data.variable !== current.variable) throw new Error('Inspection receipt does not match the selected variable'); setAudit({ data, generation: current.execution.kernelGeneration }); const available = data.obsm.find(key => (data.embedding_shapes?.[key]?.[1] || 0) >= 2); if (available) setEmbedding(available) }
    catch (error) { setError(message(error)) }
  }, [current?.execution.id, current?.execution.state])
  const submit = async (kind: 'inspect' | 'plot') => {
    if (busy || active) return
    setBusy(true); setError('')
    try {
      if (kind === 'plot' && (!inspected || !proposal.settings)) throw new Error(proposal.error || '先批准检查当前 Python 对象')
      if (kind === 'inspect') setAudit(undefined)
      const body = kind === 'inspect' ? { variable } : { settings: proposal.settings, expectedGeneration: inspected?.generation }
      const key = JSON.stringify([kind, body]); const operation = pending.current?.key === key ? pending.current : { key, operationId: crypto.randomUUID() }; pending.current = operation
      const execution = await api<Execution>(`${prefix}${kind === 'inspect' ? 'anndata' : 'anndata-plot'}`, { ...body, operationId: operation.operationId, confirmed: true })
      pending.current = undefined; setCurrent({ kind, variable, execution })
    } catch (error) { setError(`${message(error)}。若提交结果未知，保持选项重试会复用原请求编号。`) } finally { setBusy(false) }
  }
  const plotAudit = current?.kind === 'plot' && current.execution.state === 'succeeded' ? current.execution.output.split('\n').find(line => line.startsWith('OMICOS_ANNDATA_PLOT='))?.slice('OMICOS_ANNDATA_PLOT='.length) : undefined
  return <article className="oss-card oss-anndata-explorer" aria-label="AnnData 数据探索"><div className="oss-row"><div><small>EXISTING DATA · EXPLICIT PREVIEW</small><h2>AnnData 数据探索</h2></div><span className="oss-chip">Python 共享内核</span></div><p>探索已有嵌入、分组、单特征分布和多特征点图。采样只影响这次预览，不筛选或改写对象；不会自动计算降维、归一化或取对数。图像是探索性结果，细胞数量不能替代生物学重复。</p>{error && <p role="alert" className="oss-error">{error}</p>}
    <div className="oss-toolbar"><label>AnnData 变量<input aria-label="AnnData 变量" list={`anndata-vars-${projectId}`} value={variable} maxLength={100} onChange={event => { setVariable(event.target.value); setError('') }} /></label><datalist id={`anndata-vars-${projectId}`}>{variables.filter(item => item.type === 'AnnData').map(item => <option key={item.name} value={item.name} />)}</datalist><button disabled={busy || active || !variable.trim()} onClick={() => void submit('inspect')}>批准检查 AnnData 对象</button></div>
    {inspected && <><p>检查回执（后续代码可能改变对象；图形以实际运行时的数据为准）· {inspected.data.shape.join(' × ')} · {inspected.data.transform_state}</p><div className="oss-form-grid"><label>预览图类型<select aria-label="AnnData 图类型" value={plot} onChange={event => {setPlot(event.target.value as typeof plot);if(event.target.value==='dotplot'||(['boxplot','violin'].includes(event.target.value)&&color==='none'))setColor('feature')}}><option value="embedding">已有嵌入散点图</option><option value="distribution">观测值分布 / 分类计数</option><option value="dotplot">分组多特征点图</option><option value="boxplot">分组数值箱线图</option><option value="violin">分组数值小提琴图</option></select></label>{plot === 'embedding' && <><label>已有嵌入<select aria-label="AnnData 嵌入" value={embedding} onChange={event => setEmbedding(event.target.value)}>{inspected.data.obsm.map(key => <option key={key} value={key}>{key} · {inspected.data.embedding_shapes?.[key]?.join(' × ') || '尺寸未知'}</option>)}</select></label>{[0, 1].map(index => <label key={index}>坐标维度 {index + 1}（从 1 开始）<input aria-label={`AnnData 坐标维度 ${index + 1}`} type="number" min={1} max={1024} value={axes[index] + 1} onChange={event => setAxes(value => index === 0 ? [Number(event.target.value) - 1, value[1]] : [value[0], Number(event.target.value) - 1])} /></label>)}</>}
    {plot==='dotplot'&&<label>每行一个精确特征 ID<textarea aria-label="AnnData 点图特征" maxLength={5000} value={features} onChange={event=>setFeatures(event.target.value)} placeholder={'g1\ng2'}/></label>}{['dotplot','boxplot','violin'].includes(plot)&&<label>分类分组 obs 字段<select aria-label={plot==='dotplot'?'AnnData 点图分组':'AnnData 分布分组'} value={groupBy} onChange={event=>setGroupBy(event.target.value)}><option value="">选择分类、字符串或布尔字段</option>{inspected.data.obs_columns.map(name=><option key={name} value={name}>{name}</option>)}</select></label>}{plot==='dotplot'&&<label>严格大于此值（所选矩阵原始单位）<input aria-label="AnnData 点图阈值" type="number" step="any" value={threshold} onChange={event=>setThreshold(Number(event.target.value))}/></label>}
    {plot!=='dotplot'&&<label>着色 / 分布字段<select aria-label="AnnData 着色方式" value={color} onChange={event => { setColor(event.target.value as typeof color); setField('') }}><option value="none">不着色</option><option value="obs">obs 元数据</option><option value="feature">单个特征表达</option></select></label>}{plot!=='dotplot'&&color === 'obs' && <label>obs 字段<select aria-label="AnnData obs 字段" value={field} onChange={event => setField(event.target.value)}><option value="">选择字段</option>{Array.from(new Set(inspected.data.obs_columns)).map(name => <option key={name} value={name}>{name} · {inspected.data.obs_schema?.find(item => item.name === name)?.dtype || '类型待核对'}</option>)}</select></label>}{color === 'feature' && <>{plot!=='dotplot'&&<label>特征 ID<input aria-label="AnnData 特征 ID" value={field} maxLength={200} onChange={event => setField(event.target.value)} /></label>}<label>表达矩阵来源<select aria-label="AnnData 表达来源" value={source} onChange={event => setSource(event.target.value as typeof source)}><option value="X">X（变换状态未知）</option><option value="layer">指定 layer</option><option value="raw" disabled={!inspected.data.raw_shape}>raw.X</option></select></label>{source === 'layer' && <label>layer<select aria-label="AnnData layer" value={layer} onChange={event => setLayer(event.target.value)}><option value="">选择 layer</option>{inspected.data.layers.map(name => <option key={name} value={name}>{name}</option>)}</select></label>}</>}
    <label>最多采样观测值<input aria-label="AnnData 采样上限" type="number" min={1} max={10000} value={maxPoints} onChange={event => setMaxPoints(Number(event.target.value))} /></label><label>采样种子<input aria-label="AnnData 采样种子" type="number" min={0} max={2147483647} value={seed} onChange={event => setSeed(Number(event.target.value))} /></label></div>{plot==='dotplot'&&<p>最多 20 个唯一特征、20 个采样分组。颜色为有限数值均值，点面积为有限值中严格大于阈值的比例；比例为零时不画点；缺失分组排除、全非有限值的格子标灰叉。不会把点图当作差异表达或生物学重复证据，也不会为连续分组值自动分箱。</p>}{['boxplot','violin'].includes(plot)&&<p>选择数值 obs 或单个特征及分类分组。箱线图使用线性分位数、1.5×IQR 须线并保留离群点；小提琴使用 Scott 带宽的高斯密度（100 个坐标），各组宽度按自身峰值缩放，不代表组规模。单值/常量组显示线标记，非有限值排除并计数，全缺失组注明。有限样本量不等于生物学重复；不进行假设检验或自动变换。</p>}<p>均匀无放回采样，最多 10000 个点；预览中分类超过 20 类会拒绝，需明确选择更合适的字段。散点图以灰色标出缺失或非有限着色值，非有限坐标不绘制；直方图排除非有限数值，分类计数单独列出缺失值，数量均记录在回执中。</p>{proposal.error && <p className="oss-note">{proposal.error}</p>}<details><summary>核对将要执行的预览代码</summary><pre>{proposal.code}</pre></details><button disabled={busy || active || !proposal.settings || (plot === 'embedding' && !inspected.data.obsm.includes(embedding))} onClick={() => void submit('plot')}>批准生成 AnnData 预览图</button></>}
    {current && <div className="oss-variable"><div className="oss-row"><strong>{current.kind === 'inspect' ? '对象检查' : '预览绘图'} · {current.execution.state}</strong>{active && <button onClick={() => void api(`${prefix}cancel`, { id: current.execution.id, language: 'python' }).catch(error => setError(message(error)))}>请求停止 AnnData 任务</button>}</div><code>{current.execution.id}</code>{current.execution.error && <pre className="oss-error">{current.execution.error}</pre>}{current.execution.artifacts.map(artifact => { const url = `/omicos/oss/api/${prefix}artifact?execution=${encodeURIComponent(current.execution.id)}&id=${encodeURIComponent(artifact.id)}`; return <figure key={artifact.id}>{artifact.mime === 'image/png' && <img src={url} alt="AnnData 实际预览图" />}<figcaption><a href={url} download>下载 {artifact.mime} ↗</a> · <code>{artifact.sha256}</code></figcaption></figure> })}{plotAudit && <details open><summary>采样与数据证据</summary><pre>{plotAudit}</pre><p>这些图可在 Figure Studio 选择此执行的产物归档。数据哈希只覆盖本次预览子集，不代表全矩阵验证。</p></details>}</div>}
  </article>
}

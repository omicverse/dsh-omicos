import { FigureAssembliesPane } from './FigureAssembliesPane.js'
import { DossierPane } from './DossierPane.js'
import { McpConnectionsPane } from './McpConnectionsPane.js'
import { MethodLibraryPane } from './MethodLibraryPane.js'
import { ManagedEnvironmentPane } from './ManagedEnvironmentPane.js'
import { ResearchPlanPane } from './ResearchPlanPane.js'
import { ExecutionHistory } from './ExecutionHistory.js'
import { AnnDataExplorer } from './AnnDataExplorer.js'
import { RuntimeCapabilities } from './RuntimeCapabilities.js'
import { CloudMemberships, CloudRenewalBanner, MEMBERSHIP_REFRESH } from './CloudMemberships.js'
import { FigureStudioPane } from './FigureStudioPane.js'
import { MemoryTreePane } from './MemoryTreePane.js'
import { PipelinePane } from './PipelinePane.js'
import { OrderHistory } from './OrderHistory.js'
import { NotebookPane } from './NotebookPane.js'
import { useScienceSnapshot } from './useScienceSnapshot.js'
import { DataBrowser } from './DataBrowser.js'
import { CloudManagement } from './CloudManagement.js'
import { EnvironmentPane } from './EnvironmentPane.js'
import { ScienceChat } from './ScienceChat.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { LabPricing, RecoveredOrder } from '../oss/commerce-types.js'
import type { ScienceSnapshot } from '../oss/types.js'
import { api, HOST_REFRESH_EVENT, type Session, type CloudAccount } from './oss-api.js'
import './oss.css'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const short = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path
interface Plan { code: string; name: string; display_name?: string; tagline?: string; monthly_price_rmb: number | null; quarterly_price_rmb?: number | null; yearly_price_rmb: number | null }
interface Checkout { recovery_warning?: string; order_no: string; amount_rmb: number; currency: string; provider: string; pay_url: string; expires_at: string }
interface Quote { selection?: string; confirmation: string; plan: string; catalog_amount_rmb: number | null; notice: string; checkout: { period: string; provider: string; seats?: number } }

function Store({ account, refresh, visible, domain, setDomain }: { account: CloudAccount; refresh: () => Promise<void>; visible: boolean; domain: string; setDomain: (domain: string) => void }): JSX.Element {
  const scopedApi = <T,>(path: string, data?: unknown, signal?: AbortSignal) => api<T>(path, data, signal, account)
  const [plans, setPlans] = useState<Plan[]>([])
  const [period, setPeriod] = useState('monthly')
  const [provider, setProvider] = useState('wechat')
  const [quote, setQuote] = useState<Quote>()
  const [order, setOrder] = useState<Checkout>()
  const [status, setStatus] = useState('')
  const [qr, setQr] = useState('')
  const [subscriptionResult, setSubscriptionResult] = useState<{ domain: string; value: any }>()
  const subscription = subscriptionResult?.domain === domain ? subscriptionResult.value : undefined
  const subscriptionRequest = useRef(0)
  const domainRef = useRef(domain); domainRef.current = domain
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [labPricing, setLabPricing] = useState<LabPricing>()
  const [labName, setLabName] = useState('')
  const [seats, setSeats] = useState(3)
  const [lookup, setLookup] = useState('')
  const [historyVersion, setHistoryVersion] = useState(0)
  const [recoveryNotice, setRecoveryNotice] = useState('')
  const recover = (result: RecoveredOrder) => { setOrder(result.payment); setStatus(result.status); setRecoveryNotice(result.recovery_warning || (result.payment ? '' : `订单 ${result.order_no}：${result.status}；本设备没有该订单的原始付款链接。`)) }
  const selection = JSON.stringify([domain, period, provider, seats, labName])
  const selectionRef = useRef(selection); selectionRef.current = selection
  const generation = useRef(account.generation)
  generation.current = account.generation
  const subscriptionRefresh = useCallback(async () => {
    if (!account.logged_in) { setSubscriptionResult(undefined); return }
    const original = account.generation; const request = ++subscriptionRequest.current
    try { const result = await scopedApi(`subscription?domain=${encodeURIComponent(domain)}`); if (generation.current === original && domainRef.current === domain && request === subscriptionRequest.current) setSubscriptionResult({ domain, value: result }) }
    catch (error) { if (generation.current === original && domainRef.current === domain && request === subscriptionRequest.current) setError(message(error)) }
  }, [account.generation, account.logged_in, domain])
  useEffect(() => {
    const controller = new AbortController()
    void scopedApi<{ plans: Plan[] }>(`plans?domain=${encodeURIComponent(domain)}`, undefined, controller.signal).then(result => setPlans(result.plans), error => { if (!controller.signal.aborted) setError(message(error)) })
    return () => controller.abort()
  }, [domain])
  useEffect(() => { setQuote(undefined); setOrder(undefined); setStatus(''); setError(''); setRecoveryNotice(''); void subscriptionRefresh() }, [account.generation, subscriptionRefresh])
  useEffect(() => { setQuote(undefined) }, [period, provider, domain, seats, labName])
  useEffect(() => {
    let alive = true; setQr('')
    if (order && /^(weixin:\/\/wxpay\/|https:\/\/qr\.alipay\.com\/)/.test(order.pay_url)) {
      void QRCode.toDataURL(order.pay_url, { width: 260, margin: 2, errorCorrectionLevel: 'M' }).then(data => { if (alive) setQr(data) })
    }
    return () => { alive = false }
  }, [order])
  useEffect(() => {
    if (!visible || !order || status === 'paid' || status === 'expired' || status === 'canceled') return
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const original = account.generation
    const poll = async () => {
      try {
        const result = await scopedApi<{ status: string }>(`order?id=${encodeURIComponent(order.order_no)}`, undefined, controller.signal)
        if (controller.signal.aborted || generation.current !== original) return
        setStatus(result.status); setError('')
        if (result.status === 'paid') { await subscriptionRefresh(); window.dispatchEvent(new Event(MEMBERSHIP_REFRESH)); await refresh(); return }
        if (result.status !== 'pending') return
      } catch (error) { if (!controller.signal.aborted && generation.current === original) setError(`订单查询暂时失败：${message(error)}；请勿重复付款。`) }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), document.hidden ? 10000 : 2500)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [order, status, account.generation, refresh, subscriptionRefresh, visible])
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError('')
    try { await action() } catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  const select = (plan: Plan) => void run(async () => {
    const original = account.generation; const chosen = selection
    const result = await scopedApi<Quote>('quote', { plan_code: plan.code, period, provider, ...(domain ? { domain } : {}), ...(plan.code === 'lab' ? { lab_name: labName, seats } : {}) })
    if (original === generation.current && selectionRef.current === chosen) setQuote({ ...result, selection: chosen })
  })
  const confirm = () => void run(async () => {
    if (!quote) return
    if (quote.selection !== selectionRef.current) throw new Error('套餐、服务域或购买选项已变化，请重新核对后生成订单')
    const original = account.generation; const confirmation = quote.confirmation
    setQuote(undefined)
    const result = await scopedApi<Checkout>('checkout', { confirmation })
    if (original !== generation.current) return
    setOrder(result); setStatus('pending'); setRecoveryNotice(result.recovery_warning || ''); setHistoryVersion(value => value + 1)
    sessionStorage.setItem(`omicos:last-order:${account.user?.id}`, result.order_no)
  })
  useEffect(() => {
    if (!account.logged_in) { setLabPricing(undefined); return }
    const controller = new AbortController()
    void scopedApi<LabPricing>('lab-pricing', undefined, controller.signal).then(setLabPricing, () => {})
    return () => controller.abort()
  }, [account.generation, account.logged_in])
  const price = (plan: Plan) => plan.code === 'lab' && labPricing ? period === 'quarterly' ? null : (period === 'yearly' ? labPricing.seat_price_yearly_rmb : labPricing.seat_price_monthly_rmb) * seats : period === 'monthly' ? plan.monthly_price_rmb : period === 'quarterly' ? plan.quarterly_price_rmb : plan.yearly_price_rmb
  return <section>
    <header id="oss-cloud-catalog" className="oss-section-head"><div><small>OMICOS CLOUD</small><h1>让算力与研究同行。</h1><p>本地分析自由使用。需要官方模型、云端资源或团队服务时，在这里接入。</p></div><span className="oss-chip">官方订阅商城</span></header>
    {error && <p role="alert" className="oss-error">{error}</p>}
    <div className="oss-toolbar">
      <label>订阅周期<select value={period} onChange={event => setPeriod(event.target.value)}><option value="monthly">月付</option><option value="quarterly">季付</option><option value="yearly">年付</option></select></label>
      <label>支付方式<select value={provider} onChange={event => setProvider(event.target.value)}><option value="wechat">微信支付</option><option value="alipay">支付宝</option></select></label>
      <label>服务域<input value={domain} placeholder="默认服务域" onChange={event => setDomain(event.target.value)} maxLength={80} /></label>
    </div>
    <div className="oss-plans">{plans.map(plan => <article className={`oss-plan ${plan.code === 'pro' ? 'oss-plan-featured' : ''}`} key={plan.code}>
      <small>{plan.code.toUpperCase()}</small><h2>{plan.display_name || plan.name}</h2><p>{plan.tagline}</p>
      <div className="oss-price">{typeof price(plan) === 'number' ? `¥${price(plan)}` : '联系官方'}<small> / {period === 'monthly' ? '月' : period === 'quarterly' ? '季' : '年'}</small></div>
      {plan.code === 'lab' && <><label>实验室名称<input value={labName} onChange={event => setLabName(event.target.value)} maxLength={200} /></label><label>席位数<input type="number" min={1} value={seats} onChange={event => setSeats(Number(event.target.value))} /></label></>}
      <button disabled={busy || !account.logged_in || (plan.code !== 'lab' && !(typeof price(plan) === 'number' && price(plan)! > 0))} onClick={() => select(plan)}>选择套餐</button>
    </article>)}</div>
    {!account.logged_in && <p className="oss-note">请先登录 OmicOS 云账号再购买。登录入口在页面右上角；本地科研功能无需登录。</p>}
    {quote && quote.selection === selection && <section className="oss-confirm" aria-label="订单确认"><h2>确认订阅</h2><p>服务域：{domain || '默认服务域'}{quote.checkout.seats ? ` · 实验室 ${labName}` : ''}</p><p>{quote.plan} · {quote.checkout.period} · {quote.checkout.provider === 'wechat' ? '微信支付' : '支付宝'}</p><p>目录金额：{quote.catalog_amount_rmb == null ? '由服务端核算' : `¥${quote.catalog_amount_rmb}`}{quote.checkout.seats ? `，${quote.checkout.seats} 个席位` : ''}</p><p>{quote.notice}</p><button className="oss-primary" disabled={busy} onClick={confirm}>确认并生成付款订单</button> <button onClick={() => setQuote(undefined)}>返回选择</button></section>}
    {recoveryNotice && <p role="status" className="oss-note">{recoveryNotice}</p>}
    {order && <section className="oss-payment"><div><small>PAYMENT ORDER</small><h2>{status === 'paid' ? '支付成功' : status === 'expired' ? '订单已过期' : status === 'canceled' ? '订单已取消' : status === 'pending' ? '扫码支付' : '订单状态待核对'}</h2><p className="oss-price">{order.currency} {order.amount_rmb}</p><p>订单号：<code>{order.order_no}</code></p><p>到期：{new Date(order.expires_at).toLocaleString()}</p><p>支付状态以服务端确认为准。关闭窗口不会取消订单。</p><button onClick={() => { setOrder(undefined); setStatus('') }}>收起订单</button></div>{status === 'pending' && (qr ? <img width={260} height={260} src={qr} alt={`${order.provider} 付款二维码`} /> : <p>付款链接格式暂不支持，请保留订单编号联系官方。</p>)}</section>}
    {account.logged_in && <CloudMemberships key={`${account.server}:${account.generation}`} account={account} visible={visible} onSelect={domain => { setDomain(domain); document.getElementById('oss-cloud-catalog')?.scrollIntoView({ behavior: 'smooth' }) }} />}
    {account.logged_in && <CloudManagement account={account} userId={account.user!.id} onOrder={result => { setOrder(result); setStatus('pending'); setRecoveryNotice(result.recovery_warning || ''); setHistoryVersion(value => value + 1) }} />}
    {account.logged_in && <OrderHistory version={historyVersion} onOpen={recover} />}
    <div className="oss-two"><article className="oss-card"><h2>我的订阅</h2>{subscription ? <><p>{subscription.active ? `当前：${subscription.subscription?.plan_code || subscription.plan_code}` : '暂无有效订阅'}</p>{subscription.subscription?.expires_at && <p>有效期至 {new Date(subscription.subscription.expires_at).toLocaleString()}</p>}{subscription.active && <button disabled={busy} onClick={() => { const action = subscription.cancelled || subscription.subscription?.cancelled_at ? 'uncancel' : 'cancel'; if (window.confirm(`${action === 'uncancel' ? '恢复' : '取消'} ${domain || '默认服务域'} 的后续续订？现有权益以服务端规则为准。`)) void run(async () => { await scopedApi('subscription/manage', { action, domain: domain || undefined, confirmed: true }); await subscriptionRefresh(); window.dispatchEvent(new Event(MEMBERSHIP_REFRESH)) }) }}>{subscription.cancelled || subscription.subscription?.cancelled_at ? '恢复订阅' : '取消续订'}</button>}</> : <p>{account.logged_in ? '正在查询…' : '登录后查看订阅'}</p>}<button disabled={!account.logged_in || busy} onClick={() => void run(subscriptionRefresh)}>刷新权益</button></article>
    <article className="oss-card"><h2>找回订单</h2><p>重新打开窗口后，可输入订单编号查询。查询失败时请勿重复付款。</p><input placeholder="订单编号" value={lookup} onChange={event => setLookup(event.target.value)} /><button disabled={!account.logged_in || busy || !lookup.trim()} onClick={() => void run(async () => { const result = await scopedApi<RecoveredOrder>(`order/reopen?id=${encodeURIComponent(lookup.trim())}`); recover(result) })}>查询订单状态</button><button disabled={!account.logged_in} onClick={() => setLookup(sessionStorage.getItem(`omicos:last-order:${account.user?.id}`) || '')}>最近订单</button></article></div>
  </section>
}

function Laboratory({ project, visible }: { visible: boolean; project: Session['projects'][number] }): JSX.Element {
  const [language, setLanguage] = useState<'python' | 'r'>('python')
  const { snapshot, error: streamError, connection, refresh: reload } = useScienceSnapshot(project.id, language)
  const [code, setCode] = useState("# 导入数据前，先查看环境与工作目录\nimport sys, os\nprint(sys.version)\nprint(os.getcwd())")
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [memory, setMemory] = useState('')
  const pendingExecution = useRef<{ operationId: string; code: string; language: 'python' | 'r' }>()
  const prefix = `project/${project.id}/`
  const execute = async () => {
    if (busy) return
    setBusy(true); setError('')
    const operation = pendingExecution.current?.code === code && pendingExecution.current.language === language ? pendingExecution.current : { operationId: crypto.randomUUID(), code, language }
    pendingExecution.current = operation
    try {
      await api(`${prefix}execute`, { ...operation, sessionId: 'workbench', confirmed: true })
      pendingExecution.current = undefined
      try { await reload() } catch { setError('任务已接收，状态同步暂时失败；请等待重新连接，避免重复执行。') }
    }
    catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  return <section><header className="oss-section-head"><div><small>RESEARCH WORKSPACE</small><h1>{short(project.workspace)}</h1><p>{project.workspace}</p></div><span className="oss-chip">Kernel · {snapshot?.kernel.state || '加载中'} · {connection === 'live' ? '实时同步' : connection === 'reconnecting' ? '重连中' : '连接中'}</span></header>
    {(error || streamError) && <p role="alert" className="oss-error">{error || streamError}</p>}
    <ScienceChat projectId={project.id} />
    <DataBrowser key={project.id} visible={visible} projectId={project.id} prepare={(nextLanguage, source) => { setLanguage(nextLanguage); setCode(source) }} />
    <AnnDataExplorer projectId={project.id} visible={visible} variables={language === 'python' ? snapshot?.variables || [] : []} />
    <FigureAssembliesPane key={`assemblies:${project.id}`} projectId={project.id} visible={visible} />
    <FigureStudioPane key={`figures:${project.id}`} projectId={project.id} visible={visible} />
    <MemoryTreePane key={`memory:${project.id}`} projectId={project.id} visible={visible} />
    <article className="oss-card"><ManagedEnvironmentPane key={`environment:${project.id}`} projectId={project.id} visible={visible} /></article>
    <ResearchPlanPane key={`plan:${project.id}`} projectId={project.id} visible={visible} executions={snapshot?.executions || []} />
    <McpConnectionsPane key={`mcp:${project.id}`} projectId={project.id} visible={visible} />
    <DossierPane key={`dossier:${project.id}`} projectId={project.id} visible={visible} />
    <MethodLibraryPane key={`methods:${project.id}`} projectId={project.id} visible={visible} />
    <PipelinePane projectId={project.id} visible={visible} />
    <ExecutionHistory projectId={project.id} language={language} visible={visible} />
    <NotebookPane projectId={project.id} language={language} executions={snapshot?.executions || []} onLanguage={setLanguage} refresh={reload} />
    <div className="oss-two oss-lab-grid"><div><article className="oss-card"><div className="oss-row"><h2>{language === 'r' ? 'R' : 'Python'} 工作单元</h2><a href={`/omicos/oss/api/${prefix}notebook?language=${language}`} download>导出 Notebook ↗</a></div><p>代码将在当前项目的持久进程中执行，拥有当前用户的系统权限。同语言的多次执行共享变量，Python 与 R 分别维护对象。</p><label>语言<select aria-label="语言" value={language} onChange={event => { const next = event.target.value as 'python' | 'r'; setLanguage(next); setCode(next === 'r' ? 'values <- c(1, 2, 3, 4)\nmean(values)' : 'import sys, os\nprint(sys.version)\nprint(os.getcwd())') }}><option value="python">Python</option><option value="r">R</option></select></label><label className="oss-sr" htmlFor="oss-code">代码</label><textarea id="oss-code" className="oss-code" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} /><div className="oss-row"><small>重启进程后保留执行记录，内存对象需要重新加载。</small><button className="oss-primary" disabled={busy || !code.trim()} onClick={() => void execute()}>{busy ? '提交中…' : `批准并运行 ${language === 'r' ? 'R' : 'Python'}`}</button></div></article>
    <h2 className="oss-list-title">最近执行记录</h2>{snapshot?.executionWindow?.hasMore && <p>当前快照展示最近 {snapshot.executionWindow.shown} 条，共 {snapshot.executionWindow.total} 条；完整回执可在“完整执行历史”中分页读取。</p>}{snapshot?.executions.slice().reverse().map(job => <article className="oss-card" key={job.id}><div className="oss-row"><span className="oss-chip">{job.state}</span><small>{new Date(job.createdAt).toLocaleString()}</small>{['queued', 'running'].includes(job.state) && <button onClick={() => void api(`${prefix}cancel`, { id: job.id, language }).then(reload).catch(error => setError(message(error)))}>取消</button>}</div><details><summary>查看代码与执行标识</summary><code>{job.id}</code>{job.environment && <p>运行环境：{job.environment.version}<br /><code>{job.environment.fingerprint}</code></p>}<pre>{job.code}</pre></details>{job.output && <pre className="oss-output">{job.output}</pre>}{job.error && <pre className="oss-error">{job.error}</pre>}{job.artifacts.map(artifact => <figure key={artifact.id}><a href={`/omicos/oss/api/${prefix}artifact?id=${encodeURIComponent(artifact.id)}&execution=${encodeURIComponent(job.id)}&language=${language}`} target="_blank" rel="noreferrer">{artifact.mime === 'image/png' || artifact.mime === 'image/jpeg' ? <img src={`/omicos/oss/api/${prefix}artifact?id=${encodeURIComponent(artifact.id)}&execution=${encodeURIComponent(job.id)}&language=${language}`} alt={artifact.path} /> : <span>下载 {artifact.mime} 文件 ↗</span>}</a><figcaption>{artifact.path}<br /><code>sha256: {artifact.sha256}</code></figcaption></figure>)}</article>)}</div>
    <aside><EnvironmentPane key={language} projectId={project.id} language={language} /><article className="oss-card"><h2>内核变量</h2>{snapshot?.variables.length ? snapshot.variables.map(variable => <div className="oss-variable" key={variable.name}><b>{variable.name}</b><small>{variable.type} {variable.shape}</small><code>{variable.preview}</code>{language === 'python' && variable.type === 'AnnData' && <button onClick={() => void api(`${prefix}anndata`, { variable: variable.name, confirmed: true, operationId: crypto.randomUUID() }).then(reload).catch(error => setError(message(error)))}>批准并检查 AnnData 状态</button>}</div>) : <p>执行后在这里查看数据对象。</p>}</article><article className="oss-card"><h2>项目记忆</h2><p>记录已确认的项目事实。每条记忆保留来源，模型推断不能冒充证据。</p>{snapshot?.memories.map(item => <div className="oss-variable" key={item.id}><p>{item.text}</p><small>{item.source}</small><button onClick={() => void api(`${prefix}memory`, { id: item.id, text: '', source: 'user:workbench' }).then(reload).catch(error => setError(message(error)))}>撤回</button></div>)}<textarea aria-label="项目记忆" placeholder="例如：本项目使用人类 GRCh38 参考基因组" value={memory} onChange={event => setMemory(event.target.value)} maxLength={20000} /><button disabled={!memory.trim()} onClick={() => void api(`${prefix}memory`, { id: crypto.randomUUID(), text: memory, source: 'user:workbench' }).then(() => { setMemory(''); return reload() }).catch(error => setError(message(error)))}>保存已确认事实</button></article></aside></div>
  </section>
}

export function OssWorkbench(): JSX.Element {
  const [session, setSession] = useState<Session>()
  const [page, setPage] = useState(location.pathname.replace(/\/+$/, '').endsWith('/store') ? 'store' : 'lab')
  const [storeVisited, setStoreVisited] = useState(location.pathname.replace(/\/+$/, '').endsWith('/store'))
  const [domain, setDomain] = useState('')
  const [projectId, setProjectId] = useState(new URLSearchParams(location.search).get('project') || '')
  const [error, setError] = useState('')
  const refresh = useCallback(async () => { const result = await api<Session>('session'); setSession(result); setError('') }, [])
  useEffect(() => {
    const load = () => { void refresh().catch(error => setError(message(error))) }
    load(); const timer = setInterval(load, 20000); window.addEventListener('focus', load); window.addEventListener(HOST_REFRESH_EVENT, load)
    return () => { clearInterval(timer); window.removeEventListener('focus', load); window.removeEventListener(HOST_REFRESH_EVENT, load) }
  }, [refresh])
  useEffect(() => { setDomain('') }, [session?.account.server, session?.account.generation, session?.account.user?.id])
  useEffect(() => {
    if (!session?.account.login) return
    let alive = true
    const timer = setInterval(() => { void api('login/poll', {}, undefined, session.account).then(() => { if (alive) return refresh() }).catch(error => { if (alive) setError(message(error)) }) }, 2500)
    return () => { alive = false; clearInterval(timer) }
  }, [session?.account.login?.user_code, refresh])
  const project = session?.projects.find(item => item.id === projectId) || session?.projects[0]
  return <div className="oss"><header className="oss-top"><a className="oss-brand" href="/omicos/oss">OmicOS <span>OSS</span></a><nav aria-label="工作台导航"><button aria-current={page === 'lab' ? 'page' : undefined} onClick={() => setPage('lab')}>科研工作台</button><button aria-current={page === 'store' ? 'page' : undefined} onClick={() => { setStoreVisited(true); setPage('store') }}>云服务商城</button></nav><div className="oss-account">{session?.account.logged_in ? <><span>{session.account.user?.email || session.account.user?.phone || session.account.user?.id}</span><button onClick={() => void api('logout', {}, undefined, session.account).then(refresh).catch(error => setError(message(error)))}>退出</button></> : <button disabled={!session} onClick={() => void api('login', {}, undefined, session?.account).then(refresh).catch(error => setError(message(error)))}>登录 OmicOS 云</button>}</div></header>
    <main>{error && <p role="alert" className="oss-error">{error} <button onClick={() => setError('')}>关闭提示</button></p>}{session?.account.login && <section className="oss-confirm"><h2>批准云账号登录</h2><p>在浏览器打开 <a href={session.account.login.verification_uri} target="_blank" rel="noreferrer">官方配对页面 ↗</a>，登录后输入配对码：</p><strong className="oss-pair-code">{session.account.login.user_code}</strong><p>本窗口会自动查询批准结果。插件不经手你的密码或验证码。</p></section>}
    {session?.account.logged_in && <CloudRenewalBanner key={`${session.account.server}:${session.account.generation}:${session.account.user?.id}`} account={session.account} onRenew={domain => { setDomain(domain); setStoreVisited(true); setPage('store'); requestAnimationFrame(() => document.getElementById('oss-cloud-catalog')?.scrollIntoView()) }} />}
    {!session ? <p>正在连接 OmicOS OSS…</p> : <>{storeVisited && <div hidden={page !== 'store'}><Store key={`${session.csrf}:${session.account.generation}:${session.account.user?.id || 'anonymous'}`} account={session.account} refresh={refresh} visible={page === 'store'} domain={domain} setDomain={setDomain} /></div>}<div hidden={page !== 'lab'}>{session.projects.length > 1 && <label>当前项目<select value={project?.id} onChange={event => setProjectId(event.target.value)}>{session.projects.map(item => <option key={item.id} value={item.id}>{item.workspace}</option>)}</select></label>}{project ? <Laboratory key={project.id} project={project} visible={page === 'lab'} /> : <p>请先从 Harness 项目会话运行 OmicOS 工具，或使用独立启动命令指定工作区。</p>}</div></>}
    <RuntimeCapabilities />
    <footer>OmicOS OSS · 本地运行与云服务独立 · 科研数据由你掌握</footer></main></div>
}

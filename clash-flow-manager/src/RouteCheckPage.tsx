import { useEffect, useState, type FormEvent } from 'react'
import { DropdownSelect } from './components/DropdownSelect'
import { RouteCheckAddressInput } from './components/RouteCheckAddressInput'
import { api, type AppSettings, type LocalRouteCheckResult, type RouteCheckResult, type SavedPolicy } from './core/bridge'
import { composeRouteCheckUrl, type UrlProtocol } from './core/routeCheckUrl'

type CheckMode = 'local' | 'mihomo'

export function RouteCheckPage(props: {
  settings: AppSettings | null
  policies: SavedPolicy[]
  activePolicyId: string
}) {
  const [mode, setMode] = useState<CheckMode>('local')
  const [protocol, setProtocol] = useState<UrlProtocol>('https')
  const [urlAddress, setUrlAddress] = useState('')
  const [policyId, setPolicyId] = useState('')
  const [localResult, setLocalResult] = useState<LocalRouteCheckResult | null>(null)
  const [mihomoResult, setMihomoResult] = useState<RouteCheckResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (props.policies.some((policy) => policy.id === policyId)) return
    setPolicyId(props.policies.some((policy) => policy.id === props.activePolicyId)
      ? props.activePolicyId
      : props.policies[0]?.id ?? '')
  }, [props.activePolicyId, props.policies, policyId])

  const requestUrl = composeRouteCheckUrl(protocol, urlAddress)
  const validUrl = Boolean(requestUrl)
  const selectedPolicy = props.policies.find((policy) => policy.id === policyId)

  function clearResults() {
    setLocalResult(null)
    setMihomoResult(null)
    setError('')
  }

  async function verifyLocal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validUrl || !policyId || loading) return
    setLoading(true)
    clearResults()
    try {
      setLocalResult(await api.localRouteCheck(policyId, requestUrl))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function verifyMihomo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validUrl || loading || !props.settings) return
    setLoading(true)
    clearResults()
    try {
      setMihomoResult(await api.routeCheck(requestUrl))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  return <div className="route-check-page">
    <div className="page-heading route-check-page-heading">
      <div><div className="eyebrow">ROUTE VERIFICATION</div><h1>线路验证</h1></div>
      <div className="route-check-modes" role="tablist" aria-label="验证方式">
        <button className={mode === 'local' ? 'active' : ''} type="button" role="tab" aria-selected={mode === 'local'} onClick={() => { setMode('local'); clearResults() }}>本地验证</button>
        <button className={mode === 'mihomo' ? 'active' : ''} type="button" role="tab" aria-selected={mode === 'mihomo'} onClick={() => { setMode('mihomo'); clearResults() }}>Mihomo 真实验证</button>
      </div>
    </div>

    {mode === 'local' && <section className="panel route-check-panel">
      <div className="panel-title">
        <div><span className="section-kicker">LOCAL POLICY MATCH</span><h2>按本软件策略方案推演</h2></div>
        <div className="preset-icon">⌕</div>
      </div>
      <p className="muted">选择已保存的策略方案，程序会按规则顺序在本机匹配链接，并显示命中规则和目标策略组。地址带有 HTTP/HTTPS 协议时，以地址中的协议为准。</p>
      <label className="field-label route-check-policy-field">策略方案
        <DropdownSelect value={policyId} onValueChange={(value) => { setPolicyId(value); clearResults() }}>
          <option value="">请选择策略方案</option>
          {props.policies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name}{policy.id === props.activePolicyId ? '（当前启用）' : ''}</option>)}
        </DropdownSelect>
      </label>
      <form className="route-check-form" onSubmit={(event) => void verifyLocal(event)}>
        <label className="field-label" htmlFor="route-check-local-url">目标地址</label>
        <div className="route-check-input-row">
          <RouteCheckAddressInput id="route-check-local-url" protocol={protocol} onProtocolChange={(value) => { setProtocol(value); clearResults() }} address={urlAddress} onAddressChange={(value) => { setUrlAddress(value); clearResults() }} />
          <button className="button primary" type="submit" disabled={!validUrl || !policyId || loading || !props.policies.length}>
            {loading && mode === 'local' ? '本地匹配中…' : '本地验证'}
          </button>
        </div>
      </form>
      <div className="route-check-hint">
        <span className="route-check-hint-dot local" />
        <span>只读取本机已保存的策略方案、规则集和节点数据；此模式不连接 Mihomo，也不发送网络请求。</span>
      </div>
      <p className="route-check-note">本地的进程名 / 路径规则按 Clash Flow Manager 当前进程匹配。结果显示规则去向和策略组成员；自动选择组当前选中的实际节点，请使用“Mihomo 真实验证”查看。</p>
      {props.policies.length === 0 && <div className="inline-info route-check-inline-info">本机还没有已保存的策略方案，请先创建或导入方案。</div>}
    </section>}

    {mode === 'mihomo' && <section className="panel route-check-panel">
      <div className="panel-title">
        <div><span className="section-kicker">LIVE MIHOMO CONNECTION</span><h2>检查正在运行的实际线路</h2></div>
        <div className="preset-icon">⌁</div>
      </div>
      <p className="muted">程序会经当前已保存的 Mihomo 混合端口发出真实请求，并读取这次连接的命中规则、策略组和最终节点。地址带有 HTTP/HTTPS 协议时，以地址中的协议为准。</p>
      <form className="route-check-form" onSubmit={(event) => void verifyMihomo(event)}>
        <label className="field-label" htmlFor="route-check-mihomo-url">目标地址</label>
        <div className="route-check-input-row">
          <RouteCheckAddressInput id="route-check-mihomo-url" protocol={protocol} onProtocolChange={(value) => { setProtocol(value); clearResults() }} address={urlAddress} onAddressChange={(value) => { setUrlAddress(value); clearResults() }} />
          <button className="button primary" type="submit" disabled={!validUrl || loading || !props.settings}>
            {loading && mode === 'mihomo' ? '连接中…' : '真实验证'}
          </button>
        </div>
      </form>
      <div className="route-check-hint">
        <span className="route-check-hint-dot" />
        <span>{props.settings
          ? `使用当前已保存的 Mihomo 混合端口 127.0.0.1:${props.settings.mixedPort}；请求由本程序进程发起。`
          : '正在读取 Mihomo 设置…'}</span>
      </div>
      <p className="route-check-note">验证会发送一条带 Range 标记的 GET 请求，不读取响应正文。进程名分流规则会按本程序的进程名匹配。</p>
    </section>}

    {error && <div className="inline-error route-check-error" role="alert">{error}</div>}
    {localResult && mode === 'local' && selectedPolicy && <LocalResultCard result={localResult} />}
    {mihomoResult && mode === 'mihomo' && <MihomoResultCard result={mihomoResult} />}
  </div>
}

function LocalResultCard(props: { result: LocalRouteCheckResult }) {
  const { result } = props
  const statusLabel = result.status === 'matched' ? '本地规则已匹配' : result.status === 'uncertain' ? '存在未判定条件' : '没有规则命中'
  const statusClass = result.status === 'matched' ? 'success' : result.status === 'uncertain' ? 'warning' : 'neutral'
  return <section className={'panel route-check-result local-result ' + statusClass} aria-live="polite">
    <div className="route-check-result-head">
      <div>
        <span className="section-kicker">LOCAL POLICY RESULT · {result.policyName}</span>
        <h2>{result.host}</h2>
      </div>
      <span className={'route-check-status ' + statusClass}>{statusLabel}</span>
    </div>
    <p className={'route-check-result-message ' + (result.status === 'uncertain' ? 'warning' : result.status === 'unmatched' ? 'neutral' : '')}>{result.message}</p>
    <div className="route-check-facts">
      <RouteFact label={result.status === 'uncertain' ? '待判定规则' : '命中规则'} value={[result.rule, result.rulePayload].filter(Boolean).join(' · ') || '未命中'} />
      <RouteFact label={result.status === 'uncertain' ? '条件成立时的目标' : '策略去向'} value={result.target || '无法确定'} emphasis={result.status === 'matched'} />
      <RouteFact label="目标类型" value={result.targetKind || '未确定'} />
      <RouteFact label="策略组方式" value={result.groupKind || '—'} />
    </div>
    {result.members.length > 0 && <div className="route-check-members">
      <div><strong>组内成员 / 节点候选</strong><span>{result.membersComplete ? `共 ${result.memberCount} 项` : '动态筛选，无法在本地完整展开'}</span></div>
      <div className="route-check-member-list">{result.members.map((member, index) => <span key={`${member}-${index}`}>{member}</span>)}</div>
      {result.memberCount > result.members.length && <small>显示前 {result.members.length} 项，共 {result.memberCount} 项。</small>}
    </div>}
  </section>
}

function MihomoResultCard(props: { result: RouteCheckResult }) {
  const { result } = props
  return <section className={'panel route-check-result ' + (result.captured ? 'captured' : 'not-captured')} aria-live="polite">
    <div className="route-check-result-head">
      <div>
        <span className="section-kicker">LIVE MIHOMO RESULT</span>
        <h2>{result.host}</h2>
      </div>
      <span className={'route-check-status ' + (result.captured ? 'success' : 'warning')}>
        {result.captured ? '已确认实际线路' : '未捕获连接'}
      </span>
    </div>
    <p className={result.captured ? 'route-check-result-message' : 'route-check-result-message warning'}>{result.message}</p>
    <div className="route-check-facts">
      <RouteFact label="命中规则" value={[result.rule, result.rulePayload].filter(Boolean).join(' · ') || '未获取'} />
      <RouteFact label="策略组" value={result.routeGroup || '未获取'} />
      <RouteFact label="最终节点" value={result.node || '未获取'} emphasis />
      <RouteFact label="代理链" value={result.proxyChain.length ? result.proxyChain.join(' → ') : '未获取'} />
      <RouteFact label="HTTP 状态" value={result.statusCode === null ? '未收到响应' : String(result.statusCode)} />
      <RouteFact label="请求耗时" value={`${result.elapsedMs} ms`} />
    </div>
  </section>
}

function RouteFact(props: { label: string; value: string; emphasis?: boolean }) {
  return <div className={'route-check-fact' + (props.emphasis ? ' emphasis' : '')}>
    <span>{props.label}</span>
    <strong title={props.value}>{props.value}</strong>
  </div>
}

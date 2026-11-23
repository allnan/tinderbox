import { useState, type FormEvent } from 'react'
import { RouteCheckAddressInput } from './components/RouteCheckAddressInput'
import { api, type AppSettings, type RouteCheckResult } from './core/bridge'
import { composeRouteCheckUrl, type UrlProtocol } from './core/routeCheckUrl'

export function RouteCheckPage(props: { settings: AppSettings | null }) {
  const [protocol, setProtocol] = useState<UrlProtocol>('https')
  const [urlAddress, setUrlAddress] = useState('')
  const [result, setResult] = useState<RouteCheckResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const requestUrl = composeRouteCheckUrl(protocol, urlAddress)
  const validUrl = Boolean(requestUrl)

  function clearResult() {
    setResult(null)
    setError('')
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validUrl || loading || !props.settings) return
    setLoading(true)
    clearResult()
    try {
      setResult(await api.routeCheck(requestUrl))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  return <div className="route-check-page">
    <div className="page-heading route-check-page-heading">
      <div><div className="eyebrow">ROUTE VERIFICATION</div><h1>线路验证</h1></div>
    </div>

    <section className="panel route-check-panel">
      <div className="panel-title">
        <div><span className="section-kicker">LIVE MIHOMO CONNECTION</span><h2>检查正在运行的实际线路</h2></div>
        <div className="preset-icon">⌁</div>
      </div>
      <p className="muted">程序会经当前已保存的 Mihomo 混合端口发出真实请求，并读取这次连接的命中规则、策略组和最终节点。地址带有 HTTP/HTTPS 协议时，以地址中的协议为准。</p>
      <form className="route-check-form" onSubmit={(event) => void verify(event)}>
        <label className="field-label" htmlFor="route-check-mihomo-url">目标地址</label>
        <div className="route-check-input-row">
          <RouteCheckAddressInput id="route-check-mihomo-url" protocol={protocol} onProtocolChange={(value) => { setProtocol(value); clearResult() }} address={urlAddress} onAddressChange={(value) => { setUrlAddress(value); clearResult() }} />
          <button className="button primary" type="submit" disabled={!validUrl || loading || !props.settings}>
            {loading ? '连接中…' : '真实验证'}
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
    </section>

    {error && <div className="inline-error route-check-error" role="alert">{error}</div>}
    {result && <MihomoResultCard result={result} />}
  </div>
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

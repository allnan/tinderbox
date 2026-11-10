import React from 'react'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 错误边界：某个视图渲染出错时只替换该区域，保留应用外壳与导航。
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l10 18H2zM12 9v5M12 17h.01" />
            </svg>
          </div>
          <h2 className="error-boundary-title">这个页面出了点问题</h2>
          <p className="error-boundary-desc">{this.state.error.message || '未知错误'}</p>
          <div className="error-boundary-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => this.setState({ error: null })}>
              重试
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.location.reload()}>
              重新加载应用
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

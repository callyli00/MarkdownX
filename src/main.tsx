import React, { Component, ErrorInfo, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('MarkdownX Uncaught error:', error, errorInfo);
  }

  private handleReset = () => {
    try {
      localStorage.clear();
    } catch {}
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          padding: '24px',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          backgroundColor: '#f8fafc',
          color: '#1e293b',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>⚠️</div>
          <h2 style={{ fontSize: '20px', marginBottom: '12px', color: '#e11d48' }}>
            MarkdownX 界面加载异常
          </h2>
          <p style={{ fontSize: '14px', color: '#64748b', maxWidth: '480px', marginBottom: '16px', lineHeight: 1.6 }}>
            检测到界面初始化错误。通常由于本地缓存配置异常引起，您可以点击下方按钮重置缓存并快速恢复。
          </p>
          <pre style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '6px',
            padding: '12px 16px',
            fontSize: '12px',
            color: '#dc2626',
            maxWidth: '600px',
            overflowX: 'auto',
            marginBottom: '20px',
            textAlign: 'left'
          }}>
            {this.state.error?.toString() || '未知异常'}
          </pre>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 18px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                backgroundColor: '#ffffff',
                cursor: 'pointer',
                fontWeight: 500,
                fontSize: '14px'
              }}
            >
              刷新重试
            </button>
            <button
              onClick={this.handleReset}
              style={{
                padding: '8px 18px',
                borderRadius: '6px',
                border: 'none',
                backgroundColor: '#2563eb',
                color: '#ffffff',
                cursor: 'pointer',
                fontWeight: 500,
                fontSize: '14px'
              }}
            >
              重置缓存并恢复
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

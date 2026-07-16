import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { MiniPlayerApp } from './pages/MiniPlayerApp';
import { I18nProvider } from './i18n';
import { applyAppTheme, getStoredTheme } from './theme';
import './styles.css';

// Apply theme before first paint of React tree
applyAppTheme(getStoredTheme());

// Platform class for titlebar padding (mac traffic lights)
try {
  const p = navigator.platform || '';
  if (/Mac/i.test(p)) document.body.classList.add('platform-mac');
  else if (/Win/i.test(p)) document.body.classList.add('platform-win');
} catch {
  /* ignore */
}

const isMini = typeof window !== 'undefined' && window.location.hash === '#mini';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('UI crash', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100%',
            background: '#111',
            color: '#e8e4dc',
            padding: 32,
            fontFamily: 'system-ui, sans-serif',
            lineHeight: 1.5,
          }}
        >
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>miura · UI error</h1>
          <p style={{ color: '#c88', marginBottom: 16 }}>{this.state.error.message}</p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              color: '#888',
              background: '#0a0a0a',
              padding: 12,
              border: '1px solid #333',
            }}
          >
            {this.state.error.stack}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16,
              padding: '10px 16px',
              background: '#c8f06c',
              border: 'none',
              color: '#111',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Перезагрузить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) {
  document.body.innerHTML =
    '<div style="padding:24px;color:#fff;background:#111">#root not found</div>';
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        {isMini ? (
          <MiniPlayerApp />
        ) : (
          <I18nProvider>
            <App />
          </I18nProvider>
        )}
      </ErrorBoundary>
    </React.StrictMode>
  );
}

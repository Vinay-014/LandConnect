import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const GMP_ERROR_PATTERN =
  /OverQuotaMapError|QuotaExceededError|BillingNotEnabledMapError|InvalidKeyMapError|RefererNotAllowedMapError|ApiNotActivatedMapError|ApiProjectMapError/;

const IGNORED_NOISE_PATTERN = /ResizeObserver loop|vite.*ws|WebSocket/i;

// Tier 1 Google Maps Platform quota & auth failure listener
(window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
  window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
};

const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  origConsoleError.apply(console, args);
  const msg = args.map((a) => String(a)).join(' ');
  if (GMP_ERROR_PATTERN.test(msg)) {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  }
};

function dispatchRuntimeError(
  origin: 'window.onerror' | 'unhandledrejection',
  message: string,
  details?: Record<string, unknown>,
) {
  const normalized = message.trim() || 'Unexpected runtime error';
  if (GMP_ERROR_PATTERN.test(normalized)) {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  }
  if (IGNORED_NOISE_PATTERN.test(normalized)) {
    return;
  }
  origConsoleError(`[Runtime ${origin}]`, normalized, details ?? {});
  window.dispatchEvent(
    new CustomEvent('app-runtime-error', {
      detail: {
        origin,
        message: normalized,
        timestamp: new Date().toISOString(),
      },
    }),
  );
}

const prevOnError = window.onerror;
window.onerror = (message, source, lineno, colno, error) => {
  const text =
    error instanceof Error
      ? error.message
      : typeof message === 'string'
      ? message
      : 'Unhandled script error';
  dispatchRuntimeError('window.onerror', text, {
    source,
    lineno,
    colno,
    stack: error instanceof Error ? error.stack : undefined,
  });
  if (typeof prevOnError === 'function') {
    return prevOnError.call(window, message, source, lineno, colno, error);
  }
  return false;
};

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const reason = event.reason;
  const text =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
      ? reason
      : (() => {
          try {
            return JSON.stringify(reason);
          } catch {
            return String(reason || 'Unhandled promise rejection');
          }
        })();
  dispatchRuntimeError('unhandledrejection', text, {
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary fallbackTitle="LandConnect encountered an unexpected error">
    <App />
  </ErrorBoundary>,
);

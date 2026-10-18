import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { EngineClient } from './engine/client';
import { useStore } from './state/store';
import './styles.css';

async function boot(): Promise<void> {
  const client = await EngineClient.create();
  const store = useStore.getState();
  store.setClient(client);
  try {
    store.setSession(await client.call('session'));
  } catch {
    // engine not ready yet; the welcome screen handles opening
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary where="the window">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
  // The desktop app reloads the window after its drawing stopped (#recovered=gpu or window): say what happened.
  const recovered = /recovered=(gpu|window)/.exec(location.hash)?.[1];
  if (recovered) {
    history.replaceState(null, '', location.pathname + location.search);
    store.toast(
      'warning',
      recovered === 'gpu'
        ? "The graphics card stopped responding, so the window was drawn again. Your work is still open. If the built-in AI was using the graphics card, it now runs on the processor (Settings → AI → Run it on)."
        : 'The window stopped working and was opened again. Your work is still open.',
    );
  }
}

void boot();

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
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
      <App />
    </StrictMode>,
  );
}

void boot();

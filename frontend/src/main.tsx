import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// import './index.css'
import App from './App.tsx'
import { startDevelopmentMocks } from './mocks/bootstrap'
import { reloadOnceForStaleChunk } from './utils/chunkReload'

// After a deploy an open tab asks for code that is gone: one reload loads the new version.
// The error is not cancelled, so a page that still fails shows its own message (GL-01).
window.addEventListener('vite:preloadError', () => { reloadOnceForStaleChunk() })

void startDevelopmentMocks().then(() => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
))

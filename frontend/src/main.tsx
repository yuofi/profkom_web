import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// import './index.css'
import App from './App.tsx'
import { startDevelopmentMocks } from './mocks/bootstrap'
import { preloadRouteCode } from './utils/routePrefetch'

// The code of the opened page loads while the session is checked, not after it (PF-04).
// Only code: its data waits for the confirmed session. Code removed by a deploy is
// reloaded by the page's error boundary when the page is really opened, not by an early
// or idle preload (GL-01).
preloadRouteCode(window.location.pathname)

void startDevelopmentMocks().then(() => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
))

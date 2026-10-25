import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// import './index.css'
import 'material-symbols/rounded.css'
import App from './App.tsx'
import { startDevelopmentMocks } from './mocks/bootstrap'

void startDevelopmentMocks().then(() => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
))

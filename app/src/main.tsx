import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyDisplay } from './displaySettings'

// 設定画面の「表示」で決めた文字の大きさ・フォントを、最初の描画の前に当てる
applyDisplay()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

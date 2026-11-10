import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyDisplay } from './displaySettings'
import { AndroidProto } from './AndroidProto'

// Android の試作：Android では、まず試作の画面を出す（「本体の画面」で今の画面に移る）
function Root() {
  const [proto, setProto] = useState(/Android/.test(navigator.userAgent))
  return proto ? <AndroidProto onOpenApp={() => setProto(false)} /> : <App />
}

// 設定画面の「表示」で決めた文字の大きさ・フォントを、最初の描画の前に当てる
applyDisplay()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

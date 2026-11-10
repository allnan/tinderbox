import { createRoot } from 'react-dom/client'
import App from './App'
import PreviewWindowPage from './views/PreviewWindowPage'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

// 独立预览窗口以 ?view=preview 复用同一份打包产物
const params = new URLSearchParams(window.location.search)
const isPreviewView = params.get('view') === 'preview'

createRoot(container).render(isPreviewView ? <PreviewWindowPage /> : <App />)

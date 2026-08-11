import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('缺少 #root 容器');
}
createRoot(root).render(<App />);

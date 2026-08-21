import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { defaultThemeSettings, loadThemeSettings } from './storage/browserStorage';
import './styles/global.css';

const storedTheme = loadThemeSettings();
const initialTheme = storedTheme.ok && storedTheme.value ? storedTheme.value : defaultThemeSettings;
const initialResolvedTheme = initialTheme.preference === 'system'
  ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  : initialTheme.preference;
document.documentElement.dataset.theme = initialResolvedTheme;
document.documentElement.style.colorScheme = initialResolvedTheme;
const root = document.getElementById('root');
if (!root) {
  throw new Error('缺少 #root 容器');
}
createRoot(root).render(<App />);

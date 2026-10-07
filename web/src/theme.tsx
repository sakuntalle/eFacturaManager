import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

type Theme = 'light' | 'dark';
const ThemeContext = createContext({ theme: 'light' as Theme, toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
    function toggle() {
        const next = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        try { localStorage.setItem('efactura-theme', next); } catch { /* Theme still works when storage is unavailable. */ }
    }
    return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function ThemeSwitch() {
    const { theme, toggle } = useContext(ThemeContext);
    return <button type="button" className="theme-switch" role="switch"
        aria-label="Dark mode" aria-checked={theme === 'dark'} onClick={toggle}>
        <span>Dark mode</span><span className="theme-track" aria-hidden="true"><span /></span>
    </button>;
}

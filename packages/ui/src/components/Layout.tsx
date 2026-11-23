import type { ReactNode } from 'react';
import type { RunProgressEvent } from '@ntc/core';
import { RunProgressBanner } from './RunProgressBanner.js';

export type NavTabId = 'dashboard' | 'repos' | 'nc' | 'diff' | 'settings';

const NAV_ITEMS: ReadonlyArray<{ readonly id: NavTabId; readonly label: string }> = [
  { id: 'dashboard', label: 'Notas Técnicas' },
  { id: 'nc', label: 'Revisão NC' },
  { id: 'diff', label: 'Diff & PR' },
  { id: 'repos', label: 'Repositórios' },
  { id: 'settings', label: 'BYOK & Doctor' },
];

export interface LayoutProps {
  readonly activeTab: NavTabId;
  readonly onSelectTab: (tab: NavTabId) => void;
  readonly latestProgress: RunProgressEvent | null;
  readonly children: ReactNode;
}

export function Layout({ activeTab, onSelectTab, latestProgress, children }: LayoutProps) {
  return (
    <div className="app-shell">
      <header className="top-header">
        <h1 className="brand-title">NT Conformidade — SEF/MG</h1>
        <nav className="nav-tabs" aria-label="Navegação principal">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="nav-tab"
              aria-current={activeTab === item.id ? 'page' : undefined}
              onClick={() => onSelectTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="main-content">
        <RunProgressBanner event={latestProgress} />
        {children}
      </main>
    </div>
  );
}

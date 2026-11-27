import type { ReactNode } from 'react';
import type { RunProgressEvent } from '@ntc/core';
import type { ByokTokenAvailability } from '../api/helpers.js';
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
  readonly onGoHome?: () => void;
  readonly latestProgress: RunProgressEvent | null;
  readonly byokTokenSummary?: ByokTokenAvailability | null;
  readonly children: ReactNode;
}

export function Layout({
  activeTab,
  onSelectTab,
  onGoHome,
  latestProgress,
  byokTokenSummary,
  children,
}: LayoutProps) {
  function handleNavClick(tab: NavTabId): void {
    if (tab === 'dashboard' && onGoHome) {
      onGoHome();
      return;
    }
    onSelectTab(tab);
  }

  return (
    <div className="app-shell">
      <header className="top-header">
        <h1 className="brand-title">NT Conformidade — SEF/MG</h1>
        <nav className="nav-tabs" aria-label="Navegação principal">
          {NAV_ITEMS.map((item) => {
            const isByokTab = item.id === 'settings';
            return (
              <button
                key={item.id}
                type="button"
                className="nav-tab"
                aria-current={activeTab === item.id ? 'page' : undefined}
                title={isByokTab && byokTokenSummary ? byokTokenSummary.buttonTooltip : undefined}
                onClick={() => handleNavClick(item.id)}
              >
                <span>{item.label}</span>
                {isByokTab && byokTokenSummary && (
                  <span
                    className={`nav-tab-token-pill ${
                      byokTokenSummary.isConnected ? 'nav-tab-token-pill-ok' : 'nav-tab-token-pill-warn'
                    }`}
                  >
                    {byokTokenSummary.buttonBadgeText}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>
      <main className="main-content">
        <RunProgressBanner event={latestProgress} />
        {children}
      </main>
    </div>
  );
}

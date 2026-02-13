import { useState } from "react";
import { createPortal } from "react-dom";
import { isMobile } from "../stores/mobileStore";

export interface SettingsTab {
  id: string;
  label: string;
  visible?: boolean;
  separatorBefore?: boolean;
}

interface SettingsModalProps {
  title: string;
  tabs: SettingsTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  headerExtra?: React.ReactNode;
}

export default function SettingsModal({
  title,
  tabs,
  activeTab,
  onTabChange,
  onClose,
  children,
  className,
  headerExtra,
}: SettingsModalProps) {
  const [mobileShowContent, setMobileShowContent] = useState(false);

  const handleTabClick = (tabId: string) => {
    onTabChange(tabId);
    if (isMobile()) setMobileShowContent(true);
  };

  const handleMobileBack = () => {
    setMobileShowContent(false);
  };

  const visibleTabs = tabs.filter((t) => t.visible !== false);

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal user-settings-modal${className ? ` ${className}` : ""}${mobileShowContent ? " us-mobile-content" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="us-sidebar">
          <div className="us-sidebar-header">
            {title}
            <button className="us-close us-sidebar-close" onClick={onClose}>&times;</button>
          </div>
          {visibleTabs.map((tab) => (
            <div key={tab.id}>
              {tab.separatorBefore && <div className="us-nav-separator" />}
              <button
                className={`us-nav-item ${activeTab === tab.id ? "active" : ""}`}
                onClick={() => handleTabClick(tab.id)}
              >
                {tab.label}
              </button>
            </div>
          ))}
        </div>

        <div className="us-content">
          <div className="us-content-header">
            <button className="us-back" onClick={handleMobileBack}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
              </svg>
            </button>
            <h2>{visibleTabs.find((t) => t.id === activeTab)?.label ?? title}</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {headerExtra}
              <button className="us-close" onClick={onClose}>&times;</button>
            </div>
          </div>

          <div className="us-content-body">
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

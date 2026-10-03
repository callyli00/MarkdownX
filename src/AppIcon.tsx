import React from 'react';

/**
 * Unified outline icon set (Lucide-style: 1.8 stroke, round caps/joins).
 * Every chrome icon in MarkdownX comes from here so the UI speaks one visual
 * language. Size defaults to 15px; color follows `currentColor`.
 */
export type IconName =
  | 'plus-circle' | 'sidebar-left' | 'sidebar-right' | 'search' | 'filter'
  | 'folder' | 'folder-open' | 'file-text' | 'settings' | 'moon' | 'sun'
  | 'monitor' | 'type' | 'columns' | 'target' | 'pin' | 'zoom-in' | 'zoom-out'
  | 'maximize' | 'help' | 'keyboard' | 'sigma' | 'info' | 'more' | 'code'
  | 'book' | 'list-tree' | 'wrench' | 'copy' | 'print' | 'export' | 'close'
  | 'chevron-down' | 'save' | 'new-file' | 'open-file' | 'eye' | 'pencil'
  | 'align-justify' | 'align-left' | 'indent' | 'undo' | 'redo' | 'trash' | 'download'
  | 'scissors' | 'clipboard';

const PATHS: Record<IconName, React.ReactNode> = {
  'plus-circle': <><circle cx="12" cy="12" r="8.5" /><path d="M12 8.8v6.4M8.8 12h6.4" /></>,
  'sidebar-left': <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15" /></>,
  'sidebar-right': <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M14.5 4.5v15" /></>,
  'search': <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2" /></>,
  'filter': <><path d="M4 7h10M18.5 7H20M4 17h4M12.5 17H20" /><circle cx="16" cy="7" r="2.1" /><circle cx="10" cy="17" r="2.1" /></>,
  'folder': <path d="M3 8.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  'folder-open': <><path d="M3 8.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1.5" /><path d="M3 10l2.2 8a1.5 1.5 0 0 0 1.45 1.1h11a1.5 1.5 0 0 0 1.45-1.1L21 10" /></>,
  'file-text': <><path d="M6 3.5h8L18.5 8v12.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" /><path d="M13.5 3.5V9h5" /><path d="M8.5 13h7M8.5 16.5h7" /></>,
  'settings': <><circle cx="12" cy="12" r="3" /><path d="M12 4.5v2.2M12 17.3v2.2M4.5 12h2.2M17.3 12h2.2M6.8 6.8l1.6 1.6M15.6 15.6l1.6 1.6M17.2 6.8l-1.6 1.6M8.4 15.6l-1.6 1.6" /></>,
  'moon': <path d="M12 3a9 9 0 1 0 9 9c0-.5 0-.9-.1-1.4A6.8 6.8 0 0 1 12.4 3.1c-.1 0-.3-.1-.4-.1z" />,
  'sun': <><circle cx="12" cy="12" r="4" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18" /></>,
  'monitor': <><rect x="3.5" y="4.5" width="17" height="12" rx="2" /><path d="M9 20.5h6M12 16.5v4" /></>,
  'type': <><path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" /></>,
  'columns': <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M12 4.5v15" /></>,
  'target': <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></>,
  'pin': <><path d="M12 15v6" /><path d="M9 4h6l.8 5.2a2.5 2.5 0 0 0 2 2V13H4v-1.8a2.5 2.5 0 0 0 2-2z" /></>,
  'zoom-in': <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2M8.8 11h4.4M11 8.8v4.4" /></>,
  'zoom-out': <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2M8.8 11h4.4" /></>,
  'maximize': <><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></>,
  'help': <><circle cx="12" cy="12" r="8.5" /><path d="M9.5 9.3a2.6 2.6 0 0 1 5.1.7c0 1.7-2.6 2-2.6 3.5" /><circle cx="12" cy="17" r=".4" /></>,
  'keyboard': <><rect x="2.5" y="6.5" width="19" height="11" rx="2" /><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h12" /></>,
  'sigma': <path d="M17 5.5H7.5L12 12l-4.5 6.5H17" />,
  'info': <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5" /><circle cx="12" cy="8" r=".4" /></>,
  'more': <><circle cx="5.5" cy="12" r=".4" /><circle cx="12" cy="12" r=".4" /><circle cx="18.5" cy="12" r=".4" /></>,
  'code': <path d="M8.5 8L4 12l4.5 4M15.5 8l4.5 4-4.5 4" />,
  'book': <><path d="M4 5.5A2 2 0 0 1 6 3.5h14v14H6a2 2 0 0 0-2 2z" /><path d="M4 19.5a2 2 0 0 1 2-2h14" /></>,
  'list-tree': <path d="M4 5.5h7M4 10h11M4 14.5h7M4 19h11" />,
  'wrench': <path d="M14.5 6a3.5 3.5 0 0 0-4.6 4.6L4 16.5a2.1 2.1 0 0 0 3 3l5.9-5.9A3.5 3.5 0 0 0 17.5 9" />,
  'copy': <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M16 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2.5" /></>,
  'print': <><path d="M7 8.5V4h10v4.5" /><rect x="3.5" y="8.5" width="17" height="7.5" rx="2" /><path d="M7 13h10v7H7z" /></>,
  'export': <><path d="M12 15V4M8 8l4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>,
  'close': <path d="M6 6l12 12M18 6L6 18" />,
  'chevron-down': <path d="M6.5 9.5L12 15l5.5-5.5" />,
  'save': <><path d="M5.5 4.5h10L19 9v10.5H5.5z" /><path d="M8.5 4.5V9h6.5" /><rect x="8.5" y="13" width="7" height="5" /></>,
  'new-file': <><path d="M6 3.5h8L18.5 8v12.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" /><path d="M13.5 3.5V9h5" /><path d="M12 12v5M9.5 14.5h5" /></>,
  'open-file': <><path d="M6 3.5h8L18.5 8v12.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" /><path d="M13.5 3.5V9h5" /></>,
  'eye': <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" /><circle cx="12" cy="12" r="2.6" /></>,
  'pencil': <><path d="M4.5 19.5l.9-3.5L16 5.9a2.1 2.1 0 0 1 3 3L8.4 19z" /></>,
  'align-justify': <path d="M4 6.5h16M4 10h16M4 13.5h16M4 17h11" />,
  'align-left': <path d="M4 6.5h16M4 10h12M4 13.5h16M4 17h12" />,
  'indent': <path d="M4 6.5h16M10 10h10M10 14h10M4 17.5h16M4 10l3 2-3 2" />,
  'undo': <><path d="M8 8L4 12l4 4" /><path d="M4 12h10a5 5 0 0 1 0 10h-2" /></>,
  'redo': <><path d="M16 8l4 4-4 4" /><path d="M20 12H10a5 5 0 0 0 0 10h2" /></>,
  'trash': <><path d="M4.5 6.5h15M8 6.5V4.5h8v2M6.5 6.5l1 13h9l1-13" /></>,
  'download': <><path d="M12 4v10M8 10.5l4 4 4-4" /><path d="M4.5 19.5h15" /></>,
  'scissors': <><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="6.5" cy="17.5" r="2.5" /><path d="M8.6 8.2L20 18M20 6L8.6 15.8" /></>,
  'clipboard': <><rect x="6" y="5" width="12" height="15.5" rx="2" /><path d="M9.5 5V3.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3V5" /><path d="M12 10.5v6M9.2 13.3h5.6" /></>,
};

export const AppIcon: React.FC<{ name: IconName; size?: number; className?: string; strokeWidth?: number }> = ({
  name, size = 15, className, strokeWidth = 1.8
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className={`app-icon ${className || ''}`}
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {PATHS[name]}
  </svg>
);

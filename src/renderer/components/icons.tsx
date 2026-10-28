/**
 * Inline SVG icon set. Icons are components, never an emoji or an icon font:
 * they inherit `currentColor`, size from the CSS token `--size-icon`, and are
 * always decorative (`aria-hidden`), because the control around them carries
 * the accessible name.
 */
import type { ReactElement, ReactNode } from 'react';

interface IconBaseProps {
  children: ReactNode;
  className?: string;
}

function IconBase({ children, className }: IconBaseProps): ReactElement {
  return (
    <svg
      className={className ? `pds-icon ${className}` : 'pds-icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export interface IconProps {
  className?: string;
}

export function SparkIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.4l-1.9-5.6L4.5 10.9 10.1 9 12 3.5Z" />
      <path d="M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </IconBase>
  );
}

export function ChatIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M20 12.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-6.2A7.5 7.5 0 0 1 4 12.5 7.5 7.5 0 0 1 11.5 5h1A7.5 7.5 0 0 1 20 12.5Z" />
      <path d="M8.5 11h7M8.5 14.5h4.5" />
    </IconBase>
  );
}

export function AgentsIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3.5V7M9 12.5v1.5M15 12.5v1.5M2.5 11.5v3M21.5 11.5v3" />
    </IconBase>
  );
}

export function ModelsIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M12 3 3.5 7.5 12 12l8.5-4.5L12 3Z" />
      <path d="M3.5 12 12 16.5 20.5 12M3.5 16.5 12 21l8.5-4.5" />
    </IconBase>
  );
}

export function SettingsIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="18" r="2" />
    </IconBase>
  );
}

export function SyncIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M6.5 18.5h10a3.5 3.5 0 0 0 .5-6.96A5.5 5.5 0 0 0 6.6 9.2 4.7 4.7 0 0 0 6.5 18.5Z" />
      <path d="M9.5 15.5 12 18l2.5-2.5M12 10.5V18" />
    </IconBase>
  );
}

export function PlusIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  );
}

export function SearchIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </IconBase>
  );
}

export function SendIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M4.5 12 20 4.5 16.5 20l-4-6.5L4.5 12Z" />
      <path d="M12.5 13.5 20 4.5" />
    </IconBase>
  );
}

export function StopIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    </IconBase>
  );
}

export function CopyIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" />
    </IconBase>
  );
}

export function CheckIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="m5 12.5 4.5 4.5L19 6.5" />
    </IconBase>
  );
}

export function CheckCircleIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </IconBase>
  );
}

export function TrashIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M4.5 7h15M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
      <path d="M10.5 11v6M13.5 11v6" />
    </IconBase>
  );
}

export function PencilIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5l-1 3Z" />
      <path d="m14.5 7.5 2 2" />
    </IconBase>
  );
}

export function CloseIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconBase>
  );
}

export function ChevronDownIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="m6 9.5 6 6 6-6" />
    </IconBase>
  );
}

export function ArrowDownIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M12 4.5v15M6 13.5l6 6 6-6" />
    </IconBase>
  );
}

export function AlertTriangleIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M12 4.5 21 20H3L12 4.5Z" />
      <path d="M12 10v4.5M12 17.5v.5" />
    </IconBase>
  );
}

export function AlertCircleIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.5v.5" />
    </IconBase>
  );
}

export function InfoIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v6M12 7.5v.5" />
    </IconBase>
  );
}

export function RefreshIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M20 12a8 8 0 1 1-2.5-5.8" />
      <path d="M20 4.5V10h-5.5" />
    </IconBase>
  );
}

export function ExternalLinkIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M13.5 4.5H20v6.5M20 4.5l-8.5 8.5" />
      <path d="M18 14v5.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5.5" />
    </IconBase>
  );
}

export function OfflineIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <path d="M6.5 18.5h10a3.5 3.5 0 0 0 1.4-6.7" />
      <path d="M8.6 10.2A5.5 5.5 0 0 0 6.5 20" />
      <path d="m3.5 3.5 17 17" />
    </IconBase>
  );
}

export function KeyIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <circle cx="8" cy="8" r="4.5" />
      <path d="m11.5 11.5 8 8M16.5 16.5l2-2M14 14l2-2" />
    </IconBase>
  );
}

export function ClockIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </IconBase>
  );
}

export function PanelIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </IconBase>
  );
}

export function UserIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </IconBase>
  );
}

export function DatabaseIcon({ className }: IconProps): ReactElement {
  return (
    <IconBase className={className}>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
      <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </IconBase>
  );
}

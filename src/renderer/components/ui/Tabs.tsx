import { useId, type KeyboardEvent, type ReactElement } from 'react';

export interface TabItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange(id: string): void;
  /** Accessible name for the tab list. */
  label: string;
  className?: string;
}

/** Stable ids so a consumer can render the matching panel. */
export function tabButtonId(id: string): string {
  return `pds-tab-${id}`;
}

export function tabPanelId(id: string): string {
  return `pds-panel-${id}`;
}

/**
 * Tabs with the WAI-ARIA activation model: one tab in the tab order, arrow keys
 * move and activate, Home/End jump to the ends. The consumer renders the panel
 * with `role="tabpanel"` and the ids above.
 */
export function Tabs({ items, value, onChange, label, className }: TabsProps): ReactElement {
  const base = useId();

  const enabledIndex = (from: number, direction: 1 | -1): void => {
    if (items.length === 0) return;
    let index = from;
    for (let step = 0; step < items.length; step += 1) {
      index = (index + direction + items.length) % items.length;
      const item = items[index];
      if (item && !item.disabled) {
        onChange(item.id);
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = items.findIndex((item) => item.id === value);
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        enabledIndex(current, 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        enabledIndex(current, -1);
        break;
      case 'Home':
        event.preventDefault();
        enabledIndex(-1, 1);
        break;
      case 'End':
        event.preventDefault();
        enabledIndex(0, -1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      className={className ? `pds-tabs ${className}` : 'pds-tabs'}
      role="tablist"
      aria-label={label}
      id={`${base}-tablist`}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabButtonId(item.id)}
            className={selected ? 'pds-tab pds-tab--selected' : 'pds-tab'}
            aria-selected={selected}
            aria-controls={tabPanelId(item.id)}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled === true}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

import { useId, type ReactElement } from 'react';

export interface SwitchProps {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  hint?: string;
  disabled?: boolean;
}

/** Boolean control. A button with `role="switch"`, not a checkbox in disguise. */
export function Switch({
  label,
  checked,
  onChange,
  hint,
  disabled = false,
}: SwitchProps): ReactElement {
  const generated = useId();
  const id = `switch-${generated}`;
  const hintId = `${id}-hint`;

  return (
    <div className="pds-switch-field">
      <span className="pds-switch-field__text">
        <label className="pds-switch-field__label" htmlFor={id}>
          {label}
        </label>
        {hint ? (
          <span className="pds-field__hint" id={hintId}>
            {hint}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        id={id}
        role="switch"
        className="pds-switch"
        aria-checked={checked}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        data-checked={checked ? 'true' : 'false'}
        onClick={() => onChange(!checked)}
      >
        <span className="pds-switch__thumb" aria-hidden="true" />
      </button>
    </div>
  );
}

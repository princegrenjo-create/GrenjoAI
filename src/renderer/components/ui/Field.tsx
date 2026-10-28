import { useId, type ReactElement } from 'react';

export interface FieldControl {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

export interface FieldProps {
  label: string;
  /** Helper text, replaced by `error` when the value is invalid. */
  hint?: string;
  error?: string;
  required?: boolean;
  /** Keep the label for assistive tech but hide it visually (e.g. search). */
  labelHidden?: boolean;
  /** Caller-supplied control id; generated when omitted. */
  controlId?: string;
  className?: string;
  /** Render the control with the ids this field owns. */
  children: (control: FieldControl) => ReactElement;
}

/**
 * Label above the control, helper below, error replacing the helper. The wiring
 * (`htmlFor`, `aria-describedby`, `aria-invalid`) is computed once here so a
 * control can never be labelled by a placeholder or announce its error twice.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  labelHidden = false,
  controlId,
  className,
  children,
}: FieldProps): ReactElement {
  const generated = useId();
  const id = controlId ?? `field-${generated}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = Boolean(error);
  const describedBy = invalid ? errorId : hint ? hintId : undefined;

  return (
    <div className={className ? `pds-field ${className}` : 'pds-field'}>
      <label className={labelHidden ? 'pds-sr-only' : 'pds-field__label'} htmlFor={id}>
        {label}
        {required ? <span className="pds-field__required"> (required)</span> : null}
      </label>
      {children({ id, describedBy, invalid })}
      {invalid ? (
        <p className="pds-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="pds-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

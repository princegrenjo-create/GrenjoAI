import type { ReactElement, TextareaHTMLAttributes } from 'react';
import { Field } from './Field';

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string;
  labelHidden?: boolean;
  id?: string;
  /** Grows with its content (CSS `field-sizing`), capped by a token. */
  autoGrow?: boolean;
}

/** Multiline text control. Enter never submits; the owner decides that. */
export function Textarea({
  label,
  hint,
  error,
  labelHidden = false,
  id,
  autoGrow = false,
  className,
  rows = 3,
  ...rest
}: TextareaProps): ReactElement {
  return (
    <Field label={label} hint={hint} error={error} labelHidden={labelHidden} controlId={id}>
      {(control) => (
        <textarea
          {...rest}
          rows={rows}
          id={control.id}
          className={[
            'pds-textarea',
            autoGrow ? 'pds-textarea--auto' : '',
            control.invalid ? 'pds-textarea--invalid' : '',
            className ?? '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
        />
      )}
    </Field>
  );
}

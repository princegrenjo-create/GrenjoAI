import type { InputHTMLAttributes, ReactElement, ReactNode } from 'react';
import { Field } from './Field';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'size'> {
  label: string;
  hint?: string;
  error?: string;
  labelHidden?: boolean;
  id?: string;
  leadingIcon?: ReactNode;
}

/** Single-line text control, labelled above, invalid state announced once. */
export function Input({
  label,
  hint,
  error,
  labelHidden = false,
  id,
  leadingIcon,
  className,
  ...rest
}: InputProps): ReactElement {
  return (
    <Field label={label} hint={hint} error={error} labelHidden={labelHidden} controlId={id}>
      {(control) => (
        <span className={leadingIcon ? 'pds-input-wrap pds-input-wrap--icon' : 'pds-input-wrap'}>
          {leadingIcon ? (
            <span className="pds-input__leading" aria-hidden="true">
              {leadingIcon}
            </span>
          ) : null}
          <input
            {...rest}
            id={control.id}
            className={[
              'pds-input',
              control.invalid ? 'pds-input--invalid' : '',
              className ?? '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-invalid={control.invalid || undefined}
            aria-describedby={control.describedBy}
          />
        </span>
      )}
    </Field>
  );
}

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { ChevronDownIcon } from '../icons';
import { Field } from './Field';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: string;
  value: string;
  options: SelectOption[];
  onChange(value: string): void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  labelHidden?: boolean;
  placeholder?: string;
  id?: string;
  size?: 'sm' | 'md';
  className?: string;
}

function firstEnabled(options: SelectOption[], from: number, direction: 1 | -1): number {
  if (options.length === 0) return -1;
  let index = from;
  for (let step = 0; step < options.length; step += 1) {
    index = (index + direction + options.length) % options.length;
    const option = options[index];
    if (option && !option.disabled) return index;
  }
  return -1;
}

/**
 * Custom listbox. It never renders a native `<select>`: the trigger, the popup,
 * the option states and the keyboard model are all the product's, and the
 * combobox pattern is kept (`role="combobox"`, `aria-expanded`,
 * `aria-activedescendant`) so it stays usable from the keyboard and by a screen
 * reader.
 */
export function Select({
  label,
  value,
  options,
  onChange,
  hint,
  error,
  disabled = false,
  labelHidden = false,
  placeholder = 'Select an option',
  id,
  size = 'md',
  className,
}: SelectProps): ReactElement {
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [activeIndex, setActiveIndex] = useState(selectedIndex >= 0 ? selectedIndex : 0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const openList = (): void => {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabled(options, -1, 1));
    setOpen(true);
  };

  const choose = (index: number): void => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };

  const move = (direction: 1 | -1): void => {
    const next = firstEnabled(options, activeIndex, direction);
    if (next >= 0) setActiveIndex(next);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (open) move(1);
        else openList();
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (open) move(-1);
        else openList();
        break;
      case 'Home':
        if (open) {
          event.preventDefault();
          setActiveIndex(firstEnabled(options, -1, 1));
        }
        break;
      case 'End':
        if (open) {
          event.preventDefault();
          setActiveIndex(firstEnabled(options, 0, -1));
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) choose(activeIndex);
        else openList();
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const activeId = `${listboxId}-option-${activeIndex}`;

  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      labelHidden={labelHidden}
      controlId={id}
      className={className}
    >
      {(control) => (
        <div className="pds-select" ref={rootRef} data-open={open ? 'true' : undefined}>
          <button
            type="button"
            id={control.id}
            role="combobox"
            className={`pds-select__trigger pds-select__trigger--${size}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-activedescendant={open ? activeId : undefined}
            aria-invalid={control.invalid || undefined}
            aria-describedby={control.describedBy}
            disabled={disabled}
            onClick={() => {
              if (open) setOpen(false);
              else openList();
            }}
            onKeyDown={onTriggerKeyDown}
          >
            <span className={selected ? 'pds-select__value' : 'pds-select__placeholder'}>
              {selected ? selected.label : placeholder}
            </span>
            <ChevronDownIcon className="pds-select__chevron" />
          </button>
          {open ? (
            <ul className="pds-select__popup" role="listbox" id={listboxId} aria-labelledby={control.id}>
              {options.map((option, index) => (
                <li
                  key={option.value}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  className={[
                    'pds-select__option',
                    index === activeIndex ? 'pds-select__option--active' : '',
                    option.value === value ? 'pds-select__option--selected' : '',
                    option.disabled ? 'pds-select__option--disabled' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <span className="pds-select__option-label">{option.label}</span>
                  {option.description ? (
                    <span className="pds-select__option-description">{option.description}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Field>
  );
}

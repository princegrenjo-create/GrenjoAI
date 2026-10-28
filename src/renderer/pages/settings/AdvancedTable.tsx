/**
 * Advanced configuration as a table: every declared key with its type, its range,
 * its documented default, a sentence saying what it does, the current value and a
 * per-row reset.
 *
 * The row header carries the name, so the control repeats it only for assistive
 * technology (`labelHidden`, and the switch label is visually hidden by the page
 * stylesheet while staying associated).
 */
import type { ReactElement } from 'react';
import type { AppLogLevel, AppSettings, AppSettingsPatch } from '@shared/types';
import { Button, Select, Switch } from '@renderer/components/ui';
import {
  ADVANCED_SPECS,
  advancedDefault,
  formatDefaultValue,
  type AdvancedSpec,
} from './advanced-specs';
import { NumberField } from './ParamControls';

function advancedPatch<K extends keyof AppSettings['advanced']>(
  key: K,
  value: AppSettings['advanced'][K],
): AppSettingsPatch {
  const section: Partial<AppSettings['advanced']> = {};
  section[key] = value;
  return { advanced: section };
}

export interface AdvancedTableProps {
  settings: AppSettings;
  onPatch(patch: AppSettingsPatch): void;
}

interface AdvancedRowProps extends AdvancedTableProps {
  spec: AdvancedSpec;
}

function AdvancedRow({ spec, settings, onPatch }: AdvancedRowProps): ReactElement {
  const header = (
    <>
      <th scope="row" className="pds-advanced__setting">
        <span className="pds-advanced__label">{spec.label}</span>
        <code className="pds-advanced__key">{spec.key}</code>
        <span className="pds-advanced__description">{spec.description}</span>
      </th>
      <td className="pds-advanced__type">{spec.type}</td>
      <td className="pds-advanced__range">{spec.range}</td>
    </>
  );

  switch (spec.control) {
    case 'switch': {
      const value = settings.advanced[spec.key];
      const fallback = advancedDefault(spec.key);
      return (
        <tr className="pds-advanced__row">
          {header}
          <td className="pds-advanced__default">{formatDefaultValue(fallback)}</td>
          <td className="pds-advanced__control">
            <Switch
              label={spec.label}
              checked={value}
              onChange={(checked) => onPatch(advancedPatch(spec.key, checked))}
            />
          </td>
          <td className="pds-advanced__reset">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Reset ${spec.label} to the default`}
              disabled={value === fallback}
              onClick={() => onPatch(advancedPatch(spec.key, fallback))}
            >
              Reset
            </Button>
          </td>
        </tr>
      );
    }
    case 'number': {
      const value = settings.advanced[spec.key];
      const fallback = advancedDefault(spec.key);
      return (
        <tr className="pds-advanced__row">
          {header}
          <td className="pds-advanced__default">{formatDefaultValue(fallback)}</td>
          <td className="pds-advanced__control">
            <NumberField
              label={spec.label}
              labelHidden
              value={value}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              integer
              commitOn="blur"
              onChange={(next) => onPatch(advancedPatch(spec.key, next))}
            />
          </td>
          <td className="pds-advanced__reset">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Reset ${spec.label} to the default`}
              disabled={value === fallback}
              onClick={() => onPatch(advancedPatch(spec.key, fallback))}
            >
              Reset
            </Button>
          </td>
        </tr>
      );
    }
    case 'select':
    default: {
      const value: AppLogLevel = settings.advanced[spec.key];
      const fallback = advancedDefault(spec.key);
      return (
        <tr className="pds-advanced__row">
          {header}
          <td className="pds-advanced__default">{formatDefaultValue(fallback)}</td>
          <td className="pds-advanced__control">
            <Select
              label={spec.label}
              labelHidden
              size="sm"
              value={value}
              options={spec.options}
              onChange={(next) => {
                const option = spec.options.find((entry) => entry.value === next);
                if (option) onPatch(advancedPatch(spec.key, option.value));
              }}
            />
          </td>
          <td className="pds-advanced__reset">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Reset ${spec.label} to the default`}
              disabled={value === fallback}
              onClick={() => onPatch(advancedPatch(spec.key, fallback))}
            >
              Reset
            </Button>
          </td>
        </tr>
      );
    }
  }
}

export function AdvancedTable({ settings, onPatch }: AdvancedTableProps): ReactElement {
  return (
    <div className="pds-advanced__scroll">
      <table className="pds-advanced">
        <caption className="pds-sr-only">
          Advanced configuration: each declared key, its type, range, default and current value.
        </caption>
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">Type</th>
            <th scope="col">Range</th>
            <th scope="col">Default</th>
            <th scope="col">Value</th>
            <th scope="col">Reset</th>
          </tr>
        </thead>
        <tbody>
          {ADVANCED_SPECS.map((spec) => (
            <AdvancedRow key={spec.key} spec={spec} settings={settings} onPatch={onPatch} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

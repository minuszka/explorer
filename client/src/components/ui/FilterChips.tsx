import { formatNumber } from '../../utils/formatters';
import './tableControls.css';

export interface FilterChipOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface FilterChipsProps<T extends string> {
  options: FilterChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers, for example "Status". */
  label: string;
}

/** A row of toggle buttons; exactly one is pressed. */
export default function FilterChips<T extends string>({ options, value, onChange, label }: FilterChipsProps<T>) {
  return (
    <div className="filter-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="filter-chip"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count != null && <span className="filter-chip-count">{formatNumber(option.count)}</span>}
        </button>
      ))}
    </div>
  );
}

import { useId } from 'react';
import { HiOutlineMagnifyingGlass, HiOutlineXMark } from 'react-icons/hi2';
import './tableControls.css';

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The visible label, for example "Search masternodes". */
  label: string;
  placeholder?: string;
}

/** A labelled search box with a clear button. */
export default function SearchField({ value, onChange, label, placeholder }: SearchFieldProps) {
  const id = useId();
  return (
    <div className="search-field">
      <label htmlFor={id} className="search-field-label">
        {label}
      </label>
      <div className="search-field-box">
        <HiOutlineMagnifyingGlass aria-hidden="true" className="search-field-icon" />
        <input
          id={id}
          type="search"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        {value !== '' && (
          <button type="button" className="search-field-clear" onClick={() => onChange('')} aria-label="Clear search">
            <HiOutlineXMark aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

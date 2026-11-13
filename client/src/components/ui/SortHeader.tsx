import { HiChevronDown, HiChevronUp, HiChevronUpDown } from 'react-icons/hi2';
import './tableControls.css';

export type SortDirection = 'asc' | 'desc';

interface SortHeaderProps<K extends string> {
  sortKey: K;
  label: string;
  active: K;
  direction: SortDirection;
  onSort: (key: K) => void;
  className?: string;
}

/** A table header cell that sorts by its column when clicked; a second click reverses the order. */
export default function SortHeader<K extends string>({ sortKey, label, active, direction, onSort, className }: SortHeaderProps<K>) {
  const isActive = active === sortKey;
  const ariaSort = isActive ? (direction === 'asc' ? 'ascending' : 'descending') : 'none';
  const Icon = !isActive ? HiChevronUpDown : direction === 'asc' ? HiChevronUp : HiChevronDown;
  return (
    <th aria-sort={ariaSort} className={className}>
      <button type="button" className={`sort-header${isActive ? ' active' : ''}`} onClick={() => onSort(sortKey)}>
        {label}
        <Icon aria-hidden="true" />
      </button>
    </th>
  );
}

import { forwardRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import { searchPath } from '../../utils/routes';

interface HeaderSearchProps {
  /** On narrow screens the search row is shown only while open. */
  open: boolean;
  onClose: () => void;
}

/** The site-wide search. A submitted query goes to /search, which opens the object's own page. */
const HeaderSearch = forwardRef<HTMLInputElement, HeaderSearchProps>(function HeaderSearch({ open, onClose }, ref) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized) return;
    navigate(searchPath(normalized));
    setQuery('');
    event.currentTarget.querySelector('input')?.blur();
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.currentTarget.blur();
    onClose();
  };

  return (
    <form
      id="header-search"
      role="search"
      className={`header-search search-container ${open ? 'open' : ''}`}
      onSubmit={handleSubmit}
    >
      <label className="sr-only" htmlFor="header-search-input">
        Search the explorer
      </label>
      <HiOutlineMagnifyingGlass className="search-icon" aria-hidden="true" />
      <input
        ref={ref}
        id="header-search-input"
        type="search"
        className="search-input"
        placeholder="Search height, block hash, txid or address"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    </form>
  );
});

export default HeaderSearch;

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  HiOutlineBars3,
  HiOutlineCodeBracket,
  HiOutlineCube,
  HiOutlineGlobeAlt,
  HiOutlineInformationCircle,
  HiOutlineMagnifyingGlass,
  HiOutlineServerStack,
  HiOutlineSquares2X2,
  HiOutlineWrenchScrewdriver,
  HiOutlineXMark,
} from 'react-icons/hi2';
import HeaderNavigation, { type HeaderNavItem } from './HeaderNavigation';
import HeaderSearch from './HeaderSearch';
import HeaderStatusChips from './HeaderStatusChips';
import logoUrl from '../../assets/defcon-logo-64.png';
import './Header.css';

const DEV_TOOLS_NAV_ITEM: HeaderNavItem = {
  path: '/provider-tags',
  label: 'Dev Tools',
  icon: HiOutlineWrenchScrewdriver,
  tone: 'devtools',
  placement: 'end',
  aliases: [
    '/provider-tags',
    '/devtools/provider-tags',
    '/devtools/pose-penalty',
    '/devtools/node-inventory',
    '/devtools/network-noise',
  ],
  children: [
    { path: '/devtools/node-inventory', label: 'Node Inventory' },
    { path: '/devtools/network-noise', label: 'Network Noise Monitor' },
    { path: '/devtools/pose-penalty', label: 'PoSe Penalty Watch' },
  ],
};

const NAV_ITEMS: HeaderNavItem[] = [
  { path: '/', label: 'Dashboard', icon: HiOutlineSquares2X2, end: true },
  {
    path: '/txs',
    label: 'Explorer',
    icon: HiOutlineCube,
    aliases: ['/blocks', '/block', '/tx', '/search', '/address', '/richlist', '/mempool', '/bubblemaps'],
    children: [
      { path: '/txs', label: 'Transactions' },
      { path: '/richlist', label: 'Rich List' },
    ],
  },
  {
    path: '/masternodes',
    label: 'Masternodes',
    icon: HiOutlineServerStack,
    aliases: ['/mn-health'],
    children: [
      { path: '/masternodes', label: 'Masternode List' },
      { path: '/ban-detection', label: 'PoSe Watch' },
      { path: '/mining', label: 'Rewards' },
    ],
  },
  {
    path: '/network',
    label: 'Network',
    icon: HiOutlineGlobeAlt,
    aliases: ['/chain-health', '/crawler'],
    children: [
      { path: '/network', label: 'Overview' },
      { path: '/chain-health', label: 'Nodes' },
    ],
  },
  { path: '/api', label: 'API', icon: HiOutlineCodeBracket },
  { path: '/about', label: 'About', icon: HiOutlineInformationCircle },
  DEV_TOOLS_NAV_ITEM,
];

/** True when the key press happened while the user was typing somewhere. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export default function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const MOBILE_BREAKPOINT = 1080;

  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const openSearch = useCallback(() => {
    setMobileOpen(false);
    setSearchOpen(true);
    setSearchFocusRequest((count) => count + 1);
  }, []);

  // Focus after the render that shows the narrow-screen search row.
  useEffect(() => {
    if (searchFocusRequest > 0) searchInputRef.current?.focus();
  }, [searchFocusRequest]);

  // "/" jumps to the search from anywhere except while typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openSearch]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) {
        setMobileOpen(false);
        setSearchOpen(false);
      }
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <header className="header">
      <div className="header-shell container">
        <div className="header-top">
          <Link to="/" className="header-brand" onClick={closeMobile}>
            <img className="header-brand-logo" src={logoUrl} alt="" width={32} height={32} />
            <span className="header-brand-title">DeFCoN Explorer</span>
          </Link>

          <HeaderSearch ref={searchInputRef} open={searchOpen} onClose={closeSearch} />

          <div className="header-top-actions">
            <HeaderStatusChips />

            <button
              type="button"
              className="header-icon-button search-toggle"
              onClick={searchOpen ? closeSearch : openSearch}
              aria-expanded={searchOpen}
              aria-controls="header-search"
              aria-label={searchOpen ? 'Close search' : 'Open search'}
            >
              {searchOpen ? <HiOutlineXMark /> : <HiOutlineMagnifyingGlass />}
            </button>

            <button
              type="button"
              className="header-icon-button mobile-toggle"
              onClick={() => {
                setSearchOpen(false);
                setMobileOpen((prev) => !prev);
              }}
              aria-expanded={mobileOpen}
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            >
              {mobileOpen ? <HiOutlineXMark /> : <HiOutlineBars3 />}
            </button>
          </div>
        </div>

        <div className="header-nav-shell">
          <HeaderNavigation items={NAV_ITEMS} className="header-nav" onNavigate={closeMobile} />
        </div>
      </div>

      <div className={`mobile-drawer ${mobileOpen ? 'open' : ''}`}>
        <div className="mobile-drawer-inner container">
          <HeaderStatusChips compact />
          <HeaderNavigation
            items={NAV_ITEMS}
            className="mobile-nav"
            linkClassName="mobile-nav-link"
            isMobile
            onNavigate={closeMobile}
          />
        </div>
      </div>

      {mobileOpen && (
        <button
          type="button"
          className="mobile-overlay"
          onClick={closeMobile}
          aria-label="Close menu overlay"
        />
      )}
    </header>
  );
}

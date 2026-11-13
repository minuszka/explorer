import { useEffect, useRef, useState } from 'react';
import { HiOutlineStar, HiStar } from 'react-icons/hi2';
import { MAX_FAVORITES, useFavoriteMasternodes } from '../../utils/favoriteMasternodes';
import './FavoriteButton.css';

const NOTICE_MS = 3000;

/**
 * A star that adds a masternode to "My nodes" or removes it. `label` names the node for screen
 * readers ("Star 203.0.113.5:9999"); the pressed state says whether it is starred. A full list
 * refuses the star and says so next to the button.
 */
export default function FavoriteButton({ proTxHash, label }: { proTxHash: string; label: string }) {
  const { isFavorite, toggle } = useFavoriteMasternodes();
  const [notice, setNotice] = useState('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const starred = isFavorite(proTxHash);
  const onClick = () => {
    const result = toggle(proTxHash);
    window.clearTimeout(timer.current);
    setNotice(result === 'full' ? `My nodes is full (${MAX_FAVORITES}). Remove a star first.` : '');
    if (result === 'full') timer.current = window.setTimeout(() => setNotice(''), NOTICE_MS);
  };

  return (
    <span className="favorite-button-wrap">
      <button
        type="button"
        className={`favorite-button${starred ? ' starred' : ''}`}
        aria-pressed={starred}
        aria-label={`Star ${label}`}
        title={starred ? 'In My nodes. Click to remove.' : 'Add to My nodes'}
        onClick={onClick}
      >
        {starred ? <HiStar aria-hidden="true" /> : <HiOutlineStar aria-hidden="true" />}
      </button>
      <span className="favorite-button-status" role="status" aria-live="polite">
        {notice}
      </span>
    </span>
  );
}

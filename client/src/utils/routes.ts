/** The one address of each chain object on the site. */
export function blockPath(heightOrHash: number | string): string {
  return `/block/${encodeURIComponent(String(heightOrHash))}`;
}

export function txPath(txid: string): string {
  return `/tx/${encodeURIComponent(txid)}`;
}

export function addressPath(address: string): string {
  return `/address/${encodeURIComponent(address)}`;
}

/** A masternode registration is named by its proTxHash (64 hex characters). */
export function isProTxHash(value: string | null | undefined): value is string {
  return /^[0-9a-fA-F]{64}$/.test(value ?? '');
}

export function masternodePath(proTxHash: string): string {
  return `/masternode/${encodeURIComponent(proTxHash.toLowerCase())}`;
}

/** The search page resolves a free-text query and moves on to one of the paths above. */
export function searchPath(query: string): string {
  return `/search?q=${encodeURIComponent(query)}`;
}

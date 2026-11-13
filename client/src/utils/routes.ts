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

/** The search page resolves a free-text query and moves on to one of the paths above. */
export function searchPath(query: string): string {
  return `/search?q=${encodeURIComponent(query)}`;
}

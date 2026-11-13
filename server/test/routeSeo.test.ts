import { describe, expect, it } from 'vitest';
import { resolveRouteSeo } from '../../shared/src/routeSeo';

describe('shared route SEO metadata', () => {
  it.each([
    ['/chain-health', 'Node Monitor'],
    ['/provider-tags', 'Provider Tags'],
    ['/ban-detection', 'PoSe Watch'],
    ['/devtools/pose-penalty', 'PoSe Penalty Watch'],
    ['/devtools/node-inventory', 'Node Version Inventory'],
    ['/devtools/network-noise', 'Network Noise Monitor'],
  ])('resolves the SPA route %s on the initial server response', (pathname, title) => {
    const seo = resolveRouteSeo(pathname);

    expect(seo.title).toContain(title);
    expect(seo.title).not.toContain('Page Not Found');
  });

  it('normalizes trailing slashes and dynamic detail routes', () => {
    expect(resolveRouteSeo('/about/').canonicalPath).toBe('/about');
    expect(resolveRouteSeo('/block/108705').title).toContain('Block Details');
    expect(resolveRouteSeo('/tx/example').title).toContain('Transaction Details');
    expect(resolveRouteSeo('/address/example').title).toContain('Address Details');
    expect(resolveRouteSeo(`/masternode/${'a'.repeat(64)}`).title).toContain('Masternode Details');
    expect(resolveRouteSeo('/masternodes').title).not.toContain('Masternode Details');
  });

  it('uses the redirect target as the canonical URL', () => {
    expect(resolveRouteSeo('/wallets/')).toEqual(resolveRouteSeo('/richlist'));
    expect(resolveRouteSeo('/crawler')).toMatchObject({
      canonicalPath: '/chain-health',
      title: expect.stringContaining('Node Monitor'),
    });
    expect(resolveRouteSeo('/devtools/provider-tags')).toMatchObject({
      canonicalPath: '/provider-tags',
      title: expect.stringContaining('Provider Tags'),
    });
  });

  it('keeps unknown routes out of the search index', () => {
    expect(resolveRouteSeo('/does-not-exist')).toMatchObject({
      title: expect.stringContaining('Page Not Found'),
      robots: 'noindex, follow',
    });
  });
});

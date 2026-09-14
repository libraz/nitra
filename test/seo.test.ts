/**
 * The page a link to nitra resolves to.
 *
 * There is one URL and four places that have to agree on it — the canonical
 * link, the card metadata, the structured description and the sitemap — so the
 * failure worth catching is the one where the site moves and three of them
 * follow. The rest of this asserts what a crawler that does not run scripts is
 * given, which is the static block inside `#root` and nothing else.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SITE = 'https://nitra.libraz.net/';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const robots = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');
const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');

/** The content of a `<meta>` carrying the given name or property. */
function meta(key: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]*(?:name|property)="${key}"[^>]*content="([^"]*)"|` +
      `<meta[^>]*content="([^"]*)"[^>]*(?:name|property)="${key}"`,
    's',
  );
  const found = html.match(pattern);
  return found ? (found[1] ?? found[2] ?? null) : null;
}

/** The `content` of a multi-line `<meta>`, which is how the long ones are formatted. */
function metaBlock(key: string): string | null {
  const found = html.match(new RegExp(`name="${key}"\\s*\\n?\\s*content="([^"]*)"`, 's'));
  return found?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
}

describe('page metadata', () => {
  it('points every address at the same site', () => {
    expect(html).toContain(`<link rel="canonical" href="${SITE}" />`);
    expect(meta('og:url')).toBe(SITE);
    expect(meta('og:image')).toBe(`${SITE}og.png`);
    expect(sitemap).toContain(`<loc>${SITE}</loc>`);
    expect(robots).toContain(`Sitemap: ${SITE}sitemap.xml`);
  });

  it('gives the search result a title and a description that will not be cut', () => {
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    expect(title).toContain('nitra');
    expect(title.length).toBeLessThanOrEqual(70);

    const description = metaBlock('description') ?? '';
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it('describes the app as the free, browser-run thing it is', () => {
    const block = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1] ?? '';
    const data = JSON.parse(block) as Record<string, unknown>;

    expect(data['@type']).toBe('SoftwareApplication');
    expect(data.url).toBe(SITE);
    expect(data.isAccessibleForFree).toBe(true);
    expect(data.offers).toMatchObject({ price: '0' });
    expect(data.inLanguage).toEqual(['en', 'ja']);
  });

  it('declares both appearances rather than pinning one', () => {
    // The app ships light and dark and follows the system by default; a page
    // that says `dark` here renders its first paint against the wrong surround.
    expect(meta('color-scheme')).toBe('light dark');
  });
});

describe('the page without scripts', () => {
  it('serves the description inside the root element', () => {
    const root = html.match(/<div id="root">(.*?)<\/div>\s*<noscript>/s)?.[1] ?? '';
    expect(root).toContain('<h1>nitra</h1>');
    expect(root).toContain('lang="ja"');
    expect(root.replace(/<[^>]*>/g, '').trim().length).toBeGreaterThan(400);
  });
});

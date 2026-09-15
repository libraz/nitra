/**
 * Where the project itself lives.
 *
 * The addresses are here rather than next to the components that link to them,
 * because the guide, the about sheet and the status bar all point at the same
 * repository, and three copies of a URL is three places for one of them to go
 * stale.
 *
 * The links are data so the catalogue can be checked against them: a row added
 * without its caption would otherwise reach the screen as a raw key.
 */

import type { MessageKey } from '../i18n';

export const REPO = 'https://github.com/libraz/nitra';

/** The version this build was cut from, substituted at build time. */
export const VERSION: string = __APP_VERSION__;

export const LICENCE = 'AGPL-3.0';

export interface ProjectLink {
  key: string;
  href: string;
  label: MessageKey;
}

export const PROJECT_LINKS: readonly ProjectLink[] = [
  { key: 'repo', href: REPO, label: 'about.linkRepo' },
  { key: 'licence', href: `${REPO}/blob/main/LICENSE`, label: 'about.linkLicence' },
];

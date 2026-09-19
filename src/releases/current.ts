import type { Locale } from '../i18n/index.js';

// Update the ID and both translations for each deployment with user-facing changes.
// IDs are increasing UTC timestamps; an ordinary restart keeps the same ID.
export const currentRelease = {
  id: '2026-09-19T21:23:00Z',
  changes: {
    en: 'Jolanda can now post release notes in a channel chosen by your server. Each new release explains what changed and how to use it. Ordinary restarts do not repeat the announcement.',
    sk: 'Jolanda teraz vie posielať prehľad zmien do kanála zvoleného na vašom serveri. Každé nové vydanie vysvetlí, čo sa zmenilo a ako to používať. Bežný reštart oznámenie nezopakuje.',
  },
  usage: {
    en: 'Members with Manage Server can use `/jolanda releases set channel:#updates`. This saves the channel and posts the current release if it has not been announced here yet. Use `/jolanda releases status` to check the setting or `/jolanda releases disable` to turn it off. Notes are visible to everyone who can read the selected channel; nobody is pinged.',
    sk: 'Členovia s oprávnením Spravovať server môžu použiť `/jolanda releases set channel:#novinky`. Kanál sa uloží a aktuálne vydanie sa odošle, ak ešte nebolo na tomto serveri oznámené. Nastavenie zobrazí `/jolanda releases status`, vypne ho `/jolanda releases disable`. Prehľad vidí každý, kto má prístup do vybraného kanála; nikoho neoznačuje.',
  },
};

export const renderRelease = (locale: Locale) =>
  [
    locale === 'en' ? '**Jolanda updated**' : '**Jolanda má nové funkcie**',
    currentRelease.changes[locale],
    currentRelease.usage[locale],
    locale === 'en'
      ? 'If you do not see the changes or new commands, restart Discord.'
      : 'Ak nevidíte zmeny alebo nové príkazy, reštartujte Discord.',
  ].join('\n\n');

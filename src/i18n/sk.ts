import type { ModelFailureCategory, ModelMalformedReason } from '../model-failure.js';
import type { NewsFeed, NewsSourceResult } from '../news/types.js';
import type { ReelFailure } from '../reel-types.js';
import type { TurnOutcome } from '../types.js';
import { plural, type Locale } from './plural.js';
import type {
  BriefingStatusFacts,
  NewsStatusFacts,
  PrivacyFacts,
  ReminderRow,
  SettingsFacts,
  UsageFacts,
} from './shapes.js';

const locale: Locale = 'sk';

const feedLabel = {
  continuous: 'Priebežné · Denník N',
  daily: 'Denné · Aktuality.sk',
} satisfies Record<NewsFeed, string>;

const feedName = { continuous: 'priebežné', daily: 'denné' } satisfies Record<NewsFeed, string>;

const outcomeLabel = {
  stories: 'Správy zozbierané',
  edition: 'Redakčné vydanie zozbierané',
  unchanged: 'Zdroj nezmenený',
  empty: 'Nenašli sa žiadne položky ani vydanie',
  stale: 'Nenašlo sa žiadne aktuálne vydanie',
  malformed: 'Parser zdroja zlyhal',
  'access-denied': 'Vydavateľ odmietol prístup',
  'rate-limited': 'Limit požiadaviek vydavateľa',
  unavailable: 'Vydavateľ nedostupný',
  timeout: 'Požiadavka na zdroj vypršala',
  cancelled: 'Zbieranie zrušené',
} satisfies Record<NonNullable<NewsSourceResult['outcome']>, string>;

const notCollectedYet = 'Ešte nezozbierané';
const recentDays = (count: number) =>
  plural(locale, count, {
    one: 'posledný {count} deň',
    few: 'posledné {count} dni',
    other: 'posledných {count} dní',
  });
const dayCount = (count: number) =>
  plural(locale, count, { one: '{count} deň', few: '{count} dni', other: '{count} dní' });
const usageHeading = (count: number) => `📊 Spotreba Jolandy — ${recentDays(count)}`;
const onOff = (value: boolean) => (value ? 'zapnuté' : 'vypnuté');
const messages = (count: number) =>
  plural(locale, count, { one: '{count} správu', few: '{count} správy', other: '{count} správ' });
const days = (count: number) =>
  plural(locale, count, { one: '{count} dni', few: '{count} dňoch', other: '{count} dňoch' });

export const sk = {
  locale,
  languageName: 'Slovenčina',

  common: {
    enabled: 'zapnuté',
    disabled: 'vypnuté',
    available: 'dostupné',
    unavailable: 'nedostupné',
    none: 'žiadne',
    never: 'nikdy',
    yes: 'áno',
    no: 'nie',
    saveFailed: 'Toto nastavenie sa mi nepodarilo uložiť. Skús to prosím znova.',
    temporarilyUnavailable: 'Jolanda je momentálne nedostupná. Skús to prosím znova.',
  },

  commands: {
    needsManageServer: 'Na zmenu Jolandy potrebuješ oprávnenie Spravovať server.',
    unknownGroup: 'Neznáma skupina príkazov Jolandy.',
    unknownCommand: 'Neznámy príkaz Jolandy.',
    contextSyntax: 'Použi `+context` alebo `+context=N` na začiatku svojej otázky.',

    privacy: (facts: PrivacyFacts) =>
      [
        '**Ochrana údajov v Jolande**',
        'Novinky kopírujú verejné články bez AI do kanálov určených správcom. Smerovanie je šifrované a vypnutím sa odstráni. Odoslané kópie zostávajú do moderovania v Discorde.',
        'Automatické preposielanie anonymne posiela verejné ID príspevkov Instagramu/Meta alebo TikToku. Médiá sa dočasne stiahnu a skopírujú do Discordu bez AI analýzy. Kópie sa riadia uchovávaním Discordu; zmazanie zdroja ich neodstráni. Správcovia ich môžu moderovať.',
        'Tvoju otázku, výslovné odpovede a jednotlivé kroky konverzácie spracúva OpenRouter a vybraný poskytovateľ modelu.',
        'Cez /jolanda ask si vyber model pre jednu odpoveď zo zoznamu. Predvolený model servera sa nezmení. Uchovávanie údajov závisí od vybraného modelu; profily označené [no ZDR] môžu prompty uchovávať.',
        facts.supportsZdr
          ? `Nulové uchovávanie údajov je pre model ${facts.modelLabel} **vynútené**.`
          : `Nulové uchovávanie údajov nie je pre model ${facts.modelLabel} dostupné; jeho poskytovateľ môže prompty uchovávať podľa vlastných pravidiel.`,
        'Okolitý kontext kanála je predvolene **vypnutý pri každej interakcii**.',
        facts.contextLimit
          ? `Začni otázku slovom **+context** alebo **+context=N** a vyžiadaj si až **${messages(facts.contextLimit)}** predchádzajúcich ľudských správ z toho istého kanála.`
          : 'Okolitý kontext na interakciu je aktuálne **vypnutý pravidlami servera**.',
        `Text konverzácie vrátane výslovne vyžiadaného kontextu sa ukladá v čitateľnej podobe, aby mohli odpovede pokračovať; identifikátory Discordu sú pseudonymizované. Oboje expiruje po **${days(facts.transcriptTtlDays)}**, hoci mazanie v Atlas TTL môže prebehnúť krátko po expirácii.`,
        'Každý krok modelu má priame webové nástroje len na čítanie. Tvoja otázka, odpovede, história konverzácie a vyžiadaný kontext môžu ovplyvniť verejný vyhľadávací dotaz, keď model usúdi, že prieskum je užitočný.',
        'Open-Meteo dostáva názvy nastavených miest na geokódovanie a súradnice na predpoveď, bez identifikátorov Discordu. Prehľad nevolá model.',
        'Text pripomienok sa ukladá čitateľne do 7 dní po termíne. Smerovanie je šifrované a po doručení alebo zrušení sa odstráni. Text vidí pôvodný kanál; agenda prehľadu číta iba pripomienky z rovnakého kanála.',
        'Konverzácie v odpovediach sú vázané na svojho autora. Neposielaj heslá, tokeny, platobné údaje ani iné tajomstvá.',
      ].join('\n'),

    settings: (facts: SettingsFacts) =>
      [
        `Preposielanie médií v nasadení (Instagram a TikTok): **${facts.reelsDeploymentAvailable ? 'dostupné' : 'vypnuté'}**`,
        `Preposielanie v tomto kanáli (Instagram a TikTok): **${onOff(facts.reelsChannelEnabled)}**`,
        `Model: **${facts.modelLabel}**`,
        `Uvažovanie: **${facts.reasoning}**`,
        `Nulové uchovávanie údajov: **${facts.supportsZdr ? 'vynútené' : 'nedostupné'}**`,
        `Jazyk: **${facts.languageName}**`,
        'Predvolený okolitý kontext: **0 správ**',
        `Limit kontextu na interakciu: **${messages(facts.contextLimit)}**`,
        `Denne zaviazané výdavky: **${facts.dailyCommitted}**`,
        `Mesačne zaviazané výdavky: **${facts.monthlyCommitted}**`,
      ].join('\n'),

    modelSet: (input: { label: string; reasoning: string; supportsZdr: boolean }) =>
      input.supportsZdr
        ? `Model nastavený na **${input.label}** s uvažovaním **${input.reasoning}**. Nulové uchovávanie údajov bude vynútené.`
        : `Model nastavený na **${input.label}** s uvažovaním **${input.reasoning}**. ⚠️ Pre tento model nie je dostupné nulové uchovávanie údajov.`,

    contextLimitSet: (count: number) =>
      count === 0
        ? 'Okolitý kontext na interakciu je vypnutý. Správy, na ktoré výslovne odpovieš, sa stále zahrnú.'
        : `Členovia si teraz môžu cez +context vyžiadať až **${messages(count)}** predchádzajúcich ľudských správ.`,

    languageSet: (languageName: string) =>
      `Jolanda bude odpovedať po **${languageName === 'Slovenčina' ? 'slovensky' : 'anglicky'}**. Odpovede modelu sa stále riadia jazykom, v ktorom sa píše.`,
  },

  reels: {
    channelUnsupported:
      'Nastavenia preposielania sú dostupné len v serverových textových a oznamovacích kanáloch.',
    missingPermissions:
      'Na preposielanie potrebujem oprávnenia Zobraziť kanál, Posielať správy, Čítať históriu správ a Pripájať súbory.',
    toggled: (input: { enabled: boolean; deploymentOff: boolean }) =>
      `Automatické preposielanie (Instagram a TikTok) je v tomto kanáli **${onOff(input.enabled)}**.${
        input.enabled && input.deploymentOff
          ? ' Stahovanie zostáva nedostupné, kým je prepínač nasadenia vypnutý.'
          : ''
      }`,
    platformLabel: {
      tiktok: 'TikTok',
      instagramPost: 'Instagramový príspevok',
      instagramReel: 'Instagram Reel',
    },
    sizeUnknown: 'veľkosť neznáma',
    atLeast: (value: string) => `aspoň ${value}`,
    bytes: (value: string) => `${value} bajtov`,
    failure: (input: { failure: ReelFailure; platform: string; maximumPhotos: number }) =>
      ({
        unavailable: `${input.platform} sa mi nepodarilo otvoriť bez prihlásenia.`,
        authentication_required: `${input.platform} sa mi nepodarilo otvoriť bez prihlásenia.`,
        too_large: `${input.platform} je príliš veľký.`,
        unsupported_media: `Pre ${input.platform} sa mi nepodarilo získať kompatibilné video.`,
        timeout: `${input.platform} sa mi teraz nepodarilo stiahnuť.`,
        extractor_failed: `${input.platform} sa mi teraz nepodarilo stiahnuť.`,
        rate_limited: `${input.platform} sa mi teraz nepodarilo stiahnuť.`,
        photos_unavailable: `Pre ${input.platform} sa mi nepodarilo získať originálne fotky.`,
        too_many_photos: `${input.platform} má viac ako ${input.maximumPhotos} fotiek, čo je môj limit na príspevok.`,
        cancelled: '',
      })[input.failure],
    tooLarge: (input: {
      platform: string;
      measurement: string;
      limitLabel: 'download' | 'app' | 'plain';
      limit: string;
      discordRejected: boolean;
    }) =>
      `${input.platform} je príliš veľký${input.discordRejected ? ' pre Discord' : ''}: ${input.measurement} (${
        { download: 'limit stahovania', app: 'limit aplikácie', plain: 'limit' }[input.limitLabel]
      }: ${input.limit}).`,
    photosRange: (input: { from: number; to: number; total: number }) =>
      `Fotky ${input.from}–${input.to} z ${input.total}`,
  },

  news: {
    moreStories: 'Ďalšie správy nájdete v zdrojovom článku.',
    story: 'Správa',

    unavailableDeployment: 'Novinky: **v tomto nasadení nedostupné**',
    unavailable: 'Novinky sú v tomto nasadení nedostupné.',
    unknownCommand: 'Neznámy príkaz noviniek.',
    feedLabel,
    feedName,
    outcome: outcomeLabel,
    notCollectedYet,

    summary: (input: { available: boolean; feeds: { feed: NewsFeed; state: string }[] }) =>
      `Nasadenie noviniek: **${input.available ? 'dostupné' : 'vypnuté'}** · ${input.feeds
        .map(({ feed, state }) => `${feedName[feed]}: ${state}`)
        .join(
          ' · ',
        )}. Podrobnosti zobrazíš cez /jolanda continuous status alebo /jolanda daily status.`,
    summaryState: { enabled: 'zapnuté', paused: 'pozastavené', off: 'vypnuté' },

    statusLines: (facts: NewsStatusFacts) => {
      const pausedLabel = {
        'destination-unavailable': 'cieľ nedostupný',
        'decryption-failed': 'dešifrovanie zlyhalo',
        'deployment-disabled': 'nasadenie vypnuté',
        'feed-disabled': 'kanál vypnutý',
      };
      return [
        `**Novinky — ${feedLabel[facts.feed]}**`,
        `Prepínač nasadenia: **${onOff(facts.deploymentEnabled)}**`,
        `Konfigurácia: **${
          facts.configuration === 'missing'
            ? 'nenastavené'
            : facts.configuration === 'enabled'
              ? 'zapnuté'
              : 'vypnuté'
        }**`,
        `Cieľ: ${
          facts.destination.kind === 'channel'
            ? `<#${facts.destination.channelId}>`
            : facts.destination.kind === 'unavailable'
              ? 'nedostupný; nastav kanál znova'
              : 'žiadny'
        }`,
        `Upozornenia: ${
          facts.feed === 'continuous'
            ? 'tiché; bez zmienok'
            : facts.notifyRoleId
              ? `bežné chovanie kanála; výslovná rola <@&${facts.notifyRoleId}>`
              : 'bežné chovanie kanála; bez zmienky roly'
        }`,
        `Doručovanie pozastavené: **${facts.paused ? pausedLabel[facts.paused] : 'nie'}**`,
        `Najbližšie zbieranie: ${facts.nextCollectionAt ?? 'pre toto odoberanie nie je naplánované'}`,
        `Posledný výsledok zdroja: **${facts.lastOutcome ? outcomeLabel[facts.lastOutcome] : notCollectedYet}**`,
        `Posledné úspešné zbieranie: ${facts.lastSuccessAt ?? 'nikdy'}`,
        ...(facts.backoffUntil ? [`Zdroj v odklade do: ${facts.backoffUntil}`] : []),
        ...(facts.storedEdition
          ? [
              `Uložené vydanie: ${facts.storedEdition.current ? 'aktuálny deň' : 'starší deň'} · ${facts.storedEdition.collectedAt} (zozbierané, nie potvrdenie o doručení)`,
            ]
          : facts.feed === 'daily'
            ? ['Uložené vydanie: žiadne; nie je uložené žiadne aktuálne vydanie']
            : []),
        `Čakajúce doručenia: **${facts.pending}** · Neisté doručenia: **${facts.uncertain}**`,
        ...(facts.uncertain
          ? ['Neisté doručenia sú zadržané, aby nevznikli duplicitné správy.']
          : []),
      ];
    },

    feedDisabled: (feed: NewsFeed) =>
      `Kanál ${feedLabel[feed]} je vypnutý. Uložené smerovanie bolo odstránené; už odoslané správy zostávajú v Discorde.`,
    feedConfigured: (input: {
      feed: NewsFeed;
      channelId: string;
      notifyRoleId?: string;
      deploymentEnabled: boolean;
    }) =>
      `Kanál ${feedLabel[input.feed]} je zapnutý v <#${input.channelId}>.${
        input.feed === 'continuous'
          ? ' Príspevky sú tiché a nikoho nezmieňujú.'
          : input.notifyRoleId
            ? ` Denné vydania môžu raz upozorniť <@&${input.notifyRoleId}>; nastavenia upozornení členov stále platia.`
            : ' Denné vydania používajú bežné upozornenia kanála bez zmienky roly.'
      }${input.deploymentEnabled ? '' : ' Zbieranie a doručovanie zostávajú vypnuté, kým je prepínač nasadenia vypnutý.'}`,
    invalidDestination:
      'Vyber textový alebo oznamovací kanál na tomto serveri a prípadne rolu inú ako @everyone.',
    validationFailed:
      'Tento cieľ sa mi nepodarilo overiť. Potrebujem tam oprávnenia Zobraziť kanál, Posielať správy a Vkladať odkazy. Prípadná rola na upozornenie musí existovať a byť zmieniteľná, inak potrebujem v tom kanáli Zmieniť všetkých.',
  },

  weather: {
    clear: 'Jasno',
    partlyCloudy: 'Polojasno',
    overcast: 'Zamračené',
    fog: 'Hmla',
    drizzle: 'Mrholenie',
    freezingRain: 'Mrznúci dážď',
    rain: 'Dážď',
    snow: 'Sneženie',
    thunderstorm: 'Búrka',
    unknown: 'Neznáme počasie',
  },
  manualRun: {
    queued:
      'Ručné spustenie je zaradené. Správa príde do nastaveného kanála; bežný rozvrh sa nemení.',
    unconfigured: 'Najprv nastav a zapni cieľový kanál cez príkaz feed.',
    busy: 'Spustenie už prebieha alebo platí ochranná prestávka. Skús to o pár minút (najskôr po 10 minútach od posledného ručného spustenia).',
    unavailable:
      'Zdroj je dočasne nedostupný alebo nemá denné vydanie z posledných 48 hodín. Skús to neskôr.',
  },
  briefing: {
    noNameday: 'Dnes nie sú v oficiálnom kalendári meniny.',
    agendaUnavailable: 'Pripomienky sú momentálne nedostupné.',
    moreAgenda: (count: number) => `Ďalšie pripomienky dnes: ${count}`,

    unavailable: 'Ranný prehľad je v tomto nasadení nedostupný.',
    unknownCommand: 'Neznámy príkaz ranného prehľadu.',
    summary: (input: { available: boolean; configured: boolean; hour: number }) =>
      `Ranný prehľad: **${!input.available ? 'v tomto nasadení nedostupný' : input.configured ? `zapnutý na ${String(input.hour).padStart(2, '0')}:00` : 'nenastavený'}**`,
    channelUnsupported:
      'Ranný prehľad je dostupný len v serverových textových a oznamovacích kanáloch.',
    configured: (input: { channelId: string; hour: number }) =>
      `Ranný prehľad je zapnutý v <#${input.channelId}> na **${String(input.hour).padStart(2, '0')}:00**.`,
    disabledFeed:
      'Ranný prehľad je vypnutý. Uložené smerovanie bolo odstránené; už odoslané prehľady zostávajú v Discorde.',
    hourSet: (hour: number) =>
      `Ranný prehľad bude chodiť o **${String(hour).padStart(2, '0')}:00** (Europe/Bratislava).`,
    cityAdded: (input: { name: string; count: number; maximum: number }) =>
      `Mesto **${input.name}** pridané. Nastavené máš ${input.count} z ${input.maximum}.`,
    cityRemoved: (name: string) => `Mesto **${name}** odstránené.`,
    cityUnknown: (name: string) =>
      `Mesto **${name}** som nenašla. Skús iný pravopis alebo väčšie mesto v okolí.`,
    cityDuplicate: (name: string) => `Mesto **${name}** už máš v prehľade.`,
    cityLimit: (maximum: number) =>
      `V rannom prehľade môžeš mať najviac ${plural(locale, maximum, { one: '{count} mesto', few: '{count} mestá', other: '{count} miest' })}. Najprv niektoré odstráň.`,
    noCities:
      'Zatiaľ nemáš nastavené žiadne mesto. Pridaj ho cez /jolanda briefing city action:add.',

    statusLines: (facts: BriefingStatusFacts) => [
      '**Ranný prehľad**',
      `Konfigurácia: **${facts.configured ? 'zapnutá' : 'nenastavená'}**`,
      `Cieľ: ${
        facts.destination.kind === 'channel'
          ? `<#${facts.destination.channelId}>`
          : facts.destination.kind === 'unavailable'
            ? 'nedostupný; nastav prehľad znova'
            : 'žiadny'
      }`,
      `Čas doručenia: **${String(facts.hour).padStart(2, '0')}:00** (Europe/Bratislava)`,
      `Mestá (${facts.cities.length}/${facts.maximumCities}): ${facts.cities.length ? facts.cities.join(' · ') : 'žiadne'}`,
      `Najbližšie doručenie: ${facts.nextDeliveryAt ?? 'nie je naplánované'}`,
      `Posledné doručenie: ${facts.lastDeliveredAt ?? 'nikdy'}`,
    ],

    greeting: (date: string) => `Dobré ráno — ${date}`,
    weatherUnavailable: (city: string) => `${city} — počasie momentálne nedostupné`,
    daylight: (input: { duration: string; delta: string; shorter: boolean }) =>
      `${input.duration} svetla, o ${input.delta} ${input.shorter ? 'kratšie' : 'dlhšie'} ako včera`,
    namedays: (names: string[]) =>
      `Meniny: ${names[0]}${names.length > 1 ? ` (${names.slice(1).join(', ')})` : ''}`,
    holiday: (input: { name: string; dayOff: boolean; stateHoliday: boolean }) =>
      `${input.name} — ${input.stateHoliday ? 'štátny sviatok' : 'sviatok'}${input.dayOff ? ' a deň pracovného pokoja' : ' (nie je dňom pracovného pokoja)'}`,
    agenda: (rows: ReminderRow[]) =>
      `Dnes: ${rows.map((row) => `${row.dueAt} ${row.text}`).join(' · ')}`,
    feels: (value: string) => `pocitovo ${value}`,
    rain: (input: { millimetres: number; probability: number }) =>
      input.millimetres > 0
        ? `${input.millimetres} mm (${input.probability} %)`
        : `bez dažďa (${input.probability} %)`,
    wind: (input: { speed: number; gusts: number }) =>
      `vietor ${Math.round(input.speed)} km/h, v nárazoch ${Math.round(input.gusts)}`,
    uv: (value: number) => `UV ${value.toFixed(1)}`,
  },

  reminders: {
    deliveryUncertain: '⚠️ Doručenie neisté:',

    textTooLong: 'Text pripomienky môže mať najviac 280 znakov.',
    created: (input: { dueAt: string; id: string }) =>
      `✅ Pripomienka nastavená na ${input.dueAt}. ID: \`${input.id}\``,
    cancelled: (id: string) => `✅ Pripomienka \`${id}\` zrušená.`,
    notFound: (id: string) => `Pripomienku \`${id}\` som nenašla.`,
    listEmpty: 'Nemáš žiadne čakajúce pripomienky.',
    list: (rows: ReminderRow[]) =>
      [
        `**Tvoje pripomienky (${rows.length})**`,
        ...rows.map((row) => `\`${row.id}\` · ${row.dueAt} — ${row.text}`),
      ].join('\n'),
    limitReached: (maximum: number) =>
      `Naraz môžeš mať najviac ${plural(locale, maximum, { one: '{count} čakajúcu pripomienku', few: '{count} čakajúce pripomienky', other: '{count} čakajúcich pripomienok' })}. Niektorú najprv zruš alebo počkaj, kým sa odošle.`,
    invalidTime:
      'Tento čas som nepochopila. Použi napríklad `in:2h`, `in:90m`, `in:3d` alebo `at:2026-09-16 09:00`.',
    tooSoon: 'Pripomienka musí byť aspoň minútu v budúcnosti.',
    tooFar: 'Pripomienku viem nastaviť najviac rok dopredu.',
    emptyText: 'Napíš, na čo ti mám pripomenúť.',
    saveFailed:
      '⚠️ Pripomienku sa mi nepodarilo uložiť, takže nie je nastavená. Skús to prosím znova.',
    deliver: (input: { userId: string; text: string; createdAt: string }) =>
      `🔔 <@${input.userId}> — ${input.text}\nNastavené ${input.createdAt}`,
  },

  usage: {
    heading: usageHeading,
    noData: 'Za toto obdobie nemám žiadne zaznamenané volania.',
    others: 'ostatní',
    lines: (facts: UsageFacts) =>
      [
        usageHeading(facts.windowDays),
        '',
        `Výdavky  ${facts.sparkline}  ${facts.totalCost} celkom`,
        `Dnes ${facts.dailyCost} · Tento mesiac ${facts.monthlyCost} z ${facts.monthlyLimit}`,
        '',
        `**Podľa členov (${recentDays(facts.memberWindowDays)})**`,
        ...(facts.members.length
          ? facts.members.map((member) =>
              `${member.name} — ${plural(locale, member.requests, {
                one: '{count} otázka',
                few: '{count} otázky',
                other: '{count} otázok',
              })} · ${member.cost} ${member.failures ? `· ${member.failures} zlyhalo` : ''}`.trim(),
            )
          : ['Žiadne dáta v tomto okne.']),
        '',
        `Dáta podľa členov pokrývajú ${dayCount(facts.memberWindowDays)} (uchovávanie prepisov), trend pokrýva ${dayCount(facts.windowDays)}. Denné súčty sa uchovávajú 120 dní.`,
        ...(facts.othersIncluded
          ? ['Členov, ktorých sa nepodarilo priradiť, zhŕňa položka „ostatní“.']
          : []),
      ].join('\n'),
  },

  rejections: (promptsPerMinute: number, imageCount: number, replyLimit: number) =>
    ({
      empty_question: 'Pri označení alebo odpovedi mi prosím napíš aj otázku.',
      invalid_model:
        'Tento profil modelu nie je dostupný. Vyber si model znova zo zoznamu v /jolanda ask.',
      image_limit: `Pošli prosím najviac ${imageCount} obrázkov naprieč svojou správou a správou, na ktorú odpovedáš.`,
      image_too_large: 'Použi prosím obrázky do 8 MiB, prípadne nahraj menšiu verziu.',
      image_unavailable:
        'Priložený obrázok sa mi nepodarilo prečítať. Nahraj ho prosím znova ako JPEG, PNG, WebP alebo GIF (do 40 megapixelov).',
      expired_conversation:
        'Tejto konverzácii vypršala platnosť. Označ ma v novej správe a začneme odznova.',
      conversation_busy: 'V tejto konverzácii už odpovedám. Počkaj prosím, kým dokončím.',
      conversation_limit: `Táto konverzácia dosiahla limit ${replyLimit} odpovedí Jolandy. Označ ma a začneme novú.`,
      conversation_owner:
        'Konverzáciu môže pokračovať len ten, kto ju začal. Označ ma v novej správe a začni si vlastnú.',
      context_limit:
        'Táto požiadavka na kontext prekračuje limit servera na jednu interakciu. Použi menšiu hodnotu +context alebo požiadaj administrátora o zmenu /jolanda context-limit.',
      server_busy:
        'Jolanda je na svojom limite súbežných otázok. Skús to prosím znova, keď dobehne niektorá odpoveď.',
      shutting_down: 'Jolanda sa restartuje. Skús to prosím za chvíľu.',
      duplicate: '',
      rate_limited: `Za jednu minútu môžeš poslať najviac ${promptsPerMinute} otázok. Počkaj prosím chvíľu.`,
      monthly_budget: 'Jolanda dosiahla mesačný limit výdavkov servera.',
    }) satisfies Record<
      Exclude<TurnOutcome, { status: 'completed' } | { status: 'failed' }>['reason'],
      string
    >,

  progress: {
    thinking: 'Jolanda premýšľa…',
    answering: '🧠 Prechádzam otázku…',
    finalizing: '📦 Dokončujem odpoveď…',
    waitingAnswering: '🧠 Čakám na OpenRouter…',
    waitingFinalizing: '📦 Dokončujem odpoveď…',
    currentApproach: '🧠 **Aktuálny postup**',
    noActivityFor: (elapsed: string) => ` · bez aktivity ${elapsed}`,
    waitingForOpenRouter: ' · čakám na OpenRouter',
    retry: (input: {
      reason: string;
      waitSeconds: number;
      attempt: number;
      maximum: number;
      elapsed: string;
    }) =>
      `⚠️ OpenRouter sa opäť ide posrať.\nDôvod: ${input.reason}\n${input.waitSeconds ? `Skúšam znova za ${input.waitSeconds} s` : 'Skúšam znova'} · pokus ${input.attempt}/${input.maximum} · ${input.elapsed}`,
  },

  answer: {
    question: 'Otázka',
    model: 'Model',
    noModel: 'Lokálna odpoveď, bez AI modelu',
    truncationNotice: '⚠️ *Model narazil na limit výstupu, takže je táto odpoveď skrátená.*',
    footerTruncation: '\n\n[…odpoveď skrátená, aby sa zmestili údaje o odpovedi]',
    imageModel: (label: string) => `\n\n👁️ **Model pre obrázky:** ${label}`,
    basisModelOnly: '🧠 **Zdrojový základ:** Verejný webový prieskum sa nepoužil.',
    basisWebWithoutSources:
      '🌐 **Zdrojový základ:** Verejný webový prieskum sa použil, ale OpenRouter nevrátil použiteľné odkazy na zdroje.',
    basisUnreported:
      '⚠️ **Zdrojový základ:** OpenRouter neuviedol, či sa použil verejný webový prieskum.',
    basisWebSources: '🌐 **Zdrojový základ:** Použil sa verejný webový prieskum.',
    omittedSources: (count: number) =>
      `- ${plural(locale, count, {
        one: '{count} ďalší odkaz na zdroj vynechaný',
        few: '{count} ďalšie odkazy na zdroje vynechané',
        other: '{count} ďalších odkazov na zdroje vynechaných',
      })}`,
    sourceLabel: (sourceNumber: number, title?: string) =>
      title ? `Zdroj ${sourceNumber}: ${title}` : `Zdroj ${sourceNumber}`,
    cost: (value: string) => `💵 **Cena odpovede:** ${value}`,
    costUnknown: '💵 **Cena odpovede:** Neznáma (nepočíta sa do rozpočtu servera)',
  },

  failures: {
    generic: '⚠️ Túto odpoveď sa mi nepodarilo dokončiť. Skús to prosím znova.',
    notice: (input: {
      category: ModelFailureCategory;
      malformedReason?: ModelMalformedReason;
      reference: string;
    }) => {
      if (input.malformedReason === 'empty_answer')
        return `⚠️ Model nevrátil žiadny text odpovede. Skús iný model cez \`/model\`, alebo sa spýtaj znova. Referencia: \`${input.reference}\`.`;
      if (input.malformedReason === 'reasoning_budget_exhausted')
        return `⚠️ Model spotreboval celý svoj tokenový rozpočet na uvažovanie a odpoveď nevytvoril. Skús nižšie uvažovanie cez \`/model\`, alebo sa spýtaj znova. Referencia: \`${input.reference}\`.`;
      const reason = {
        timeout: 'Generovanie odpovede vypršalo.',
        rate_limited: 'OpenRouter obmedzil generovanie odpovede kvôli limitu požiadaviek.',
        authentication: 'OpenRouter odmietol prihlasovacie údaje bota.',
        payment_required: 'OpenRouter odmietol požiadavku z fakturačných dôvodov.',
        request_rejected: 'OpenRouter odmietol požiadavku na generovanie odpovede.',
        provider_unavailable: 'Pre generovanie odpovede nebol dostupný žiadny poskytovateľ.',
        provider_failure: 'Poskytovateľ modelu zlyhal pri generovaní odpovede.',
        malformed_response: 'OpenRouter vrátil pri generovaní odpovede neplatnú odpoveď.',
        network_failure: 'Spojenie s OpenRouterom pri generovaní odpovede zlyhalo.',
        cancelled: 'Požiadavka bola zrušená.',
        unknown: 'Túto odpoveď sa mi nepodarilo dokončiť.',
      }[input.category];
      return `⚠️ ${reason} Skús to prosím znova. Referencia: \`${input.reference}\`.`;
    },
    retryReason: (input: {
      status?: number;
      category: ModelFailureCategory;
      malformedReason?: ModelMalformedReason;
    }) => {
      if (input.status === 502) return '502 Bad Gateway — zlyhal nadradený poskytovateľ';
      if (input.malformedReason === 'empty_answer')
        return 'Poskytovateľ skončil bez toho, aby vrátil text odpovede';
      if (input.malformedReason === 'reasoning_budget_exhausted')
        return 'Model vyčerpal svoj rozpočet na uvažovanie bez odpovede';
      const reason = {
        timeout: 'OpenRouteru vypršal čas',
        rate_limited: 'Limit požiadaviek OpenRouteru',
        provider_failure: 'Nadradený poskytovateľ zlyhal',
        provider_unavailable: 'Nebol dostupný žiadny vhodný poskytovateľ',
        malformed_response: 'Poskytovateľ vrátil neplatnú alebo prázdnu odpoveď',
        network_failure: 'Spojenie s OpenRouterom zlyhalo',
        authentication: 'OpenRouter odmietol prihlasovacie údaje bota',
        payment_required: 'OpenRouter odmietol požiadavku z fakturačných dôvodov',
        request_rejected: 'OpenRouter odmietol požiadavku',
        cancelled: 'Požiadavka bola zrušená',
        unknown: 'Neznáme zlyhanie OpenRouteru',
      }[input.category];
      return input.status === undefined ? reason : `${input.status}: ${reason}`;
    },
  },
};

// `locale` is widened deliberately: reading a const narrows it to its own literal, which
// would make every other catalog fail to satisfy this type.
export type Messages = Omit<typeof sk, 'locale'> & { locale: Locale };

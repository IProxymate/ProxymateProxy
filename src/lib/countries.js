/**
 * Соответствие ISO-код страны -> список языковых тегов (от основного к запасным).
 * Используется, чтобы по стране прокси собрать navigator.languages и Accept-Language.
 */
export const COUNTRY_LANGUAGES = {
  AE: ['ar-AE', 'ar', 'en'], AL: ['sq-AL', 'sq', 'en'], AM: ['hy-AM', 'hy', 'ru'],
  AR: ['es-AR', 'es', 'en'], AT: ['de-AT', 'de', 'en'], AU: ['en-AU', 'en'],
  AZ: ['az-AZ', 'az', 'ru'], BA: ['bs-BA', 'bs', 'en'], BD: ['bn-BD', 'bn', 'en'],
  BE: ['nl-BE', 'nl', 'fr', 'en'], BG: ['bg-BG', 'bg', 'en'], BH: ['ar-BH', 'ar', 'en'],
  BO: ['es-BO', 'es', 'en'], BR: ['pt-BR', 'pt', 'en'], BY: ['ru-BY', 'ru', 'be'],
  CA: ['en-CA', 'en', 'fr-CA', 'fr'], CH: ['de-CH', 'de', 'fr', 'en'], CL: ['es-CL', 'es', 'en'],
  CN: ['zh-CN', 'zh', 'en'], CO: ['es-CO', 'es', 'en'], CR: ['es-CR', 'es', 'en'],
  CY: ['el-CY', 'el', 'en'], CZ: ['cs-CZ', 'cs', 'en'], DE: ['de-DE', 'de', 'en'],
  DK: ['da-DK', 'da', 'en'], DO: ['es-DO', 'es', 'en'], DZ: ['ar-DZ', 'ar', 'fr'],
  EC: ['es-EC', 'es', 'en'], EE: ['et-EE', 'et', 'ru', 'en'], EG: ['ar-EG', 'ar', 'en'],
  ES: ['es-ES', 'es', 'en'], FI: ['fi-FI', 'fi', 'sv', 'en'], FR: ['fr-FR', 'fr', 'en'],
  GB: ['en-GB', 'en'], GE: ['ka-GE', 'ka', 'ru', 'en'], GR: ['el-GR', 'el', 'en'],
  GT: ['es-GT', 'es', 'en'], HK: ['zh-HK', 'zh', 'en'], HN: ['es-HN', 'es', 'en'],
  HR: ['hr-HR', 'hr', 'en'], HU: ['hu-HU', 'hu', 'en'], ID: ['id-ID', 'id', 'en'],
  IE: ['en-IE', 'en'], IL: ['he-IL', 'he', 'en'], IN: ['en-IN', 'en', 'hi-IN', 'hi'],
  IQ: ['ar-IQ', 'ar', 'en'], IR: ['fa-IR', 'fa', 'en'], IS: ['is-IS', 'is', 'en'],
  IT: ['it-IT', 'it', 'en'], JO: ['ar-JO', 'ar', 'en'], JP: ['ja-JP', 'ja', 'en'],
  KE: ['en-KE', 'en', 'sw'], KG: ['ru-KG', 'ru', 'ky'], KH: ['km-KH', 'km', 'en'],
  KR: ['ko-KR', 'ko', 'en'], KW: ['ar-KW', 'ar', 'en'], KZ: ['ru-KZ', 'ru', 'kk'],
  LB: ['ar-LB', 'ar', 'fr', 'en'], LK: ['si-LK', 'si', 'en'], LT: ['lt-LT', 'lt', 'ru', 'en'],
  LU: ['fr-LU', 'fr', 'de', 'en'], LV: ['lv-LV', 'lv', 'ru', 'en'], MA: ['ar-MA', 'ar', 'fr'],
  MD: ['ro-MD', 'ro', 'ru'], ME: ['sr-ME', 'sr', 'en'], MK: ['mk-MK', 'mk', 'en'],
  MN: ['mn-MN', 'mn', 'en'], MT: ['mt-MT', 'mt', 'en'], MX: ['es-MX', 'es', 'en'],
  MY: ['ms-MY', 'ms', 'en'], NG: ['en-NG', 'en'], NL: ['nl-NL', 'nl', 'en'],
  NO: ['nb-NO', 'nb', 'no', 'en'], NP: ['ne-NP', 'ne', 'en'], NZ: ['en-NZ', 'en'],
  OM: ['ar-OM', 'ar', 'en'], PA: ['es-PA', 'es', 'en'], PE: ['es-PE', 'es', 'en'],
  PH: ['en-PH', 'en', 'fil'], PK: ['ur-PK', 'ur', 'en'], PL: ['pl-PL', 'pl', 'en'],
  PR: ['es-PR', 'es', 'en'], PT: ['pt-PT', 'pt', 'en'], PY: ['es-PY', 'es', 'en'],
  QA: ['ar-QA', 'ar', 'en'], RO: ['ro-RO', 'ro', 'en'], RS: ['sr-RS', 'sr', 'en'],
  RU: ['ru-RU', 'ru', 'en'], SA: ['ar-SA', 'ar', 'en'], SE: ['sv-SE', 'sv', 'en'],
  SG: ['en-SG', 'en', 'zh-SG'], SI: ['sl-SI', 'sl', 'en'], SK: ['sk-SK', 'sk', 'en'],
  TH: ['th-TH', 'th', 'en'], TN: ['ar-TN', 'ar', 'fr'], TR: ['tr-TR', 'tr', 'en'],
  TW: ['zh-TW', 'zh', 'en'], UA: ['uk-UA', 'uk', 'ru', 'en'], US: ['en-US', 'en'],
  UY: ['es-UY', 'es', 'en'], UZ: ['uz-UZ', 'uz', 'ru'], VE: ['es-VE', 'es', 'en'],
  VN: ['vi-VN', 'vi', 'en'], ZA: ['en-ZA', 'en', 'af']
};

/** Запасной часовой пояс, если гео-сервис его не отдал. */
export const COUNTRY_TIMEZONE = {
  AE: 'Asia/Dubai', AR: 'America/Argentina/Buenos_Aires', AT: 'Europe/Vienna',
  AU: 'Australia/Sydney', BE: 'Europe/Brussels', BG: 'Europe/Sofia', BR: 'America/Sao_Paulo',
  BY: 'Europe/Minsk', CA: 'America/Toronto', CH: 'Europe/Zurich', CL: 'America/Santiago',
  CN: 'Asia/Shanghai', CO: 'America/Bogota', CZ: 'Europe/Prague', DE: 'Europe/Berlin',
  DK: 'Europe/Copenhagen', EE: 'Europe/Tallinn', EG: 'Africa/Cairo', ES: 'Europe/Madrid',
  FI: 'Europe/Helsinki', FR: 'Europe/Paris', GB: 'Europe/London', GE: 'Asia/Tbilisi',
  GR: 'Europe/Athens', HK: 'Asia/Hong_Kong', HR: 'Europe/Zagreb', HU: 'Europe/Budapest',
  ID: 'Asia/Jakarta', IE: 'Europe/Dublin', IL: 'Asia/Jerusalem', IN: 'Asia/Kolkata',
  IT: 'Europe/Rome', JP: 'Asia/Tokyo', KZ: 'Asia/Almaty', KR: 'Asia/Seoul',
  LT: 'Europe/Vilnius', LV: 'Europe/Riga', MD: 'Europe/Chisinau', MX: 'America/Mexico_City',
  MY: 'Asia/Kuala_Lumpur', NL: 'Europe/Amsterdam', NO: 'Europe/Oslo', NZ: 'Pacific/Auckland',
  PE: 'America/Lima', PH: 'Asia/Manila', PK: 'Asia/Karachi', PL: 'Europe/Warsaw',
  PT: 'Europe/Lisbon', RO: 'Europe/Bucharest', RS: 'Europe/Belgrade', RU: 'Europe/Moscow',
  SA: 'Asia/Riyadh', SE: 'Europe/Stockholm', SG: 'Asia/Singapore', SI: 'Europe/Ljubljana',
  SK: 'Europe/Bratislava', TH: 'Asia/Bangkok', TR: 'Europe/Istanbul', TW: 'Asia/Taipei',
  UA: 'Europe/Kyiv', US: 'America/New_York', VN: 'Asia/Ho_Chi_Minh', ZA: 'Africa/Johannesburg'
};

/**
 * Метка страны для интерфейса.
 * Намеренно НЕ эмодзи-флаг: Windows не поставляет шрифт с флагами, и пара
 * региональных индикаторов рендерится там просто как «NL».
 */
export function countryLabel(cc) {
  return cc && /^[a-z]{2}$/i.test(cc) ? cc.toUpperCase() : '··';
}

export function languagesForCountry(code) {
  if (!code) return null;
  return COUNTRY_LANGUAGES[String(code).toUpperCase()] || null;
}

export function timezoneForCountry(code) {
  if (!code) return null;
  return COUNTRY_TIMEZONE[String(code).toUpperCase()] || null;
}

/** "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7" */
export function buildAcceptLanguage(langs) {
  if (!langs || !langs.length) return null;
  const out = [langs[0]];
  for (let i = 1; i < langs.length; i++) {
    const q = Math.max(0.1, 1 - i * 0.1).toFixed(1).replace(/0$/, '');
    out.push(langs[i] + ';q=' + q);
  }
  return out.join(',');
}

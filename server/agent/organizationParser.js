const BIZINSPECT_SEARCH = 'https://bizinspect.by/search';
const KARTOTEKA_SEARCH = 'https://kartoteka.by/search';

const FETCH_TIMEOUT_MS = 10000;

async function fetchText(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await (fetchImpl ?? fetch)(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return null;
    return await response.text();
  } catch (error) {
    console.warn('[organizationParser] fetch failed', url, error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findItemProp(html, prop) {
  const re = new RegExp(`itemprop=${prop}[^>]*>([\\s\\S]*?)<`, 'i');
  const match = html.match(re);
  return match ? stripTags(match[1]) : '';
}

function extractField(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return '';
}

export function extractLocality(address) {
  const text = String(address ?? '');
  const match = text.match(/(?:^|\s)(г\.\s*п\.|аг\.|пос\.|г\.|д\.|рп|п\.|гор\.|с\/ст|к\.)\s*([^,;\s]+)/u);
  return match ? `${match[1].trim()} ${match[2].trim()}` : '';
}

function parseBizinspect(html, unp) {
  if (!html) return null;
  const fullName = findItemProp(html, 'legalName') || extractField(html, [/(?:Полное наименование|Наименование)[^:]{0,20}:\s*([^<\n]+)/i]);
  const postal = findItemProp(html, 'postalCode');
  const locality = findItemProp(html, 'addressLocality');
  const street = findItemProp(html, 'streetAddress');
  const legalAddress = [postal && `${postal},`, 'Республика Беларусь,', locality && `${locality},`, street]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const registrationDate = html.match(/itemprop=foundingDate[^>]*datetime=([\d-]+)/)?.[1]
    ?? extractField(html, [/(?:зарегистрирован[а-я]*|дата регистрации|дата создания)[^<]{0,60}?(\d{2}\.\d{2}\.\d{4})/i]);
  const registrationBody = extractField(html, [/зарегистрирован[а-я]*\s+([^<,;.]+(?:комитет|исполком|инспекция|райисполком|горисполком)[^<,;.]*)/i]);
  const activity = extractField(html, [/(?:основн\w+ вид деятельности|вид деятельности)[^:]{0,20}:\s*([^<\n]+)/i]);
  const shortName = extractField(html, [/itemprop=alternateName[^>]*>([^<]+)</i, /itemprop=name[^>]*>([^<]+)</i]);
  if (!fullName && !legalAddress) return null;
  return {
    unp,
    fullName: fullName || shortName,
    shortName: shortName || fullName,
    legalAddress,
    registrationDate: normalizeRegDate(registrationDate),
    registrationBody,
    activity,
    locality: extractLocality(legalAddress),
  };
}

function parseKartoteka(html, unp) {
  if (!html) return null;
  const text = stripTags(html);
  const fullName = extractField(html, [/itemprop=legalName[^>]*>([^<]+)</i])
    || extractField(text, [/(?:Общество с ограниченной ответственностью|ОАО|ЗАО|ОДО|УП|ЧУП|ЧТУП|РУП|ГУ|ИП)\s*[«"'][^»"']+[»"']/]);
  const legalAddress = extractField(text, [/(?:юридический адрес|адрес регистрации|местонахождение)[^:]{0,20}:\s*([^.;\n]+)/i]);
  const registrationDate = extractField(text, [/(?:дата регистрации|зарегистрирован[а-я]*)[^0-9]{0,30}(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})/i]);
  const registrationBody = extractField(text, [/(?:орган регистрации|зарегистрирован[а-я]*\s+)[^:]{0,20}:?\s*([^.;\n]*(?:комитет|исполком|инспекция)[^.;\n]*)/i]);
  const activity = extractField(text, [/(?:основн\w+ вид деятельности|вид деятельности)[^:]{0,20}:\s*([^.;\n]+)/i]);
  const shortName = extractField(text, [/сокращ[её]нное наименование[^:]{0,20}:\s*([^.;\n]+)/i]);
  if (!fullName && !legalAddress) return null;
  return {
    unp,
    fullName,
    shortName: shortName || fullName,
    legalAddress,
    registrationDate: normalizeRegDate(registrationDate),
    registrationBody,
    activity,
    locality: extractLocality(legalAddress),
  };
}

function normalizeRegDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const dotted = text.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (dotted) return `${dotted[1].padStart(2, '0')}.${dotted[2].padStart(2, '0')}.${dotted[3].padStart(4, '0')}`;
  return text;
}

export async function fetchOrganizationByUnp(unp, options = {}) {
  const fetchImpl = options.fetchImpl;
  const normalized = String(unp ?? '').replace(/\D/g, '');
  if (!normalized) return { sources: {}, errors: ['УНП не указан'] };

  const results = {};
  const bizHtml = await fetchText(`${BIZINSPECT_SEARCH}?query=${encodeURIComponent(normalized)}&type=1`, fetchImpl);
  const biz = bizHtml ? parseBizinspect(bizHtml, normalized) : null;
  if (biz) results.bizinspect = biz;

  const kartHtml = await fetchText(`${KARTOTEKA_SEARCH}?query=${encodeURIComponent(normalized)}`, fetchImpl);
  const kart = kartHtml ? parseKartoteka(kartHtml, normalized) : null;
  if (kart) results.kartoteka = kart;

  const fields = ['fullName', 'shortName', 'legalAddress', 'registrationDate', 'registrationBody', 'activity'];
  const discrepancies = [];
  if (results.bizinspect && results.kartoteka) {
    for (const field of fields) {
      const a = results.bizinspect[field];
      const b = results.kartoteka[field];
      if (a && b && a !== b) discrepancies.push({ field, bizinspect: a, kartoteka: b });
    }
  }
  return { sources: results, discrepancies };
}

export function buildOrganizationData(source) {
  if (!source) return {};
  return {
    УНП: source.unp ?? '',
    название_организации_полное: source.fullName ?? '',
    название_организации: source.shortName ?? source.fullName ?? '',
    юридический_адрес: source.legalAddress ?? '',
    дата_регистрации: source.registrationDate ?? '',
    орган_регистрации: source.registrationBody ?? '',
    вид_деятельности: source.activity ?? '',
    Место: source.locality ?? extractLocality(source.legalAddress ?? ''),
  };
}

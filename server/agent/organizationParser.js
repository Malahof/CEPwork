const BIZINSPECT_SEARCH = 'https://bizinspect.by/search';
const KARTOTEKA_UNP = 'https://kartoteka.by/unp';

const FETCH_TIMEOUT_MS = 10000;

const LOG_HTML_LENGTH = 500;

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

function logHtml(prefix, html) {
  console.log(`[organizationParser] ${prefix} first ${LOG_HTML_LENGTH} chars:`, String(html ?? '').slice(0, LOG_HTML_LENGTH));
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

function normalizeRegDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const dotted = text.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (dotted) return `${dotted[1].padStart(2, '0')}.${dotted[2].padStart(2, '0')}.${dotted[3].padStart(4, '0')}`;
  return text;
}

function isBizinspectOwnerData(name) {
  return /bizinspect/i.test(name) || /бизинспект/i.test(name);
}

function extractBizinspectResultUrl(html) {
  const match = html.match(/href=["']?(\/inst\/[^"'\s>]+)["']?/);
  return match ? `https://bizinspect.by${match[1]}` : null;
}

function parseBizinspect(html, unp) {
  if (!html) return null;
  logHtml('bizinspect parse input', html);
  const legalName = findItemProp(html, 'legalName') || findItemProp(html, 'name');
  const shortNameMatch = html.match(/<td[^>]*>\s*Сокращ[её]нное[^<]*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const shortName = shortNameMatch ? stripTags(shortNameMatch[1]).replace(/\s+/g, ' ').trim() : legalName;
  const foundingDate = html.match(/itemprop=foundingDate[^>]*datetime=([\d-]+)/)?.[1]
    || extractField(html, [/(?:Дата регистрации|дата регистрации)[^0-9]{0,60}(\d{2}\.\d{2}\.\d{4})/i]);
  const registrationBody = extractField(html, [

    /Текущий орган уч[её]та<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i,
    /(?:орган регистрации|зарегистрировавший орган)[^:]{0,60}?([^.\n<]+(?:комитет|исполком|инспекция)[^.\n<]+)/i,
  ]);
  const activity = extractField(html, [
    /Наименование основного вида деятельности по ОКЭД<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i,
    /(?:основн\w+ вид деятельности|вид деятельности)[^:]{0,20}:\s*([^<\n]+)/i,
  ]);
  const text = stripTags(html);
  const addressFromText = extractField(text, [
    /(?:юридический адрес|адрес регистрации|местонахождение)[^:]{0,20}:\s*([^.\n]+)/i,
  ]);
  const legalAddress = addressFromText;

  console.log('[organizationParser] bizinspect extracted', {
    unp,
    legalName,
    shortName,
    legalAddress,
    registrationDate: normalizeRegDate(foundingDate),
    registrationBody,
    activity,
  });

  if (!legalName || isBizinspectOwnerData(legalName)) return null;
  return {
    unp,
    fullName: legalName,
    shortName,
    legalAddress,
    registrationDate: normalizeRegDate(foundingDate),
    registrationBody,
    activity,
    locality: extractLocality(legalAddress),
  };
}

function parseKartotekaText(html, unp) {
  const text = stripTags(html);
  const fullName = extractField(text, [
    /Наименование\s*РусBel\s*([\s\S]*?)\s*История названий/i,
    /Наименование\s*([\s\S]{3,200}?)\s*История названий/i,
  ]);
  const lines = fullName.split(/\s{2,}|\n/).map((s) => s.trim()).filter(Boolean);
  const candidateFull = lines.find((l) => /(открытое|закрытое|общество|акционерное|ограниченной|учреждение)\s+/.test(l.toLowerCase()) && !/^(ООО|ОАО|ЗАО|УП|РУП|ТДООО|ООО\()/.test(l))
    || lines.find((l) => /^(ООО|ОАО|ЗАО|УП|РУП|ИП)\s+/.test(l))
    || lines[0]
    || '';
  const candidateShort = lines.find((l) => /^(ООО|ОАО|ЗАО|УП|РУП)\s*[«"]/.test(l)) || candidateFull;

  const legalAddress = extractField(text, [
    /Адрес регистрации\s*([\s\S]{10,300}?)\s*Основной вид деятельности/i,
    /Адрес регистрации\s*([^\n]{10,300})/i,
  ]).replace(/Реквизиты контрагента.*/i, '').trim();

  const registrationDate = extractField(text, [
    /Регистрация МНС\s*([\d.]{8,10})/i,
    /Регистрация ЕГР\s*([\d.]{8,10})/i,
  ]);

  const registrationBody = extractField(text, [
    /Регистрация ЕГР\s*[\d.\s()]+\s*([^\n]{3,200})/i,
    /Регистрация МНС\s*[\d.\s()]+\s*([^\n]{3,200})/i,
  ]).trim();

  const activity = extractField(text, [
    /Основной вид деятельности\s*([^\n(]{5,300})/i,
  ]).trim();

  console.log('[organizationParser] kartoteka extracted (text)', {
    unp,
    fullName: candidateFull,
    shortName: candidateShort,
    legalAddress,
    registrationDate: normalizeRegDate(registrationDate),
    registrationBody,
    activity,
  });

  if (!candidateFull && !legalAddress) return null;
  return {
    unp,
    fullName: candidateFull,
    shortName: candidateShort,
    legalAddress,
    registrationDate: normalizeRegDate(registrationDate),
    registrationBody,
    activity,
    locality: extractLocality(legalAddress),
  };
}

function parseKartoteka(html, unp) {
  if (!html) return null;
  const stateMatch = html.match(/<script id="kartoteka-state" type="application\/json">([\s\S]*?)<\/script>/);
  if (!stateMatch) {
    return parseKartotekaText(html, unp);
  }
  let data;
  try {
    data = JSON.parse(stateMatch[1]);
  } catch (error) {
    console.warn('[organizationParser] kartoteka JSON parse failed', error.message);
    return parseKartotekaText(html, unp);
  }
  const key = Object.keys(data).find((k) => k.startsWith('unp-general-info-'));
  const info = data[key] ?? data['last-unp'];
  if (!info || !info.egr) return parseKartotekaText(html, unp);

  const egr = info.egr;
  const fullName = egr.full_name || egr.fio || '';
  const shortName = egr.short_name || egr.brand_name || fullName;
  const legalAddress = egr.address || '';
  const registrationDate = egr.reg_date || '';
  const registrationBody = egr.gov_ogr_name || egr.name_org_reg_for_date_create_statement || egr.state_registration || '';
  const activity = egr.oked_primary_name || '';

  console.log('[organizationParser] kartoteka extracted', {
    unp,
    fullName,
    shortName,
    legalAddress,
    registrationDate: normalizeRegDate(registrationDate),
    registrationBody,
    activity,
  });

  if (!fullName && !legalAddress) return parseKartotekaText(html, unp);
  return {
    unp,
    fullName,
    shortName,
    legalAddress,
    registrationDate: normalizeRegDate(registrationDate),
    registrationBody,
    activity,
    locality: extractLocality(legalAddress),
  };
}

async function fetchBizinspect(unp, fetchImpl) {
  const searchUrl = `${BIZINSPECT_SEARCH}?query=${encodeURIComponent(unp)}&type=1`;
  console.log('[organizationParser] fetching', searchUrl);
  const searchHtml = await fetchText(searchUrl, fetchImpl);
  logHtml('bizinspect search html', searchHtml);
  const containsUnp = searchHtml && searchHtml.includes(unp);
  console.log('[organizationParser]', searchUrl, { ok: Boolean(searchHtml), containsUnp });
  if (!searchHtml || !containsUnp) return null;

  const resultUrl = extractBizinspectResultUrl(searchHtml);
  if (!resultUrl) return null;
  console.log('[organizationParser] fetching', resultUrl);
  const instHtml = await fetchText(resultUrl, fetchImpl);
  logHtml('bizinspect inst html', instHtml);
  console.log('[organizationParser]', resultUrl, { ok: Boolean(instHtml), containsUnp: instHtml && instHtml.includes(unp) });
  if (!instHtml || !instHtml.includes(unp)) return null;
  return parseBizinspect(instHtml, unp);
}

async function fetchKartoteka(unp, fetchImpl) {
  const url = `${KARTOTEKA_UNP}-${encodeURIComponent(unp)}`;
  console.log('[organizationParser] fetching', url);
  const html = await fetchText(url, fetchImpl);
  logHtml('kartoteka html', html);
  if (!html) {
    console.log('[organizationParser]', url, { ok: false });
    return null;
  }
  const result = parseKartoteka(html, unp);
  console.log('[organizationParser]', url, { ok: Boolean(result) });
  return result;
}

export async function fetchOrganizationByUnp(unp, options = {}) {
  const fetchImpl = options.fetchImpl;
  const normalized = String(unp ?? '').replace(/\D/g, '');
  if (!normalized) return { sources: {}, errors: ['УНП не указан'] };

  const results = {};

  const kart = await fetchKartoteka(normalized, fetchImpl);
  if (kart) results.kartoteka = kart;

  const biz = await fetchBizinspect(normalized, fetchImpl);
  if (biz) results.bizinspect = biz;

  const fields = ['fullName', 'shortName', 'legalAddress', 'registrationDate', 'registrationBody', 'activity'];
  const discrepancies = [];
  if (results.bizinspect && results.kartoteka) {
    for (const field of fields) {
      const a = results.bizinspect[field];
      const b = results.kartoteka[field];
      if (a && b && a !== b) discrepancies.push({ field, bizinspect: a, kartoteka: b });
    }
  }

  console.log('[organizationParser] final result', { unp: normalized, sources: Object.keys(results), discrepancies: discrepancies.length });
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

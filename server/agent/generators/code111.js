import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { parseDateToFormat, replaceXmlPlaceholders } from '../../utils/docxHelpers.js';
import { resolveDisposalMethod } from '../disposalResolver.js';
import { addWasteToReference, findWasteInReference, isWasteInReference, loadWasteReference, markWasteAsIgnored, syncWasteReferencePage } from '../wasteReference.js';
import { buildOrganizationData, fetchOrganizationByUnp } from '../organizationParser.js';
import { readDocsSnapshot, writeDocsSnapshot } from './code112.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'agent-docs');
const DEFAULT_DOCS_PATH = path.join(PROJECT_ROOT, 'data', 'docs.json');
const TEMPLATE_DIR = path.join(PROJECT_ROOT, 'templates', 'docx', 'instruction');

export const code111Documents = [
  { key: 'instruction', label: 'Инструкция по обращению с отходами производства', fileName: 'instruktsiya-po-obrashcheniyu-s-otkhodami.docx' },
  { key: 'application', label: 'Заявление на согласование инструкции', fileName: 'zayavlenie-instruktsiya.docx' },
];

export const code111Sections = [
  { key: 'section1', label: 'Раздел 1. Общие сведения', variables: [
    'название_организации_полное', 'название_организации', 'юридический_адрес', 'адрес', 'УНП', 'дата_регистрации', 'орган_регистрации', 'вид_деятельности', 'Место'
  ]},
  { key: 'section2', label: 'Раздел 2. Ответственные лица', variables: ['positions'] },
  { key: 'section3', label: 'Раздел 3. Общие положения', variables: [] },
  { key: 'section4', label: 'Раздел 4. Требования к сбору, накоплению и хранению отходов', variables: ['wastes'] },
  { key: 'section5', label: 'Раздел 5. Требования к размещению и обезвреживанию отходов', variables: ['wastes'] },
  { key: 'section6', label: 'Раздел 6. Требования к транспортированию отходов', variables: ['wastes'] },
  { key: 'section7', label: 'Раздел 7. Требования к учёту и контролю образования отходов', variables: [] },
  { key: 'section8', label: 'Раздел 8. Порядок действий при чрезвычайных ситуациях', variables: [] },
  { key: 'appendixA', label: 'Приложение А. Список должностей', variables: ['positions'] },
  { key: 'appendixB', label: 'Приложение Б. Список отходов', variables: ['wastes'] },
  { key: 'appendixC', label: 'Приложение В. Дополнительные документы', variables: ['statement.extraDocs'] },
  { key: 'appendixD', label: 'Приложение Г. Лицензии/экспертиза', variables: ['conditionalBlocks'] },
];

const DEFAULT_POSITIONS = ['Директор (заместитель директора)', 'Главный бухгалтер', 'Инженер по охране окружающей среды', 'Руководители структурных подразделений'];

const ORG_MANUAL_FIELDS = [
  'название_организации_полное',
  'название_организации',
  'юридический_адрес',
  'дата_регистрации',
  'орган_регистрации',
  'вид_деятельности',
];

const CONDITIONAL_BLOCKS = [
  { key: 'аренда', question: 'В организации арендуются помещения (отход 9120400 принадлежит арендодателю)?', pattern: /арендодател/i },
  { key: 'цех', question: 'В организации введён в эксплуатацию цех/объект по использованию отходов?', pattern: /цех по переработки|цех по переработке|введен в эксплуатацию цех/i },
  { key: 'лицензия', question: 'Организации выдана лицензия на деятельность, связанную с воздействием на окружающую среду?', pattern: /лицензи/i },
  { key: 'экспертиза', question: 'Получено заключение государственной экологической экспертизы?', pattern: /экологической экспертизы/i },
];

function normalizeAnswer(value) {
  return String(value ?? '').toLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
}

function isYesAnswer(a) {
  return /^(да|yes|ага|конечно|подтверждаю|подтвердить)$/i.test(a);
}

function isNoAnswer(a) {
  return /^(нет|no|не|неа)$/i.test(a);
}

function ensureFolder(snapshot, folder) {
  const existing = snapshot.folders.find((f) => f.id === folder.id);
  if (existing) { Object.assign(existing, folder); return existing; }
  snapshot.folders.push({ ...folder });
  return folder;
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[«»"'()]/g, '')
    .replace(/[^a-zа-яё0-9]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project';
}

function ensureGeneratorState(project, now) {
  project.extractedData = project.extractedData && typeof project.extractedData === 'object' ? project.extractedData : {};
  const state = project.extractedData.code111;
  if (state && typeof state === 'object') {
    if (!state.startedAt) state.startedAt = now;
    state.step = state.step ?? 'unp';
    state.status = state.status ?? 'collecting';
    state.data = state.data ?? {};
    state.addresses = state.addresses ?? [];
    state.positions = Array.isArray(state.positions) ? state.positions : [...DEFAULT_POSITIONS];
    state.wastes = state.wastes ?? [];
    state.conditionalBlocks = state.conditionalBlocks ?? {};
    state.statement = state.statement ?? { extraDocs: [] };
    state.files = state.files ?? {};
    return state;
  }
  project.extractedData.code111 = {
    status: 'collecting',
    step: 'unp',
    startedAt: now,
    updatedAt: now,
    data: {},
    addresses: [],
    positions: [...DEFAULT_POSITIONS],
    wastes: [],
    conditionalBlocks: {},
    statement: { extraDocs: [] },
    files: {},
  };
  return project.extractedData.code111;
}

function addAgentMessage(project, text, now) {
  project.history = Array.isArray(project.history) ? project.history : [];
  project.history.push({ role: 'agent', text, at: now });
}

function addUserMessage(project, text, now) {
  project.history = Array.isArray(project.history) ? project.history : [];
  project.history.push({ role: 'user', text, at: now });
}

function askUser(project, question, options, now) {
  addAgentMessage(project, question, now);
  project.question = question;
  project.availableOptions = options ?? [];
}

// ---------- pending handlers ----------

async function handleUnp(project, state, answer, now, context) {
  if (/^вручн/i.test(normalizeAnswer(answer))) {
    state.step = 'orgManual';
    state.orgManualIndex = 0;
    askUser(project, `Введите значение поля «${ORG_MANUAL_FIELDS[0]}»`, [], now);
    return;
  }
  const unp = answer.replace(/\D/g, '');
  if (!unp) {
    askUser(project, 'Укажите УНП организации (9 цифр) или напишите «вручную».', [], now);
    return;
  }
  state.data.УНП = unp;
  const { sources, discrepancies } = await fetchOrganizationByUnp(unp, { fetchImpl: context.fetchImpl });
  if (!Object.keys(sources).length) {
    addAgentMessage(project, `Организация с УНП ${unp} не найдена на сайтах bizinspect.by и kartoteka.by. Введите данные вручную.`, now);
    state.step = 'orgManual';
    state.orgManualIndex = 0;
    askUser(project, `Введите значение поля «${ORG_MANUAL_FIELDS[0]}»`, [], now);
    return;
  }
  state.orgSources = sources;
  state.orgDiscrepancies = discrepancies ?? [];
  if (discrepancies?.length) {
    const list = discrepancies.map((d) => `• ${d.field}: bizinspect — «${d.bizinspect}», kartoteka — «${d.kartoteka}»`).join('\n');
    state.pendingOrgChoice = true;
    askUser(
      project,
      `Данные источников различаются:\n${list}\nВыберите источник данных.`,
      [
        { key: 'bizinspect', label: 'bizinspect.by' },
        { key: 'kartoteka', label: 'kartoteka.by' },
        { key: 'manual', label: 'Ввести вручную' },
      ],
      now
    );
    return;
  }
  const source = sources.kartoteka ?? sources.bizinspect;
  Object.assign(state.data, buildOrganizationData(source));
  askOrgConfirm(project, state, now);
}

function askOrgConfirm(project, state, now) {
  const d = state.data;
  state.pendingOrgConfirm = true;
  askUser(
    project,
    `Проверьте данные организации:\n• Полное название: ${d.название_организации_полное || '—'}\n• Сокращённое: ${d.название_организации || '—'}\n• Юр. адрес: ${d.юридический_адрес || '—'}\n• Дата регистрации: ${d.дата_регистрации || '—'}\n• Орган регистрации: ${d.орган_регистрации || '—'}\n• Вид деятельности: ${d.вид_деятельности || '—'}\n• Место: ${d.Место || '—'}\nВсё верно?`,
    [
      { key: 'confirm', label: 'Подтвердить' },
      { key: 'manual', label: 'Исправить вручную' },
    ],
    now
  );
}

function handleOrgChoice(project, state, answer, now) {
  const a = normalizeAnswer(answer);
  state.pendingOrgChoice = false;
  if (a === 'manual' || a === 'ввести вручную') {
    state.step = 'orgManual';
    state.orgManualIndex = 0;
    askUser(project, `Введите значение поля «${ORG_MANUAL_FIELDS[0]}»`, [], now);
    return;
  }
  const source = a === 'bizinspect' ? state.orgSources?.bizinspect : state.orgSources?.kartoteka;
  Object.assign(state.data, buildOrganizationData(source ?? state.orgSources?.kartoteka ?? state.orgSources?.bizinspect));
  askOrgConfirm(project, state, now);
}

function handleOrgConfirm(project, state, answer, now) {
  state.pendingOrgConfirm = false;
  if (isYesAnswer(answer) || normalizeAnswer(answer) === 'confirm' || normalizeAnswer(answer) === 'подтвердить') {
    askManagerPosition(project, state, now);
    return;
  }
  state.step = 'orgManual';
  state.orgManualIndex = 0;
  askUser(project, `Введите значение поля «${ORG_MANUAL_FIELDS[0]}»`, [], now);
}

function handleOrgManual(project, state, answer, now) {
  const field = ORG_MANUAL_FIELDS[state.orgManualIndex];
  state.data[field] = answer;
  state.orgManualIndex += 1;
  if (state.orgManualIndex < ORG_MANUAL_FIELDS.length) {
    askUser(project, `Введите значение поля «${ORG_MANUAL_FIELDS[state.orgManualIndex]}»`, [], now);
    return;
  }
  state.step = 'manager';
  state.data.Место = state.data.Место || extractLocalityText(state.data.юридический_адрес);
  askManagerPosition(project, state, now);
}

function extractLocalityText(address) {
  const match = String(address ?? '').match(/\b(аг\.|пос\.|г\.|д\.|рп|п\.)\s*[^,;\s]+/u);
  return match ? match[0].trim() : '';
}

function askManagerPosition(project, state, now) {
  state.step = 'managerPosition';
  state.pendingManager = 'position';
  askUser(project, 'Укажите должность руководителя организации (например, «Директор»).', [], now);
}

function handleManager(project, state, answer, now) {
  if (state.pendingManager === 'position') {
    state.data.должность_руководителя = answer;
    state.pendingManager = 'name';
    askUser(project, 'Укажите инициалы и фамилию руководителя (например, «И.И. Иванов»).', [], now);
    return;
  }
  state.data.ФИО_руководителя = answer;
  state.pendingManager = null;
  state.step = 'addresses';
  askUser(project, 'Укажите адреса мест осуществления деятельности, связанной с обращением с отходами (каждый адрес с новой строки или через «;»). Если адрес один — укажите юридический адрес или «совпадает».', [], now);
}

function handleAddresses(project, state, answer, now) {
  const a = normalizeAnswer(answer);
  if (/совпадает|тот же|юридическ/i.test(a)) {
    state.addresses = [state.data.юридический_адрес || answer];
  } else {
    state.addresses = answer.split(/[\n;]/).map((s) => s.trim()).filter(Boolean);
  }
  if (!state.addresses.length) state.addresses = [state.data.юридический_адрес || ''];
  state.step = 'conditionals';
  state.conditionalIndex = 0;
  askNextConditional(project, state, now);
}

function askNextConditional(project, state, now) {
  const block = CONDITIONAL_BLOCKS[state.conditionalIndex];
  if (!block) {
    state.step = 'positions';
    state.pendingPositions = 'confirm';
    askUser(
      project,
      `Раздел 2 — ответственные лица. Типовой набор должностей:\n${state.positions.map((p, i) => `${i + 1}. ${p}`).join('\n')}\nПодходит или хотите изменить список?`,
      [
        { key: 'confirm', label: 'Подходит' },
        { key: 'edit', label: 'Изменить' },
      ],
      now
    );
    return;
  }
  state.pendingConditional = block.key;
  askUser(project, `Раздел 1. ${block.question}`, [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }], now);
}

function handleConditional(project, state, answer, now) {
  const a = normalizeAnswer(answer);
  if (!isYesAnswer(a) && !isNoAnswer(a) && a !== 'yes' && a !== 'no') {
    const current = CONDITIONAL_BLOCKS.find((b) => b.key === state.pendingConditional);
    askUser(project, `Пожалуйста, ответьте «Да» или «Нет». ${current ? current.question : 'Продолжить?'}`, [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }], now);
    return;
  }
  state.conditionalBlocks[state.pendingConditional] = isYesAnswer(answer) || a === 'yes';
  state.pendingConditional = null;
  state.conditionalIndex += 1;
  askNextConditional(project, state, now);
}

function handlePositions(project, state, answer, now) {
  const a = normalizeAnswer(answer);
  if (state.pendingPositions === 'confirm') {
    if (a === 'edit' || a === 'изменить') {
      state.pendingPositions = 'edit';
      askUser(project, 'Введите список должностей ответственных лиц — каждая с новой строки или через «;».', [], now);
      return;
    }
    state.pendingPositions = null;
    state.step = 'wastes';
    askWasteList(project, state, now);
    return;
  }
  const list = answer.split(/[\n;]/).map((s) => s.trim()).filter(Boolean);
  if (list.length) state.positions = list;
  state.pendingPositions = null;
  state.step = 'wastes';
  askWasteList(project, state, now);
}

function askWasteList(project, state, now) {
  askUser(
    project,
    'Раздел 5 — отходы. Введите перечень отходов — по одному на строку в формате «код;наименование;класс;физ. состояние». Можно также загрузить файл.',
    [],
    now
  );
}

function parseWasteInput(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const parts = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/[;|]/).map((p) => p.trim());
    if (parts.length < 2 || !/^\d{3,}/.test(parts[0])) continue;
    rows.push({
      code: parts[0],
      name: parts[1] ?? '',
      hazardClass: parts[2] ?? '',
      physicalState: parts[3] ?? '',
      source: parts[4] ?? '',
      site: parts[5] ?? '',
      storage: parts[6] ?? '',
      size: parts[7] ?? '',
      handling: parts[8] ?? '',
      normative: parts[9] ?? '',
      density: parts[10] ?? '',
    });
  }
  return rows;
}

async function handleWastes(project, state, answer, now, context) {
  const rows = parseWasteInput(answer);
  if (!rows.length) {
    askUser(project, 'Не удалось распознать отходы. Введите строки вида «код;наименование;класс;физ. состояние».', [], now);
    return;
  }
  const reference = await loadWasteReference(state.referencePath);
  const newWastes = [];
  const declined = new Set(state.referenceDeclined ?? []);
  for (const row of rows) {
    const ref = findWasteInReference(reference, row.code);
    const waste = {
      ...row,
      source: row.source || ref?.source || '',
      composition: ref?.composition || '',
      density: row.density || ref?.density || '',
      definition: '',
      quantity: '',
      unit: 'т',
    };
    state.wastes.push(waste);
    if (!ref && !declined.has(row.code)) newWastes.push(waste);
  }
  // Default определение + обращение
  for (const waste of state.wastes) {
    waste.definition = defaultDefinition(waste);
    if (!waste.handling) {
      const resolved = await resolveDisposalMethod(waste.code, { referenceTexts: context.referenceTexts });
      waste.handling = resolved?.method ?? 'захоронение';
      waste.handlingSource = resolved ? 'auto' : 'default';
    }
  }
  if (newWastes.length) {
    const w = newWastes[0];
    state.pendingReference = { code: w.code, name: w.name, queue: newWastes.slice(1), fields: {} };
    askUser(
      project,
      `Отход ${w.code} «${w.name || '—'}» отсутствует в справочнике. Хотите добавить его? Будут сохранены источник, состав и плотность.`,
      [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }],
      now
    );
    return;
  }
  askWasteDetails(project, state, now);
}

function defaultDefinition(waste) {
  if (/ртуть|ламп/i.test(waste.name ?? '') || /шт/i.test(waste.unit ?? '')) return 'Пересчет поштучно';
  if (waste.code === '9120400') return 'Расчетный';
  return 'Взвешивание';
}

function askWasteDetails(project, state, now) {
  state.step = 'wasteDetails';
  const list = state.wastes.map((w) => `${w.code} — ${w.name || '—'} (обращение: ${w.handling || '—'})`).join('\n');
  askUser(
    project,
    `Отходы:\n${list}\n\nДля каждого отхода укажите адрес/участок, способ хранения и размер (площадка/контейнер) — по строке вида «код;участок;способ;размер». Если способ обращения нужно изменить, добавьте «обращение» пятым полем.`,
    [],
    now
  );
}

async function handleWasteDetails(project, state, answer, now) {
  for (const line of answer.split(/\r?\n/)) {
    const parts = line.split(/[;|]/).map((p) => p.trim());
    if (!/^\d{3,}/.test(parts[0] ?? '')) continue;
    const waste = state.wastes.find((w) => w.code === parts[0]);
    if (!waste) continue;
    if (parts[1]) waste.site = parts[1];
    if (parts[2]) waste.storage = parts[2];
    if (parts[3]) waste.size = parts[3];
    if (parts[4]) waste.handling = parts[4];
    if (parts[5]) waste.normative = parts[5];
  }
  state.step = 'section4';
  state.pendingPod10 = true;
  askUser(project, `Раздел 4 — учёт отходов. Книг ПОД-9: ${state.addresses.length} (по числу адресов). Дата составления отчёта ПОД-10 — по умолчанию 15 число. Подтвердить или ввести другую дату?`, [
    { key: 'yes', label: '15 число' },
    { key: 'other', label: 'Другая дата' },
  ], now);
}

async function handlePendingReference(project, state, answer, now, ctx) {
  const pending = state.pendingReference;
  const a = normalizeAnswer(answer);
  if (pending.stage === 'details') {
    const parts = answer.split(/[;|]/).map((p) => p.trim());
    if (parts[0]) pending.fields.source = parts[0];
    if (parts[1]) pending.fields.composition = parts[1];
    if (parts[2]) pending.fields.density = parts[2];
    await addWasteToReference({ code: pending.code, name: pending.name, ...pending.fields }, state.referencePath);
    await syncWasteReferencePage(ctx.docsPath ?? DEFAULT_DOCS_PATH, state.referencePath);
    addAgentMessage(project, `Отход ${pending.code} добавлен в справочник.`, now);
    nextReference(project, state, pending, now);
    return;
  }
  if (isYesAnswer(answer) || a === 'yes') {
    pending.stage = 'details';
    askUser(project, `Укажите для отхода ${pending.code}: источник; состав; плотность (т/м³) — через «;».`, [], now);
    return;
  }
  addAgentMessage(project, `Отход ${pending.code} не будет добавлен в справочник.`, now);
  state.referenceDeclined = markWasteAsIgnored(state.referenceDeclined, pending.code);
  nextReference(project, state, pending, now);
}

function nextReference(project, state, pending, now) {
  const next = pending.queue?.shift();
  state.pendingReference = null;
  if (next) {
    state.pendingReference = { code: next.code, name: next.name, queue: pending.queue, fields: {} };
    askUser(
      project,
      `Отход ${next.code} «${next.name || '—'}» отсутствует в справочнике. Добавить?`,
      [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }],
      now
    );
    return;
  }
  askWasteDetails(project, state, now);
}

function handlePod10(project, state, answer, now) {
  state.pendingPod10 = false;
  const a = normalizeAnswer(answer);
  state.data.pod10Date = (a === 'yes' || isYesAnswer(answer) || a === '15 число') ? '15' : answer;
  state.pendingReport = true;
  askUser(project, 'Оставить в разделе 4 блок отчётности «1-отходы»?', [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }], now);
}

function handleReport(project, state, answer, now) {
  state.pendingReport = false;
  state.reportBlock = isYesAnswer(answer) || normalizeAnswer(answer) === 'yes';
  state.step = 'ready';
  askMenu(project, state, now, 'Основные данные собраны. Приложения А и Г будут сформированы автоматически; схемы для приложений Б и В вставляются вручную в сгенерированный документ.');
}

// ---------- generation ----------

function buildVariables(state) {
  const d = state.data;
  return {
    'нач_органа': d.нач_органа ?? '',
    'орган': d.орган ?? '',
    'адрес': state.addresses.join(';\n'),
    'адрес_органа': d.адрес_органа ?? '',
    'фио_нач_органа': d.фио_нач_органа ?? '',
    'Место': d.Место ?? '',
    'название_организации_полное': d.название_организации_полное ?? '',
    'название_организации': d.название_организации ?? '',
    'юридический_адрес': d.юридический_адрес ?? '',
    'УНП': d.УНП ?? '',
    'дата_регистрации': d.дата_регистрации ? parseDateToFormat(d.дата_регистрации) : '',
    'вид_деятельности': d.вид_деятельности ?? '',
    'орган_регистрации': d.орган_регистрации ?? '',
    'должность_руководителя': d.должность_руководителя ?? '',
    'ФИО_руководителя': d.ФИО_руководителя ?? '',
    'телефон': d.телефон ?? 'телефон',
    'листы': d.листы ?? '',
  };
}

function rowText(rowXml) {
  return [...rowXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
}

function repeatRow(xml, matcher, items, varsFn) {
  const rows = [...xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)];
  const target = rows.find((r) => matcher.test(rowText(r[0])));
  if (!target) return xml;
  const template = target[0];
  const rendered = items.map((item, i) => replaceXmlPlaceholders(template, varsFn(item, i)));
  return xml.slice(0, target.index) + rendered.join('') + xml.slice(target.index + template.length);
}

function removeParagraphsMatching(xml, pattern) {
  return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (p) => (pattern.test(rowText(p)) ? '' : p));
}

async function generateInstructionDocx(project, state, outputDir, now) {
  const templatePath = path.join(TEMPLATE_DIR, 'instruction_template.docx');
  const zip = await JSZip.loadAsync(await readFile(templatePath));
  let xml = await zip.file('word/document.xml').async('string');

  const vars = buildVariables(state);

  // Раздел 2 — должности: повторяем таблицу с [должность] по каждой позиции
  xml = repeatTable(xml, /\[должность\]/, state.positions, (pos) => ({ 'должность': pos }));

  // Условные блоки раздела 1
  for (const block of CONDITIONAL_BLOCKS) {
    if (state.conditionalBlocks[block.key] === false) xml = removeParagraphsMatching(xml, block.pattern);
  }

  // Раздел 3 — нормативы (захоронение: норматив = единица)
  const landfill = state.wastes.filter((w) => w.handling === 'захоронение');
  xml = repeatRow(xml, /\[норматив\]/, landfill, (w) => ({ 'код': w.code, 'отход': w.name, 'норматив': w.unit || 'т' }));

  // Раздел 4 — способы определения объёма
  xml = repeatRow(xml, /\[определение\]/, state.wastes, (w) => ({ 'код': w.code, 'отход': w.name, 'определение': w.definition || '' }));

  // Раздел 5.2 — сбор и хранение
  xml = repeatRow(xml, /\[источник\].*\[способ\].*\[размер\].*\[обращение\]/, state.wastes, (w) => ({
    'код': w.code, 'отход': w.name, 'класс': w.hazardClass || '', 'физ_сост': w.physicalState || '',
    'источник': w.source || '', 'адрес': w.site || state.addresses[0] || '', 'участок': w.site || '',
    'способ': w.storage || '', 'размер': w.size || '', 'обращение': w.handling || '',
  }));

  // Раздел 6 — таблицы по способам обращения
  xml = repeatRow(xml, /Передается специализированной организации для дальнейшего использования/, state.wastes.filter((w) => w.handling === 'использование'), (w) => ({ 'код': w.code, 'отход': w.name, 'класс': w.hazardClass || '', 'физ_сост': w.physicalState || '' }));
  xml = repeatRow(xml, /Передается специализированной организации для дальнейшего обезвреживания/, state.wastes.filter((w) => w.handling === 'обезвреживание'), (w) => ({ 'код': w.code, 'отход': w.name, 'класс': w.hazardClass || '', 'физ_сост': w.physicalState || '' }));
  xml = repeatRow(xml, /заготовки/, state.wastes.filter((w) => w.handling === 'заготовка'), (w) => ({ 'код': w.code, 'отход': w.name, 'класс': w.hazardClass || '', 'физ_сост': w.physicalState || '' }));
  xml = repeatRow(xml, /\[способ обезвреживания\]/, state.wastes.filter((w) => w.handling === 'обезвреживание_собств'), (w) => ({ 'код': w.code, 'отход': w.name, 'класс': w.hazardClass || '', 'физ_сост': w.physicalState || '', 'способ обезвреживания': w.neutralization || '' }));
  xml = repeatRow(xml, /собственном объекте по использованию отходов/, state.wastes.filter((w) => w.handling === 'использование_собств'), (w) => ({ 'код': w.code, 'отход': w.name, 'класс': w.hazardClass || '', 'физ_сост': w.physicalState || '' }));

  // Раздел 7 — захоронение
  xml = repeatRow(xml, /Передается на полигон ТКО для захоронения/, landfill, (w) => ({ 'код': w.code, 'отход': w.name, 'класс': w.hazardClass || '' }));

  // Приложение А — перечень отходов
  xml = repeatRow(xml, /\[степень\]/, state.wastes, (w) => ({
    'код': w.code, 'отход': w.name, 'класс': w.hazardClass || '', 'степень': w.degree || '',
    'физ_сост': w.physicalState || '', 'источник': w.source || '', 'обращение': w.handling || '',
  }));

  // Приложение Б — источники по участкам
  const sources = [...new Set(state.wastes.map((w) => w.source).filter(Boolean))];
  xml = repeatRow(xml, /\[номер_источника\].*\[источник\]/, sources, (s, i) => ({ 'номер_источника': String(i + 1), 'источник': s }));
  xml = repeatRow(xml, /\[участок\].*\[номер_источника\]/, state.addresses, (a, i) => ({ 'участок': a, 'номер_источника': String(i + 1) }));
  xml = repeatRow(xml, /^\s*1\s*\[участок\]\s*$/, state.addresses, (a) => ({ 'участок': a }));

  // Приложение В — хранимые отходы
  xml = repeatRow(xml, /\[код\].*\[отход\].*\[класс\]\s*$/, state.wastes.filter((w) => !/не хранится/i.test(w.storage ?? '')), (w) => ({ 'код': w.code, 'отход': w.name, 'класс': w.hazardClass || '' }));

  // Приложение Г — расчёт-обоснование: 4 варианта строк
  const calcRows = {
    'площадка': /Открытая площадка/,
    'контейнер': /Контейнер объемом/,
    'при работах': /При проведении работ грузится/,
    'ёмкость': /Емкость объемом/,
    'при сборе': /При сборе грузится/,
  };
  const calcItems = state.wastes.map((w) => {
    const density = parseFloat(String(w.density).replace(',', '.')) || 0;
    const sizeMatch = String(w.size ?? '').match(/([\d.,]+)\s*[xх×]\s*([\d.,]+)(?:\s*[xх×]\s*([\d.,]+))?/);
    let amount = '-';
    let basis = w.size || '';
    if (density && sizeMatch) {
      const a = parseFloat(sizeMatch[1].replace(',', '.'));
      const b = parseFloat(sizeMatch[2].replace(',', '.'));
      const c = sizeMatch[3] ? parseFloat(sizeMatch[3].replace(',', '.')) : 1;
      amount = (a * b * c * density).toFixed(2);
      basis = `${a}*${b}${sizeMatch[3] ? `*${c}` : ''}*${density} = ${amount} т`;
    }
    const freq = w.code === '9120400' ? '1 раз в неделю' : /не хранится/i.test(w.storage ?? '') ? 'по количеству выполненных работ' : '1 раз в год';
    const freqBasis = /контейнер|емкост/i.test(w.storage ?? '') ? 'По мере заполнения накопительных емкостей' : 'По мере заполнения площадки';
    return { w, amount, basis, freq, freqBasis };
  });
  const categoryOf = (item) => /не хранится/i.test(item.w.storage ?? '') ? 'при сборе' : /контейнер/i.test(item.w.storage ?? '') ? 'контейнер' : /емкост/i.test(item.w.storage ?? '') ? 'ёмкость' : /работ/i.test(item.w.storage ?? '') ? 'при работах' : 'площадка';
  for (const [cat, re] of Object.entries(calcRows)) {
    const items = calcItems.filter((i) => categoryOf(i) === cat);
    xml = repeatRow(xml, re, items, (i) => ({ 'отход': i.w.name, 'Периодичность вывоза': i.freq, 'Обоснование периодичности': i.freqBasis }));
  }

  xml = replaceXmlPlaceholders(xml, vars);
  zip.file('word/document.xml', xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const projectDir = path.join(outputDir, project.id);
  await mkdir(projectDir, { recursive: true });
  const fileName = code111Documents[0].fileName;
  const outputPath = path.join(projectDir, fileName);
  await writeFile(outputPath, buffer);
  state.files.instruction = {
    status: 'ready',
    fileName,
    path: outputPath,
    downloadUrl: `/api/agent/files/${encodeURIComponent(project.id)}/${encodeURIComponent(fileName)}`,
    generatedAt: now,
  };
  state.instructionGenerated = true;
  // листы из docProps/app.xml
  try {
    const appXml = await zip.file('docProps/app.xml')?.async('string');
    const pages = appXml?.match(/<Pages>(\d+)<\/Pages>/)?.[1];
    state.data.листы = pages ?? '';
  } catch { /* ignore */ }
  return outputPath;
}

function repeatTable(xml, markerRegex, items, varsFn) {
  const tables = [...xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)];
  const target = tables.find((t) => markerRegex.test(rowText(t[0])));
  if (!target) return xml;
  const template = target[0];
  const rendered = items.map((item, i) => replaceXmlPlaceholders(template, varsFn(item, i)));
  return xml.slice(0, target.index) + rendered.join('') + xml.slice(target.index + template.length);
}

async function generateApplicationDocx(project, state, outputDir, now) {
  const templatePath = path.join(TEMPLATE_DIR, 'application_template.docx');
  const zip = await JSZip.loadAsync(await readFile(templatePath));
  let xml = await zip.file('word/document.xml').async('string');
  const vars = buildVariables(state);
  const docs = ['инструкция по обращению с отходами производства на ' + (state.data.листы || '—') + ' листах, в 2 экз.', ...(state.statement?.extraDocs ?? [])];
  vars['перечень'] = docs.map((d, i) => `${i + 1}) ${d}`).join(';\n');
  xml = replaceXmlPlaceholders(xml, vars);
  zip.file('word/document.xml', xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const projectDir = path.join(outputDir, project.id);
  await mkdir(projectDir, { recursive: true });
  const fileName = code111Documents[1].fileName;
  const outputPath = path.join(projectDir, fileName);
  await writeFile(outputPath, buffer);
  state.files.application = {
    status: 'ready',
    fileName,
    path: outputPath,
    downloadUrl: `/api/agent/files/${encodeURIComponent(project.id)}/${encodeURIComponent(fileName)}`,
    generatedAt: now,
  };
  return outputPath;
}

// ---------- menu / question / options ----------

function menuOptions(state) {
  const opts = [
    { key: 'generateDocs', label: 'Сгенерировать DOCX' },
    { key: 'generateAll', label: 'Закончить / Сгенерировать DOCX' },
  ];
  if (state.instructionGenerated) opts.push({ key: 'statement', label: 'Создать заявление' });
  opts.push({ key: 'pause', label: 'Пауза' });
  return opts;
}

function sectionForStep(step) {
  const map = {
    unp: 'section1', org: 'section1', orgManual: 'section1', conditional: 'section1',
    addresses: 'section1', positions: 'section2', manager: 'section2',
    wastes: 'section4', wasteDetails: 'section4', pod10: 'section7', report: 'section7', ready: 'section1'
  };
  return map[step] || 'section1';
}

function askMenu(project, state, now, prefix = '') {
  const sectionKey = sectionForStep(state.step);
  const section = code111Sections.find((s) => s.key === sectionKey) ?? code111Sections[0];
  const question = `${prefix ? prefix + '\n' : ''}Работаем над «${section.label}». К чему приступить?`;
  syncCode111ProjectPages(project, state, DEFAULT_DOCS_PATH, now, { activateSection: sectionKey }).catch((e) => console.error('[code111] sync project pages failed', e));
  askUser(project, question, menuOptions(state), now);
}

export function getCode111Question(project) {
  const state = project.extractedData?.code111;
  if (!state) return null;
  if (project.history?.length) return project.history.at(-1).text;
  return 'Укажите УНП организации.';
}

export function getCode111Options(project) {
  const state = project.extractedData?.code111;
  if (!state) return [];
  if (state.pendingGenerationChoice || state.pendingFinalGeneration) return [
    { key: 'archive', label: 'Архив (ZIP)' },
    { key: 'separate', label: 'По отдельности' },
    { key: 'cancel', label: 'Отмена' },
  ];
  if (state.pendingOrgChoice) return [{ key: 'bizinspect', label: 'bizinspect.by' }, { key: 'kartoteka', label: 'kartoteka.by' }, { key: 'manual', label: 'Ввести вручную' }];
  if (state.pendingOrgConfirm) return [{ key: 'confirm', label: 'Подтвердить' }, { key: 'manual', label: 'Исправить вручную' }];
  if (state.pendingConditional) return [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }];
  if (state.pendingPositions) return [{ key: 'confirm', label: 'Подходит' }, { key: 'edit', label: 'Изменить' }];
  if (state.pendingReference) return [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }];
  if (state.pendingPod10) return [{ key: 'yes', label: '15 число' }, { key: 'other', label: 'Другая дата' }];
  if (state.pendingReport) return [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }];
  if (state.statementStep === 'extraDocs') return [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }];
  if (state.step === 'ready' || state.status === 'ready') return menuOptions(state);
  return [];
}

// ---------- statement flow ----------

function startStatement(project, state, now) {
  if (!state.instructionGenerated) {
    askUser(project, 'Сначала сгенерируйте инструкцию (команда «Сгенерировать DOCX»).', menuOptions(state), now);
    return;
  }
  state.statementStep = 'organ';
  askUser(project, 'Заявление. Укажите орган, в который подаётся заявление (в родительном падеже, например «Минского областного комитета») — определяется по адресам осуществления деятельности.', [], now);
}

function handleStatement(project, state, answer, now) {
  const st = state.statementStep;
  if (st === 'organ') { state.data.орган = answer; state.statementStep = 'organAddress'; askUser(project, 'Укажите адрес органа.', [], now); return; }
  if (st === 'organAddress') { state.data.адрес_органа = answer; state.statementStep = 'phone'; askUser(project, 'Укажите телефон организации (или «пропустить»).', [], now); return; }
  if (st === 'phone') {
    state.data.телефон = /пропуст/i.test(normalizeAnswer(answer)) ? '' : answer;
    state.statementStep = 'extraDocs';
    askUser(project, 'Перечень документов: инструкция уже добавлена. Хотите дополнить перечень?', [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }], now);
    return;
  }
  if (st === 'extraDocs') {
    if (isYesAnswer(answer) || normalizeAnswer(answer) === 'yes') { state.statementStep = 'extraDocItem'; askUser(project, 'Введите пункт в формате «Название, кол-во листов, кол-во экз.».', [], now); return; }
    state.statementStep = 'confirm';
    askUser(project, 'Сгенерировать заявление?', [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }], now);
    return;
  }
  if (st === 'extraDocItem') {
    state.statement.extraDocs.push(answer);
    state.statementStep = 'extraDocs';
    askUser(project, 'Добавить ещё пункт?', [{ key: 'yes', label: 'Да' }, { key: 'no', label: 'Нет' }], now);
    return;
  }
  if (st === 'confirm') {
    if (isYesAnswer(answer) || normalizeAnswer(answer) === 'yes') {
      return 'generate';
    }
    state.statementStep = null;
    askMenu(project, state, now, 'Создание заявления отменено.');
    return;
  }
  return null;
}

// ---------- archiving ----------

async function archiveProjectInDocs(project, state, docsPath, now) {
  const snapshot = await readDocsSnapshot(docsPath);
  const projectFolderId = `agent-${project.id}`;
  const year = new Date(now).getFullYear();
  const organizationName = state.data.название_организации || 'Новый проект';
  const archiveRootId = 'archive';
  const archiveWasteId = 'archive-otkhody';
  const archiveDevId = 'archive-otkhody-razrabotka';
  const archiveYearId = `archive-otkhody-razrabotka-${year}`;
  const archiveProjectId = `archive-otkhody-razrabotka-${year}-${slugify(organizationName)}-${project.id}`;
  ensureFolder(snapshot, { id: archiveRootId, title: 'Архив', parentId: null, order: 100 });
  ensureFolder(snapshot, { id: archiveWasteId, title: 'Отходы', parentId: archiveRootId, order: 0 });
  ensureFolder(snapshot, { id: archiveDevId, title: 'Разработка', parentId: archiveWasteId, order: 0 });
  ensureFolder(snapshot, { id: archiveYearId, title: String(year), parentId: archiveDevId, order: 0 });
  ensureFolder(snapshot, { id: archiveProjectId, title: organizationName, parentId: archiveYearId, order: 0 });
  const idx = snapshot.folders.findIndex((f) => f.id === projectFolderId);
  if (idx >= 0) snapshot.folders[idx].parentId = archiveProjectId;
  if (snapshot.activePageId?.startsWith(`agent-${project.id}-code111`)) snapshot.activePageId = null;
  await writeDocsSnapshot(docsPath, snapshot);
}

function getVariableDisplay(state, variable) {
  if (variable === 'positions') {
    const positions = Array.isArray(state.positions) ? state.positions : [];
    if (!positions.length) return '_нет данных_';
    return positions.map((p) => `- ${p}`).join('\n');
  }
  if (variable === 'wastes') {
    const wastes = Array.isArray(state.wastes) ? state.wastes : [];
    if (!wastes.length) return '_нет данных_';
    return wastes.map((w) => `- ${w.code} — ${w.name || w.wasteName || '—'}`).join('\n');
  }
  if (variable === 'statement.extraDocs') {
    const docs = Array.isArray(state.statement?.extraDocs) ? state.statement.extraDocs : [];
    if (!docs.length) return '_нет данных_';
    return docs.map((d) => `- ${d}`).join('\n');
  }
  if (variable === 'conditionalBlocks') {
    const keys = Object.keys(state.conditionalBlocks ?? {});
    if (!keys.length) return '_нет данных_';
    return keys.filter((k) => state.conditionalBlocks[k]).map((k) => `- ${k}: Да`).join('\n');
  }
  return state.data?.[variable] || '_нет данных_';
}

function buildSectionContent(section, state) {
  const lines = [`# ${section.label}`];
  if (!section.variables.length) {
    lines.push('_В этом разделе данные вводятся в чате._');
  } else {
    for (const variable of section.variables) {
      const display = getVariableDisplay(state, variable);
      const label = variable === 'positions' ? 'Ответственные лица (должности)' : variable === 'wastes' ? 'Отходы' : variable === 'statement.extraDocs' ? 'Дополнительные документы' : variable;
      lines.push(`**${label}**`);
      lines.push(display);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function syncCode111ProjectPages(project, state, docsPath, now, { activateSection = null } = {}) {
  const snapshot = await readDocsSnapshot(docsPath);
  const orgName = state.data.название_организации || 'Новый проект';
  const projectFolderId = `agent-${project.id}`;
  const workFolderId = `${projectFolderId}-code111`;
  ensureFolder(snapshot, { id: 'in-progress', title: 'В разработке', parentId: null, order: 50 });
  ensureFolder(snapshot, { id: projectFolderId, title: orgName, parentId: 'in-progress', order: 0 });
  ensureFolder(snapshot, { id: workFolderId, title: 'Инструкция (111)', parentId: projectFolderId, order: 0 });
  for (const doc of code111Documents) {
    const pageId = `agent-${project.id}-code111-${doc.key}`;
    const existing = snapshot.pages.find((p) => p.id === pageId);
    if (!existing) {
      snapshot.pages.push({
        id: pageId,
        title: doc.label,
        content: `# ${doc.label}\n\nДанные заполняются через Цэпика.`,
        parentId: workFolderId,
        order: code111Documents.indexOf(doc),
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  for (const section of code111Sections) {
    const pageId = `agent-${project.id}-code111-${section.key}`;
    const content = buildSectionContent(section, state);
    const existing = snapshot.pages.find((p) => p.id === pageId);
    if (existing) {
      existing.title = section.label;
      existing.content = content;
      existing.updatedAt = now;
    } else {
      snapshot.pages.push({
        id: pageId,
        title: section.label,
        content,
        parentId: workFolderId,
        order: code111Documents.length + code111Sections.indexOf(section),
        createdAt: now,
        updatedAt: now,
      });
    }
    if (activateSection === section.key) {
      snapshot.activePageId = pageId;
    }
  }
  if (activateSection && !snapshot.activePageId) {
    snapshot.activePageId = `agent-${project.id}-code111-${activateSection}`;
  }
  await writeDocsSnapshot(docsPath, snapshot);
}

export async function registerCode111Upload(project, upload, options = {}) {
  const state = ensureGeneratorState(project, options.now ?? Date.now());
  project.extractedData.uploads = [...(project.extractedData.uploads ?? []), upload];
  const text = upload.text ?? '';
  if (state.step === 'wastes' || state.step === 'wasteDetails') {
    const rows = parseWasteInput(text);
    if (rows.length) {
      const reference = await loadWasteReference(state.referencePath);
      for (const row of rows) {
        const ref = findWasteInReference(reference, row.code);
        state.wastes.push({
          ...row,
          source: row.source || ref?.source || '',
          composition: ref?.composition || '',
          density: row.density || ref?.density || '',
          definition: '',
          unit: 'т',
        });
      }
      addAgentMessage(project, `Из файла «${upload.fileName}» добавлено отходов: ${rows.length}.`, options.now ?? Date.now());
      return;
    }
  }
  if (state.step === 'addresses') {
    const list = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (list.length) {
      state.addresses = list;
      addAgentMessage(project, `Из файла «${upload.fileName}» добавлено адресов: ${list.length}.`, options.now ?? Date.now());
      return;
    }
  }
  addAgentMessage(project, `Файл «${upload.fileName}» сохранён как источник данных.`, options.now ?? Date.now());
}

export async function regenerateArchivedCode111Documents(sourceProjectId, docKeys, outputDir, docsPath, now) {
  const projectsPath = path.join(path.dirname(docsPath ?? DEFAULT_DOCS_PATH), 'eco_projects.json');
  let source = null;
  try {
    source = JSON.parse(await readFile(projectsPath, 'utf8')).find((p) => p.id === sourceProjectId);
  } catch { /* no projects file */ }
  const saved = source?.extractedData?.code111;
  const stub = { id: sourceProjectId, history: [] };
  const state = saved ?? { data: {}, wastes: [], addresses: [], positions: [], conditionalBlocks: {}, statement: { extraDocs: [] }, files: {} };
  state.files = state.files ?? {};
  const keys = Array.isArray(docKeys) && docKeys.length ? docKeys : code111Documents.map((d) => d.key);
  const results = [];
  if (keys.includes('instruction')) {
    await generateInstructionDocx(stub, state, outputDir ?? DEFAULT_OUTPUT_DIR, now);
    results.push({ key: 'instruction', label: code111Documents[0].label, fileName: code111Documents[0].fileName, downloadUrl: state.files.instruction.downloadUrl });
  }
  if (keys.includes('application') && state.instructionGenerated) {
    await generateApplicationDocx(stub, state, outputDir ?? DEFAULT_OUTPUT_DIR, now);
    results.push({ key: 'application', label: code111Documents[1].label, fileName: code111Documents[1].fileName, downloadUrl: state.files.application.downloadUrl });
  }
  return { results };
}

// ---------- main entry ----------

export async function generate(project, userSources = {}) {
  const now = userSources.now ?? Date.now();
  const state = ensureGeneratorState(project, now);
  const answer = typeof userSources.answer === 'string' ? userSources.answer.trim() : '';
  const outputDir = userSources.outputDir ?? DEFAULT_OUTPUT_DIR;
  const docsPath = userSources.docsPath ?? DEFAULT_DOCS_PATH;
  const context = { outputDir, docsPath, fetchImpl: userSources.fetchImpl, referenceTexts: userSources.referenceTexts };
  if (userSources.referencePath) state.referencePath = userSources.referencePath;

  if (answer) addUserMessage(project, answer, now);
  state.updatedAt = now;

  // pending flows
  if (state.pendingOrgChoice) return finish(project, () => handleOrgChoice(project, state, answer, now));
  if (state.pendingOrgConfirm) return finish(project, () => handleOrgConfirm(project, state, answer, now));
  if (state.step === 'orgManual') return finish(project, () => handleOrgManual(project, state, answer, now));
  if (state.pendingManager) return finish(project, () => handleManager(project, state, answer, now));
  if (state.pendingConditional) return finish(project, () => handleConditional(project, state, answer, now));
  if (state.pendingPositions) return finish(project, () => handlePositions(project, state, answer, now));
  if (state.pendingReference) return finish(project, async () => handlePendingReference(project, state, answer, now, context));
  if (state.pendingPod10) return finish(project, () => handlePod10(project, state, answer, now));
  if (state.pendingReport) return finish(project, () => handleReport(project, state, answer, now));
  if (state.pendingGenerationChoice || state.pendingFinalGeneration) {
    const a = normalizeAnswer(answer);
    const mode = a === 'archive' || /архив|zip/i.test(a) ? 'archive' : a === 'cancel' || /отмена|нет/.test(a) ? 'cancel' : 'separate';
    const isFinal = Boolean(state.pendingFinalGeneration);
    state.pendingGenerationChoice = null;
    state.pendingFinalGeneration = null;
    if (mode === 'cancel') {
      askMenu(project, state, now, 'Генерация отменена.');
      return project;
    }
    await generateInstructionDocx(project, state, outputDir, now);
    await syncCode111ProjectPages(project, state, docsPath, now);
    if (isFinal) {
      await archiveProjectInDocs(project, state, docsPath, now);
      state.status = 'completed';
      project.status = 'completed';
      project.archivedAt = now;
      askUser(project, `Документы сгенерированы и помещены в архив. Работа завершена. [скачать](${state.files.instruction.downloadUrl})`, [], now);
    } else {
      askMenu(project, state, now, `Инструкция сгенерирована: [скачать DOCX](${state.files.instruction.downloadUrl}). Проект остаётся в папке «В разработке».`);
    }
    project.updatedAt = now;
    return project;
  }
  if (state.statementStep) {
    const result = handleStatement(project, state, answer, now);
    if (result === 'generate') {
      await generateApplicationDocx(project, state, outputDir, now);
      await syncCode111ProjectPages(project, state, docsPath, now);
      state.statementStep = null;
      askMenu(project, state, now, `Заявление сгенерировано: [скачать DOCX](${state.files.application.downloadUrl}).`);
    }
    project.updatedAt = now;
    return project;
  }

  // step-driven
  if (state.step === 'unp') {
    if (!answer) { askUser(project, 'Укажите УНП организации (9 цифр) или напишите «вручную».', [], now); return project; }
    return finish(project, async () => handleUnp(project, state, answer, now, context));
  }
  if (state.step === 'addresses') return finish(project, () => handleAddresses(project, state, answer, now));
  if (state.step === 'wastes') return finish(project, async () => handleWastes(project, state, answer, now, context));
  if (state.step === 'wasteDetails') return finish(project, async () => handleWasteDetails(project, state, answer, now, context));

  // ready / menu
  const a = normalizeAnswer(answer);
  if (a === 'generatedocs' || a === 'сгенерировать docx') {
    state.pendingGenerationChoice = true;
    askUser(project, 'Как вы хотите получить сгенерированные документы?', [
      { key: 'archive', label: 'Архив (ZIP)' },
      { key: 'separate', label: 'По отдельности' },
      { key: 'cancel', label: 'Отмена' },
    ], now);
    return project;
  }
  if (a === 'generateall' || a === 'закончить' || /закончить.*docx/.test(a)) {
    state.pendingFinalGeneration = true;
    askUser(project, 'Как вы хотите получить сгенерированные документы?', [
      { key: 'archive', label: 'Архив (ZIP)' },
      { key: 'separate', label: 'По отдельности' },
      { key: 'cancel', label: 'Отмена' },
    ], now);
    return project;
  }
  if (a === 'statement' || a === 'создать заявление') {
    startStatement(project, state, now);
    return project;
  }
  if (a === 'pause' || a === 'пауза') {
    askMenu(project, state, now, 'Проект на паузе.');
    return project;
  }
  if (state.step === 'ready' && !answer) { askMenu(project, state, now); return project; }

  // first call
  if (!answer && state.step === 'unp') {
    askUser(project, 'Укажите УНП организации (9 цифр) или напишите «вручную».', [], now);
    return project;
  }
  askMenu(project, state, now, state.step === 'ready' ? '' : 'Продолжаем заполнение.');
  return project;
}

async function finish(project, fn) {
  const r = await fn();
  return r ?? project;
}

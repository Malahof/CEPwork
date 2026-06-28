import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import { findOrganization } from '../memory.js';

export const code112FallbackMessage =
  'Извините, я пока не умею обрабатывать выбранный вами тип документации. Эта функция находится в разработке. Пожалуйста, выберите другой раздел или обратитесь к администратору.';

const FONT = 'Times New Roman';
const DASH = '−';
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'data', 'agent-docs');
const TEMPLATE_DIR = path.resolve(process.cwd(), 'templates', 'docx', 'code112');

export const code112Documents = [
  {
    key: 'titleAct',
    label: 'Титул акта инвентаризации',
    fileName: '01-titul-akta-inventarizatsii.docx',
    template: 'title-act.json',
    requiredFields: [
      'Название_организации',
      'Должность_руководителя',
      'Инициалы_фамилия_руководителя',
      'Юридический_адрес',
      'Дата_акта',
      'Дата_начала',
      'Должность_председателя',
      'Инициалы_фамилия_председателя',
      'Комиссия',
    ],
  },
  {
    key: 'appendix',
    label: 'Приложение к акту инвентаризации',
    fileName: '02-prilozhenie-k-aktu-inventarizatsii.docx',
    template: 'appendix.json',
    requiredFields: ['Дата_акта', 'Название_организации', 'Отходы'],
  },
  {
    key: 'sources',
    label: 'Источники образования отходов производства',
    fileName: '03-istochniki-obrazovaniya-otkhodov.docx',
    template: 'sources.json',
    requiredFields: ['Название_организации', 'Отходы', 'Источники_образования'],
  },
  {
    key: 'wasteFormation',
    label: 'Сведения о количестве образующихся отходов',
    fileName: '04-obrazovanie-otkhodov.docx',
    template: 'waste-formation.json',
    requiredFields: ['Отходы', 'Количество_кг'],
  },
  {
    key: 'measures',
    label: 'Перечень мероприятий',
    fileName: '05-perechen-meropriyatiy.docx',
    template: 'measures.json',
    requiredFields: ['Должность_председателя', 'Инициалы_фамилия_председателя'],
  },
];

const documentByKey = new Map(code112Documents.map((item) => [item.key, item]));
const documentByLabel = new Map(code112Documents.map((item) => [normalizeAnswer(item.label), item]));

export async function generate(projectData, userSources = {}) {
  const now = userSources.now ?? Date.now();
  const state = ensureGeneratorState(projectData, now);
  const answer = typeof userSources.answer === 'string' ? userSources.answer.trim() : '';
  const outputDir = userSources.outputDir ?? DEFAULT_OUTPUT_DIR;

  mergeCollectedData(projectData, state, userSources);

  if (!state.startedAt) {
    state.startedAt = now;
    addAgentMessage(projectData, buildStartMessage(state), now);
    askUser(projectData, 'С чего хотите начать?', menuOptions(), now);
    return projectData;
  }

  if (!answer) {
    askUser(projectData, buildProgressMessage(state), menuOptions(), now);
    return projectData;
  }

  addUserMessage(projectData, answer, now);

  if (isStopAnswer(answer)) {
    state.activeDocument = null;
    state.pausedAt = now;
    projectData.updatedAt = now;
    askUser(projectData, 'Работа по акту инвентаризации сохранена как «в работе». Когда вернётесь, продолжим с текущего места.', menuOptions(), now);
    return projectData;
  }

  if (state.activeDocument) {
    return finishActiveDocument(projectData, state, answer, outputDir, now);
  }

  const selectedDocument = findDocument(answer);
  if (selectedDocument) {
    state.activeDocument = selectedDocument.key;
    state.files[selectedDocument.key].status = 'in_progress';
    projectData.updatedAt = now;
    askUser(projectData, buildDocumentQuestion(selectedDocument, state), documentWorkOptions(), now);
    return projectData;
  }

  if (normalizeAnswer(answer) === 'generateall' || normalizeAnswer(answer) === normalizeAnswer('Сгенерировать все')) {
    await generateDocuments(projectData, state, code112Documents, outputDir, now);
    askUser(
      projectData,
      'Все 5 документов по акту инвентаризации сформированы. Если хотите сохранить данные как кейс, отправьте команду «Запомни организацию: [название], директор [ФИО], адрес [адрес]». К чему теперь приступить?',
      menuOptions(),
      now
    );
    return projectData;
  }

  const parsedAnswer = parseManualInput(answer);
  const directWasteRows = parseWasteRows(answer);
  if (Object.keys(parsedAnswer.fields).length || parsedAnswer.wastes.length || directWasteRows.length) {
    state.wastes = mergeWastes(state.wastes, directWasteRows);
    projectData.updatedAt = now;
    addAgentMessage(projectData, buildSourceSavedMessage(parsedAnswer, directWasteRows), now);
    const memoryMessage = applyOrganizationMemory(state, userSources.memory, answer);
    if (memoryMessage) addAgentMessage(projectData, memoryMessage, now);
    askUser(projectData, 'К чему теперь приступить?', menuOptions(), now);
    return projectData;
  }

  if (/^\d+$/.test(answer)) {
    console.log('[Цэпик] Запрошена нереализованная ветка', { projectId: projectData.id, code: answer });
    addAgentMessage(projectData, code112FallbackMessage, now);
    askUser(projectData, 'К чему теперь приступить?', menuOptions(), now);
    projectData.updatedAt = now;
    return projectData;
  }

  addAgentMessage(projectData, 'Я не нашёл такой пункт в списке документов для акта инвентаризации. Выберите вариант из меню или отправьте «Сгенерировать все».', now);
  askUser(projectData, 'К чему теперь приступить?', menuOptions(), now);
  projectData.updatedAt = now;
  return projectData;
}

export function getCode112Question(project) {
  const state = project.extractedData?.code112;
  if (!state) return null;
  if (state.activeDocument) return `Цэпик работает над файлом: ${documentByKey.get(state.activeDocument)?.label ?? state.activeDocument}`;
  return 'К чему теперь приступить?';
}

export function getCode112Options(project) {
  const state = project.extractedData?.code112;
  if (!state) return [];
  if (state.activeDocument) return documentWorkOptions();
  return menuOptions();
}

export function parseManualInput(text) {
  const fields = {};
  const wastes = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().replaceAll(' ', '_');
    const value = line.slice(separator + 1).trim();
    if (!key || !value) continue;
    if (key.toLocaleLowerCase('ru-RU') === 'отход') {
      wastes.push(...parseWasteRows(value));
    } else {
      fields[key] = value;
    }
  }

  return { fields, wastes };
}

export function parseWasteRows(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const parts = line.split(/[;|]/).map((part) => part.trim());
    if (parts.length < 2) continue;
    const [code, name, hazardClass = '', amount = '', unit = '', handling = '', source = '', physicalState = ''] = parts;
    if (!/^\d{2,}$/.test(code)) continue;
    rows.push(normalizeWasteRow({ code, name, hazardClass, amount, unit, handling, source, physicalState }));
  }

  return rows;
}

export function buildAppendixRows(wastes) {
  const rows = [];
  const grouped = groupWastesByHazard(wastes);

  for (const group of ['1', '2', '3', '4', 'не указан']) {
    const items = grouped.get(group) ?? [];
    for (const item of items) rows.push(buildAppendixWasteRow(item));
    rows.push(buildTotalRow(group, items));
  }

  return rows;
}

export function sumHazardTotals(wastes) {
  const totals = { tonnes: 0, pieces: 0 };
  for (const waste of wastes) {
    const numericAmount = parseNumber(waste.amount);
    if (waste.unit === 'шт.') totals.pieces += numericAmount;
    else totals.tonnes += numericAmount;
  }
  return totals;
}

export async function createDocxFromTemplate(templatePath, data, outputPath) {
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  const document = buildDocxDocument(template, data);
  const buffer = await Packer.toBuffer(document);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
  return { path: outputPath, contentType: DOCX_CONTENT_TYPE };
}

function ensureGeneratorState(project, now) {
  project.extractedData = project.extractedData && typeof project.extractedData === 'object' ? project.extractedData : {};
  if (!project.extractedData.code112 || typeof project.extractedData.code112 !== 'object') {
    project.extractedData.code112 = {
      status: 'in_progress',
      startedAt: null,
      updatedAt: now,
      activeDocument: null,
      data: {},
      wastes: [],
      files: Object.fromEntries(
        code112Documents.map((document) => [
          document.key,
          {
            key: document.key,
            label: document.label,
            status: 'pending',
            fileName: document.fileName,
            downloadUrl: null,
            generatedAt: null,
          },
        ])
      ),
    };
  }
  return project.extractedData.code112;
}

function mergeCollectedData(project, state, userSources) {
  const uploadedText = (Array.isArray(project.extractedData.uploads) ? project.extractedData.uploads : [])
    .map((upload) => upload.text)
    .filter((text) => typeof text === 'string')
    .join('\n');
  const manualText = typeof userSources.answer === 'string' ? userSources.answer : '';
  const parsed = parseManualInput(`${uploadedText}\n${manualText}`);
  state.data = {
    ...extractFieldsFromSources(uploadedText),
    ...state.data,
    ...parsed.fields,
  };
  state.wastes = mergeWastes(state.wastes, [...parseWasteRows(uploadedText), ...parsed.wastes]);
}

function buildStartMessage(state) {
  return [
    'Вы выбрали создание пакета документов для акта инвентаризации (код 112).',
    'Цэпик будет вести работу по пяти файлам и сохранять прогресс проекта.',
    buildProgressMessage(state),
  ].join('\n');
}

function buildProgressMessage(state) {
  return code112Documents
    .map((document) => `• ${document.label}: ${statusLabel(state.files[document.key]?.status)}`)
    .join('\n');
}

function buildDocumentQuestion(document, state) {
  const missing = document.requiredFields.filter((field) => !hasField(state, field));
  const missingText = missing.length ? `Не хватает данных: ${missing.join(', ')}.` : 'Данные найдены в источниках или уже введены.';
  return [
    `Начинаю файл «${document.label}».`,
    missingText,
    'Отправьте данные строками вида «Поле: значение», загрузите файл-источник или нажмите «Создать черновик».',
  ].join('\n');
}

async function finishActiveDocument(project, state, answer, outputDir, now) {
  const document = documentByKey.get(state.activeDocument);
  if (!document) {
    state.activeDocument = null;
    askUser(project, 'Не удалось определить текущий файл. К чему теперь приступить?', menuOptions(), now);
    return project;
  }

  if (normalizeAnswer(answer) === 'cancel') {
    state.files[document.key].status = 'pending';
    state.activeDocument = null;
    project.updatedAt = now;
    askUser(project, 'Работа над файлом отменена. К чему теперь приступить?', menuOptions(), now);
    return project;
  }

  await generateDocuments(project, state, [document], outputDir, now);
  state.activeDocument = null;
  askUser(project, `Файл «${document.label}» готов. К чему теперь приступить?`, menuOptions(), now);
  return project;
}

async function generateDocuments(project, state, documents, outputDir, now) {
  const data = buildTemplateData(project, state);
  const projectDir = outputDirectoryForProject(outputDir, project, data);

  for (const document of documents) {
    const outputPath = path.join(projectDir, document.fileName);
    await createDocxFromTemplate(path.join(TEMPLATE_DIR, document.template), data, outputPath);
    state.files[document.key] = {
      ...state.files[document.key],
      status: 'ready',
      fileName: document.fileName,
      path: outputPath,
      downloadUrl: `/api/agent/files/${encodeURIComponent(project.id)}/${encodeURIComponent(document.fileName)}`,
      generatedAt: now,
    };
  }

  state.status = Object.values(state.files).every((file) => file.status === 'ready') ? 'ready' : 'in_progress';
  state.updatedAt = now;
  project.updatedAt = now;
  addAgentMessage(project, buildGeneratedFilesMessage(documents, state), now);
}

function buildGeneratedFilesMessage(documents, state) {
  const links = documents.map((document) => {
    const file = state.files[document.key];
    return `• ${document.label}: [скачать DOCX](${file.downloadUrl})`;
  });
  return ['Готово. Сформированы файлы:', ...links].join('\n');
}

function buildSourceSavedMessage(parsedAnswer, directWasteRows) {
  const fieldsCount = Object.keys(parsedAnswer.fields).length;
  const wastesCount = parsedAnswer.wastes.length + directWasteRows.length;
  const parts = [];
  if (fieldsCount) parts.push(`полей: ${fieldsCount}`);
  if (wastesCount) parts.push(`строк отходов: ${wastesCount}`);
  return `Данные сохранены для акта инвентаризации (${parts.join(', ')}).`;
}

function applyOrganizationMemory(state, memory, answer) {
  if (!memory) return '';

  const organization = findOrganization(memory, answer);
  if (!organization) return '';

  const applied = [];
  state.data.Название_организации = state.data.Название_организации || organization.name;
  if (organization.address && !state.data.Юридический_адрес) {
    state.data.Юридический_адрес = organization.address;
    applied.push('адрес');
  }
  if (organization.director && !state.data.Инициалы_фамилия_руководителя) {
    state.data.Инициалы_фамилия_руководителя = organization.director;
    applied.push('руководитель');
  }
  if (organization.okved && !state.data.ОКВЭД) {
    state.data.ОКВЭД = organization.okved;
    applied.push('ОКВЭД');
  }
  if (organization.typicalWastes.length && !state.data.Типовые_отходы) {
    state.data.Типовые_отходы = organization.typicalWastes.join('; ');
    applied.push('типовые отходы');
  }

  return applied.length
    ? `Нашёл в памяти организацию «${organization.name}» и применил сохранённые данные: ${applied.join(', ')}.`
    : `Нашёл в памяти организацию «${organization.name}». Сохранённые данные уже учтены в проекте.`;
}

function buildTemplateData(project, state) {
  const commissionData = resolveCommissionData(state.data);
  const data = {
    organizationName: state.data.Название_организации ?? 'Название организации не указано',
    projectName: project.packageTitle ?? 'Акт инвентаризации',
    managerPosition: state.data.Должность_руководителя ?? 'Должность руководителя не указана',
    managerName: state.data.Инициалы_фамилия_руководителя ?? 'И.О. Фамилия',
    legalAddress: state.data.Юридический_адрес ?? 'Юридический адрес не указан',
    actDate: state.data.Дата_акта ?? new Date().toLocaleDateString('ru-RU'),
    startDate: state.data.Дата_начала ?? new Date().toLocaleDateString('ru-RU'),
    chairPosition: commissionData.chairPosition,
    chairName: commissionData.chairName,
    commission: commissionData.members,
    wastes: state.wastes.length ? state.wastes : defaultWastes(),
  };
  data.appendixRows = buildAppendixRows(data.wastes);
  return data;
}

function outputDirectoryForProject(outputDir, project, data) {
  return path.join(outputDir, slugify(data.organizationName), project.id);
}

function askUser(project, question, options, now) {
  const optionText = options.length ? `\n\nВарианты:\n${options.map((option) => `• ${option.label}`).join('\n')}` : '';
  addAgentMessage(project, `${question}${optionText}`, now);
}

function menuOptions() {
  return [
    ...code112Documents.map((document) => ({ key: document.key, label: document.label })),
    { key: 'generateAll', label: 'Сгенерировать все' },
    { key: 'pause', label: 'Остановиться и продолжить позже' },
  ];
}

function documentWorkOptions() {
  return [
    { key: 'createDraft', label: 'Создать черновик' },
    { key: 'cancel', label: 'Отмена' },
    { key: 'pause', label: 'Остановиться и продолжить позже' },
  ];
}

function findDocument(answer) {
  return documentByKey.get(answer) ?? documentByLabel.get(normalizeAnswer(answer));
}

function isStopAnswer(answer) {
  const normalized = normalizeAnswer(answer);
  return normalized === 'pause' || normalized === normalizeAnswer('Остановиться и продолжить позже') || normalized === normalizeAnswer('стоп');
}

function normalizeAnswer(value) {
  return String(value).trim().toLocaleLowerCase('ru-RU');
}

function statusLabel(status) {
  if (status === 'ready') return 'готов';
  if (status === 'in_progress') return 'в работе';
  return 'ожидает';
}

function hasField(state, field) {
  if (field === 'Отходы') return state.wastes.length > 0;
  if (field === 'Количество_кг') return state.wastes.some((waste) => parseNumber(waste.amountKg) > 0 || parseNumber(waste.amount) > 0);
  if (field === 'Источники_образования') return state.wastes.some((waste) => waste.source);
  return Boolean(state.data[field]);
}

function extractFieldsFromSources(text) {
  const fields = {};
  const organizationMatch = text.match(/(?:организац(?:ия|ии)|общество|ооо|зао|оао)[:\s]+([^\n]+)/i);
  if (organizationMatch) fields.Название_организации = organizationMatch[1].trim();
  const addressMatch = text.match(/(?:юридический адрес|адрес)[:\s]+([^\n]+)/i);
  if (addressMatch) fields.Юридический_адрес = addressMatch[1].trim();
  return fields;
}

function mergeWastes(existing, incoming) {
  const byCodeName = new Map();
  for (const waste of [...existing, ...incoming]) {
    byCodeName.set(`${waste.code}:${normalizeAnswer(waste.name)}`, waste);
  }
  return [...byCodeName.values()];
}

function normalizeWasteRow(row) {
  const mercuryUnit = isMercuryWaste(row.code, row.name);
  const unit = mercuryUnit ? 'шт.' : normalizeUnit(row.unit);
  const amount = row.code === '9120400' && !row.amount ? '0,054' : row.amount;
  return {
    code: row.code,
    name: row.name || 'Наименование отхода не указано',
    hazardClass: normalizeHazardClass(row.hazardClass),
    amount,
    amountKg: normalizeAmountKg(amount, unit),
    unit,
    handling: row.handling || '',
    source: row.source || '',
    physicalState: row.physicalState || 'не указано',
  };
}

function normalizeHazardClass(value) {
  const match = String(value).match(/[1-4]/);
  return match ? match[0] : 'не указан';
}

function normalizeUnit(value) {
  const normalized = String(value).trim().toLocaleLowerCase('ru-RU');
  if (normalized.includes('шт')) return 'шт.';
  if (normalized.includes('кг')) return 'кг';
  return 'т';
}

function normalizeAmountKg(amount, unit) {
  const number = parseNumber(amount);
  if (unit === 'кг') return number;
  if (unit === 'т') return number * 1000;
  return 0;
}

function isMercuryWaste(code, name) {
  return /термометр|люминесцент|ртут|дифманометр|игнитрон/i.test(`${code} ${name}`);
}

function groupWastesByHazard(wastes) {
  const grouped = new Map();
  for (const waste of wastes) {
    const key = normalizeHazardClass(waste.hazardClass);
    grouped.set(key, [...(grouped.get(key) ?? []), waste]);
  }
  return grouped;
}

function buildAppendixWasteRow(waste) {
  const row = [waste.code, waste.name, DASH, formatAmount(waste), DASH, DASH, DASH, DASH, DASH, DASH];
  const handlingColumn = handlingToColumn(waste.handling);
  if (handlingColumn) {
    row[handlingColumn - 1] = row[3];
  }
  if (waste.code === '9120400' && row[2] === DASH) row[2] = '0,054 т / на 1 сотрудника в год';
  return { type: 'waste', cells: row };
}

function buildTotalRow(group, wastes) {
  const totals = sumHazardTotals(wastes);
  const totalText = formatTotals(totals);
  return {
    type: 'total',
    cells: [`Итого отходов ${group} класса опасности`, '', totalText || DASH, totalText || DASH, DASH, DASH, DASH, DASH, DASH, DASH],
  };
}

function handlingToColumn(value) {
  const text = normalizeAnswer(value);
  if (text.includes('заготов')) return 5;
  if (text.includes('сортиров')) return 6;
  if (text.includes('использ')) return 7;
  if (text.includes('обезвреж')) return 8;
  if (text.includes('захорон')) return 9;
  if (text.includes('долговремен')) return 10;
  return null;
}

function formatAmount(waste) {
  const amount = waste.amount || '';
  if (!amount) return DASH;
  return waste.unit === 'шт.' ? `${amount} шт.` : amount;
}

function formatTotals(totals) {
  const values = [];
  if (totals.pieces) values.push(`${formatNumber(totals.pieces)} шт.`);
  if (totals.tonnes) values.push(formatNumber(totals.tonnes));
  return values.join(' ');
}

function parseNumber(value) {
  const normalized = String(value ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return normalized ? Number(normalized[0]) : 0;
}

function formatNumber(value) {
  return Number(value.toFixed(3)).toString().replace('.', ',');
}

export function parseCommission(value) {
  if (!value) {
    return [
      { position: 'Член комиссии', name: 'И.О. Фамилия' },
      { position: 'Член комиссии', name: 'И.О. Фамилия' },
    ];
  }
  return String(value)
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseCommissionMember);
}

function parseCommissionMember(item) {
  const dashParts = item.split(/[-—]/).map((part) => part.trim()).filter(Boolean);
  if (dashParts.length >= 2) return { position: dashParts[0], name: dashParts.slice(1).join(' — ') };

  const words = item.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return { position: words[0], name: words.slice(1).join(' ') };

  return { position: item, name: 'И.О. Фамилия' };
}

function resolveCommissionData(fields) {
  const parsedMembers = parseCommission(fields.Комиссия);
  const chairIndex = fields.Должность_председателя || fields.Инициалы_фамилия_председателя
    ? -1
    : parsedMembers.findIndex((member) => normalizeAnswer(member.position).includes('председател'));
  const chairMember = chairIndex >= 0 ? parsedMembers[chairIndex] : null;
  const members = parsedMembers.filter((_, index) => index !== chairIndex);

  return {
    chairPosition: fields.Должность_председателя ?? chairMember?.position ?? 'Председатель комиссии',
    chairName: fields.Инициалы_фамилия_председателя ?? chairMember?.name ?? 'И.О. Фамилия',
    members: members.length ? members : parseCommission('Член комиссии - И.О. Фамилия\nЧлен комиссии - И.О. Фамилия'),
  };
}

function defaultWastes() {
  return [
    normalizeWasteRow({
      code: '9120400',
      name: 'Отходы производства, подобные отходам жизнедеятельности населения',
      hazardClass: 'не указан',
      amount: '0,054',
      unit: 'т',
      handling: 'захоронение',
      source: 'Административная деятельность',
      physicalState: 'смешанное',
    }),
  ];
}

function buildDocxDocument(template, data) {
  return new Document({
    sections: [
      {
        properties: {},
        children: buildTemplateChildren(template, data),
      },
    ],
  });
}

function buildTemplateChildren(template, data) {
  if (template.key === 'titleAct') return buildTitleAct(data);
  if (template.key === 'appendix') return buildAppendix(data);
  if (template.key === 'sources') return buildSources(data);
  if (template.key === 'wasteFormation') return buildWasteFormation(data);
  if (template.key === 'measures') return buildMeasures(data);
  return [heading(template.title), paragraph('Шаблон документа не настроен.')];
}

function buildTitleAct(data) {
  return [
    heading('АКТ ИНВЕНТАРИЗАЦИИ ОТХОДОВ ПРОИЗВОДСТВА'),
    paragraph(`Организация: ${data.organizationName}`, AlignmentType.CENTER),
    paragraph(`Юридический адрес: ${data.legalAddress}`, AlignmentType.CENTER),
    paragraph(`Дата акта: ${data.actDate}`),
    paragraph(`Дата начала инвентаризации: ${data.startDate}`),
    paragraph(`УТВЕРЖДАЮ: ${data.managerPosition} ${data.managerName}`),
    paragraph('Комиссия:'),
    table([
      ['Роль', 'Должность', 'Инициалы, фамилия'],
      ['Председатель', data.chairPosition, data.chairName],
      ...data.commission.map((member) => ['Член комиссии', member.position, member.name]),
    ]),
  ];
}

function buildAppendix(data) {
  return [
    heading('ПРИЛОЖЕНИЕ К АКТУ ИНВЕНТАРИЗАЦИИ'),
    paragraph(`Организация: ${data.organizationName}`),
    paragraph(`Дата акта: ${data.actDate}`),
    table([
      ['Код отхода', 'Наименование отхода', 'Колонка 3', 'Колонка 4', '5', '6', '7', '8', '9', '10'],
      ...data.appendixRows.map((row) => row.cells),
    ], { small: true, totalRows: data.appendixRows.map((row, index) => (row.type === 'total' ? index + 1 : -1)) }),
  ];
}

function buildSources(data) {
  const rows = data.wastes.map((waste, index) => [
    String(index + 1),
    waste.source || 'Источник не указан',
    waste.source || 'Участок не указан',
    waste.code,
    waste.name,
    waste.unit === 'шт.' ? formatAmount(waste) : `${formatNumber(parseNumber(waste.amountKg))} кг`,
  ]);
  return [
    heading('ИСТОЧНИКИ ОБРАЗОВАНИЯ ОТХОДОВ ПРОИЗВОДСТВА'),
    paragraph(`Организация: ${data.organizationName}`),
    table([['№ п/п', 'Источник образования', 'Участок', 'Код отхода', 'Наименование отхода', 'Количество'], ...rows], { small: true }),
  ];
}

function buildWasteFormation(data) {
  const rows = data.wastes.map((waste) => [
    waste.code,
    waste.name,
    waste.physicalState,
    waste.hazardClass,
    waste.unit === 'шт.' ? formatAmount(waste) : formatNumber(parseNumber(waste.amountKg)),
    waste.unit === 'шт.' ? DASH : formatNumber(parseNumber(waste.amountKg) / 1000),
  ]);
  return [
    heading('СВЕДЕНИЯ О КОЛИЧЕСТВЕ ОБРАЗУЮЩИХСЯ ОТХОДОВ'),
    paragraph(`Организация: ${data.organizationName}`),
    table([['Код', 'Наименование', 'Физическое состояние', 'Класс опасности', 'кг', 'т'], ...rows], { small: true }),
  ];
}

function buildMeasures(data) {
  return [
    heading('ПЕРЕЧЕНЬ МЕРОПРИЯТИЙ'),
    paragraph(`Организация: ${data.organizationName}`),
    paragraph(`Председатель комиссии: ${data.chairPosition} ${data.chairName}`),
    paragraph('Перечень мероприятий по обращению с отходами производства сформирован по результатам инвентаризации.'),
    table([
      ['№', 'Мероприятие', 'Ответственный', 'Срок выполнения'],
      ['1', 'Проверить места временного хранения отходов', `${data.chairPosition} ${data.chairName}`, 'постоянно'],
      ['2', 'Обеспечить раздельный сбор отходов по видам', `${data.chairPosition} ${data.chairName}`, 'постоянно'],
      ['3', 'Актуализировать договоры на передачу отходов', `${data.chairPosition} ${data.chairName}`, 'ежегодно'],
    ]),
  ];
}

function heading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text, font: FONT, size: 24, bold: true })],
    spacing: { after: 240 },
  });
}

function paragraph(text, alignment = AlignmentType.LEFT) {
  return new Paragraph({
    alignment,
    children: [new TextRun({ text, font: FONT, size: 24 })],
    spacing: { after: 120 },
  });
}

function table(rows, options = {}) {
  const totalRows = new Set(options.totalRows ?? []);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((row, rowIndex) =>
      new TableRow({
        children: row.map((cell, cellIndex) =>
          new TableCell({
            columnSpan: totalRows.has(rowIndex) && cellIndex === 0 ? 2 : undefined,
            children: [tableParagraph(cell, options.small)],
            verticalAlign: VerticalAlign.CENTER,
            width: { size: Math.floor(100 / row.length), type: WidthType.PERCENTAGE },
          })
        ).filter((_, cellIndex) => !(totalRows.has(rowIndex) && cellIndex === 1)),
      })
    ),
  });
}

function tableParagraph(text, small = false) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: String(text), font: FONT, size: small ? 20 : 24 })],
  });
}

function slugify(value) {
  const slug = String(value)
    .toLocaleLowerCase('ru-RU')
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'organization';
}

function addAgentMessage(project, text, now) {
  project.history.push({
    id: `agent-${project.history.length + 1}`,
    role: 'agent',
    text,
    createdAt: now,
  });
}

function addUserMessage(project, text, now) {
  project.history.push({
    id: `user-${project.history.length + 1}`,
    role: 'user',
    text,
    createdAt: now,
  });
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import JSZip from 'jszip';
import { buildMemorySystemPrompt, findOrganization, readUserMemory } from '../memory.js';
import { parseDateToFormat, processRepeatingBlocks, replaceDocxPlaceholders, replaceXmlPlaceholders } from '../../utils/docxHelpers.js';

export const code112FallbackMessage =
  'Извините, я пока не умею обрабатывать выбранный вами тип документации. Эта функция находится в разработке. Пожалуйста, выберите другой раздел или обратитесь к администратору.';

const FONT = 'Times New Roman';
const DASH = '−';
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'agent-docs');
const DEFAULT_MEMORY_PATH = path.join(PROJECT_ROOT, 'data', 'user_memory.json');
const DEFAULT_DATE_FORMAT = 'DD.MM.YYYY';
const TEMPLATE_DIR = path.join(PROJECT_ROOT, 'templates', 'docx', 'inventory_act');

export const code112Documents = [
  {
    key: 'titleAct',
    label: 'Титул акта инвентаризации',
    fileName: '01-titul-akta-inventarizatsii.docx',
    template: 'title_page_template.docx',
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
    template: 'appendix_template.docx',
    requiredFields: ['Дата_акта', 'Название_организации', 'Отходы'],
  },
  {
    key: 'sources',
    label: 'Источники образования отходов производства',
    fileName: '03-istochniki-obrazovaniya-otkhodov.docx',
    template: 'sources_template.docx',
    requiredFields: ['Название_организации', 'Отходы', 'Источники_образования'],
  },
  {
    key: 'wasteFormation',
    label: 'Сведения о количестве образующихся отходов',
    fileName: '04-obrazovanie-otkhodov.docx',
    template: 'waste_generation_template.docx',
    requiredFields: ['Отходы', 'Количество_кг'],
  },
  {
    key: 'measures',
    label: 'Перечень мероприятий',
    fileName: '05-perechen-meropriyatiy.docx',
    template: 'measures_template.docx',
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
  const memory = await resolveCode112Memory(userSources);
  const memoryMessages = applyMemoryDefaults(projectData, state, memory);

  mergeCollectedData(projectData, state, userSources);

  if (!state.startedAt) {
    state.startedAt = now;
    addAgentMessage(projectData, buildStartMessage(state), now);
    for (const message of memoryMessages) addAgentMessage(projectData, message, now);
    askUser(projectData, 'С чего хотите начать?', menuOptions(), now);
    return projectData;
  }

  if (!answer) {
    askUser(projectData, buildProgressMessage(state), menuOptions(), now);
    return projectData;
  }

  addUserMessage(projectData, answer, now);

  const organizationConfirmation = handleOrganizationConfirmation(projectData, state, answer, memory, now);
  if (organizationConfirmation) return organizationConfirmation;

  const organizationQuestion = state.activeDocument ? prepareOrganizationMemoryConfirmation(state, memory, answer) : '';
  if (organizationQuestion) {
    askUser(projectData, organizationQuestion, confirmationOptions(), now);
    return projectData;
  }

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
    const memoryQuestion = prepareOrganizationMemoryConfirmation(state, memory, answer);
    if (memoryQuestion) {
      askUser(projectData, memoryQuestion, confirmationOptions(), now);
    } else {
      askUser(projectData, 'К чему теперь приступить?', menuOptions(), now);
    }
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
  if (state.memory?.pendingOrganization) return confirmationOptions();
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
  if (templatePath.endsWith('.docx')) {
    let buffer = await readFile(templatePath);
    buffer = await applyInventoryDocxTemplate(buffer, path.basename(templatePath), data);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, buffer);
    return { path: outputPath, contentType: DOCX_CONTENT_TYPE };
  }

  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  const document = buildDocxDocument(template, data);
  let buffer = await Packer.toBuffer(document);
  buffer = await applyTemplateRepeatingBlocks(buffer, template, data);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
  return { path: outputPath, contentType: DOCX_CONTENT_TYPE };
}

async function applyInventoryDocxTemplate(buffer, templateName, data) {
  let processed = buffer;
  if (templateName === 'title_page_template.docx') {
    processed = await processRepeatingBlocks(processed, '[должность_члена_комиссии]', titleCommissionRows(data), {
      blockType: 'tableRow',
      followingBlocks: 1,
      removePlaceholder: false,
    });
  } else if (templateName === 'appendix_template.docx') {
    processed = await processAppendixTemplateRows(processed, data);
  } else if (templateName === 'sources_template.docx') {
    processed = await processRepeatingBlocks(processed, '[номер_источника]', sourceRows(data), {
      blockType: 'tableRow',
      removePlaceholder: false,
    });
  } else if (templateName === 'waste_generation_template.docx') {
    processed = await processRepeatingBlocks(processed, '[код]', wasteGenerationRows(data), {
      blockType: 'tableRow',
      removePlaceholder: false,
    });
  }

  return replaceDocxPlaceholders(processed, templateVariables(data));
}

async function processAppendixTemplateRows(buffer, data) {
  const zip = await JSZip.loadAsync(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX XML not found: word/document.xml');

  const xml = await documentFile.async('string');
  const rows = [...xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((match, index) => ({
    text: match[0],
    index: match.index,
    rowIndex: index,
    visibleText: extractDocxText(match[0]),
  }));
  const wasteRows = rows.filter((row) => row.visibleText.includes('[код]') && row.visibleText.includes('[кол_заготовка]'));
  if (!wasteRows.length) return buffer;

  const sections = wasteRows
    .map((wasteRow) => {
      const totalRow = rows[wasteRow.rowIndex + 1];
      if (!totalRow?.visibleText.includes('Итого')) return null;
      return {
        group: appendixGroupFromLabel(totalRow.visibleText),
        wasteTemplate: wasteRow.text,
        totalTemplate: totalRow.text,
        start: wasteRow.index,
        end: totalRow.index + totalRow.text.length,
      };
    })
    .filter(Boolean);
  if (!sections.length) return buffer;

  const grouped = groupWastesByHazard(data.wastes);
  const rendered = sections
    .map((section) => {
      const wastes = grouped.get(section.group) ?? [];
      const wasteRowsXml = wastes
        .map((waste) => replaceXmlPlaceholders(section.wasteTemplate, appendixWasteVariables(waste)))
        .join('');
      const totalRowXml = replaceXmlPlaceholders(section.totalTemplate, appendixTotalVariables(wastes));
      return `${wasteRowsXml}${totalRowXml}`;
    })
    .join('');

  const first = sections[0];
  const last = sections.at(-1);
  zip.file('word/document.xml', `${xml.slice(0, first.start)}${rendered}${xml.slice(last.end)}`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function templateVariables(data) {
  return {
    название_организации: data.organizationName,
    должность_руководителя: data.managerPosition,
    инициалы_фамилия_руководителя: data.managerName,
    юридический_адрес: data.legalAddress,
    дата_акта: data.actDate,
    дата_начала: data.startDate,
    должность_председателя: data.chairPosition,
    инициалы_фамилия_председателя: data.chairName,
  };
}

function titleCommissionRows(data) {
  return data.commission.map((member) => ({
    должность_члена_комиссии: member.position,
    инициалы_фамилия_члена_комиссии: member.name,
    дата_акта: data.actDate,
  }));
}

function sourceRows(data) {
  return data.wastes.map((waste, index) => ({
    номер_источника: String(index + 1),
    источник: waste.source || 'Источник не указан',
    участок: waste.source || 'Участок не указан',
    код: waste.code,
    отход: waste.name,
    количество_кг_шт: waste.unit === 'шт.' ? `${waste.amount || DASH} шт.` : `${formatNumber(parseNumber(waste.amountKg))} кг`,
  }));
}

function wasteGenerationRows(data) {
  return data.wastes.map((waste) => ({
    код: waste.code,
    отход: waste.name,
    источник: waste.source || 'Источник не указан',
    'кол-во_участков': '1',
    количество_т_шт: waste.unit === 'шт.' ? `${waste.amount || DASH} шт.` : formatAmount(waste),
    количество: waste.unit === 'шт.' ? waste.amount || DASH : formatNumber(parseNumber(waste.amountKg)),
    норматив: waste.code === '9120400' ? '0,054 т / на 1 сотрудника в год' : DASH,
    физ_сост: waste.physicalState || 'не указано',
    состав: waste.composition || DASH,
    'состав_%': waste.compositionPercent || DASH,
    свойства: waste.properties || DASH,
    класс: waste.hazardClass || 'не указан',
  }));
}

function appendixWasteVariables(waste) {
  const values = {
    код: waste.code,
    отход: waste.name,
    норматив: waste.code === '9120400' ? '0,054 т / на 1 сотрудника в год' : DASH,
    количество: formatAmount(waste),
    кол_заготовка: DASH,
    кол_сортировка: DASH,
    кол_использование: DASH,
    кол_обезвреживание: DASH,
    кол_хранение: DASH,
    кол_захоронение: DASH,
  };
  const key = handlingToAppendixKey(waste.handling);
  if (key) values[key] = values.количество;
  return values;
}

function appendixTotalVariables(wastes) {
  const columnTotals = {
    сумма_кол4: createAmountTotal(),
    сумма_кол5: createAmountTotal(),
    сумма_кол6: createAmountTotal(),
    сумма_кол7: createAmountTotal(),
    сумма_кол8: createAmountTotal(),
    сумма_кол9: createAmountTotal(),
    сумма_кол10: createAmountTotal(),
  };

  for (const waste of wastes) {
    addWasteAmountToTotal(columnTotals.сумма_кол4, waste);
    const handlingKey = handlingToAppendixKey(waste.handling);
    const totalKey = handlingKey ? appendixTotalKey(handlingKey) : '';
    if (totalKey) addWasteAmountToTotal(columnTotals[totalKey], waste);
  }

  return Object.fromEntries(
    Object.entries(columnTotals).map(([key, value]) => [key, formatTotals(value) || DASH])
  );
}

function appendixGroupFromLabel(label) {
  const normalized = normalizeAnswer(label);
  if (normalized.includes('1 класса')) return '1';
  if (normalized.includes('2 класса')) return '2';
  if (normalized.includes('3 класса')) return '3';
  if (normalized.includes('4 класса')) return '4';
  if (normalized.includes('неопас')) return 'неопасные';
  return 'не указан';
}

function createAmountTotal() {
  return { tonnes: 0, pieces: 0 };
}

function addWasteAmountToTotal(total, waste) {
  if (waste.unit === 'шт.') {
    total.pieces += parseNumber(waste.amount);
  } else {
    total.tonnes += waste.unit === 'кг' ? parseNumber(waste.amount) / 1000 : parseNumber(waste.amount);
  }
}

function handlingToAppendixKey(value) {
  const text = normalizeAnswer(value);
  if (text.includes('заготов')) return 'кол_заготовка';
  if (text.includes('сортиров')) return 'кол_сортировка';
  if (text.includes('использ')) return 'кол_использование';
  if (text.includes('обезвреж')) return 'кол_обезвреживание';
  if (text.includes('хран') || text.includes('долговремен')) return 'кол_хранение';
  if (text.includes('захорон')) return 'кол_захоронение';
  return '';
}

function appendixTotalKey(handlingKey) {
  return {
    кол_заготовка: 'сумма_кол5',
    кол_сортировка: 'сумма_кол6',
    кол_использование: 'сумма_кол7',
    кол_обезвреживание: 'сумма_кол8',
    кол_хранение: 'сумма_кол9',
    кол_захоронение: 'сумма_кол10',
  }[handlingKey];
}

function extractDocxText(xml) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) =>
      match[1]
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&amp;', '&')
    )
    .join('');
}

async function applyTemplateRepeatingBlocks(buffer, template, data) {
  if (!Array.isArray(template.repeatingBlocks)) return buffer;
  let processed = buffer;
  for (const block of template.repeatingBlocks) {
    if (!block || typeof block.placeholder !== 'string') continue;
    processed = await processRepeatingBlocks(processed, block.placeholder, readTemplateDataArray(data, block.dataPath), block.options ?? {});
  }
  return processed;
}

function readTemplateDataArray(data, dataPath) {
  const value = String(dataPath ?? '')
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), data);
  return Array.isArray(value) ? value : [];
}

async function resolveCode112Memory(userSources) {
  if (userSources.memory !== undefined) return userSources.memory;
  const memoryPath = userSources.memoryPath ?? process.env.USER_MEMORY_PATH ?? (userSources.loadDefaultMemory ? DEFAULT_MEMORY_PATH : '');
  if (!memoryPath) return null;
  return readUserMemory(memoryPath);
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
      memory: {
        dateFormat: DEFAULT_DATE_FORMAT,
        pendingOrganization: null,
        appliedOrganizations: [],
        skippedOrganizations: [],
        defaultMembersApplied: false,
        savedInstructions: [],
        geminiSystemPrompt: '',
      },
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

function ensureMemoryState(state) {
  state.memory = state.memory && typeof state.memory === 'object' ? state.memory : {};
  state.memory.dateFormat = normalizeCode112DateFormat(state.memory.dateFormat);
  state.memory.pendingOrganization = state.memory.pendingOrganization ?? null;
  state.memory.appliedOrganizations = Array.isArray(state.memory.appliedOrganizations) ? state.memory.appliedOrganizations : [];
  state.memory.skippedOrganizations = Array.isArray(state.memory.skippedOrganizations) ? state.memory.skippedOrganizations : [];
  state.memory.defaultMembersApplied = Boolean(state.memory.defaultMembersApplied);
  state.memory.savedInstructions = Array.isArray(state.memory.savedInstructions) ? state.memory.savedInstructions : [];
  state.memory.geminiSystemPrompt = typeof state.memory.geminiSystemPrompt === 'string' ? state.memory.geminiSystemPrompt : '';
}

function normalizeCode112DateFormat(format) {
  return format ? String(format) : DEFAULT_DATE_FORMAT;
}

function normalizeDefaultMembers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((member) => {
      if (typeof member === 'string') return parseCommissionMember(member);
      if (member && typeof member === 'object') {
        return {
          position: String(member.position ?? member.должность ?? member.role ?? 'Член комиссии').trim(),
          name: String(member.name ?? member.фио ?? member.fullName ?? 'И.О. Фамилия').trim(),
        };
      }
      return null;
    })
    .filter(Boolean);
}

function applyMemoryDefaults(project, state, memory) {
  ensureMemoryState(state);
  if (!memory) return [];

  const messages = [];
  const preferences = memory.userPreferences && typeof memory.userPreferences === 'object' ? memory.userPreferences : {};
  state.memory.dateFormat = normalizeCode112DateFormat(preferences.dateFormat);
  state.memory.savedInstructions = Array.isArray(memory.savedInstructions)
    ? memory.savedInstructions.map((instruction) => instruction.text).filter(Boolean)
    : [];
  state.memory.geminiSystemPrompt = buildMemorySystemPrompt(memory);
  if (state.memory.geminiSystemPrompt && !String(project.systemPrompt ?? '').includes(state.memory.geminiSystemPrompt)) {
    project.systemPrompt = [project.systemPrompt, state.memory.geminiSystemPrompt].filter(Boolean).join('\n\n');
  }

  const defaultMembers = normalizeDefaultMembers(preferences.defaultMembers);
  if (defaultMembers.length && !state.data.Комиссия && !state.memory.defaultMembersApplied) {
    state.data.Комиссия = defaultMembers.map((member) => `${member.position} - ${member.name}`).join('\n');
    state.memory.defaultMembersApplied = true;
    messages.push(
      [
        'В памяти найдены типовые члены комиссии. Использую их по умолчанию:',
        ...defaultMembers.map((member) => `• ${member.position} — ${member.name}`),
        'Чтобы изменить состав, отправьте «Комиссия: должность - ФИО; должность - ФИО».',
      ].join('\n')
    );
  }

  if (state.memory.savedInstructions.length && !state.memory.instructionsNoticeShown) {
    state.memory.instructionsNoticeShown = true;
    messages.push('Сохранённые инструкции пользователя добавлены в контекст code112 для последующих расчётов и генерации.');
  }

  return messages;
}

function prepareOrganizationMemoryConfirmation(state, memory, answer) {
  if (!memory) return '';
  ensureMemoryState(state);
  if (state.memory.pendingOrganization) return '';

  const organization = findOrganization(memory, answer || state.data.Название_организации || '');
  if (!organization) return '';
  if (state.memory.appliedOrganizations.includes(organization.id) || state.memory.skippedOrganizations.includes(organization.id)) return '';

  state.memory.pendingOrganization = { id: organization.id, name: organization.name };
  return `Найдены сохранённые данные для организации «${organization.name}». Использовать?`;
}

function handleOrganizationConfirmation(project, state, answer, memory, now) {
  ensureMemoryState(state);
  if (!state.memory.pendingOrganization) return null;

  const normalized = normalizeAnswer(answer);
  const pending = state.memory.pendingOrganization;
  if (!isYesAnswer(normalized) && !isNoAnswer(normalized)) {
    askUser(project, `Найдены сохранённые данные для организации «${pending.name}». Использовать?`, confirmationOptions(), now);
    return project;
  }

  const organization = findOrganization(memory, pending.name);
  state.memory.pendingOrganization = null;
  if (!organization) {
    askUser(project, 'Сохранённые данные организации не найдены. К чему теперь приступить?', menuOptions(), now);
    return project;
  }

  if (isNoAnswer(normalized)) {
    state.memory.skippedOrganizations.push(organization.id);
    askUser(project, 'Хорошо, сохранённые данные организации не использую. К чему теперь приступить?', menuOptions(), now);
    return project;
  }

  const applied = applyOrganizationToState(state, organization);
  state.memory.appliedOrganizations.push(organization.id);
  addAgentMessage(
    project,
    applied.length
      ? `Применил сохранённые данные организации «${organization.name}»: ${applied.join(', ')}.`
      : `Сохранённые данные организации «${organization.name}» уже были заполнены в проекте.`,
    now
  );
  askUser(project, 'К чему теперь приступить?', menuOptions(), now);
  project.updatedAt = now;
  return project;
}

function applyOrganizationToState(state, organization) {
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
  if (organization.typicalWastes?.length && !state.data.Типовые_отходы) {
    state.data.Типовые_отходы = organization.typicalWastes.join('; ');
    const parsedWastes = parseWasteRows(organization.typicalWastes.join('\n'));
    if (parsedWastes.length) state.wastes = mergeWastes(state.wastes, parsedWastes);
    applied.push('типовые отходы');
  }
  return applied;
}

function buildTemplateData(project, state) {
  const commissionData = resolveCommissionData(state.data);
  const dateFormat = state.memory?.dateFormat ?? DEFAULT_DATE_FORMAT;
  const data = {
    organizationName: state.data.Название_организации ?? 'Название организации не указано',
    projectName: project.packageTitle ?? 'Акт инвентаризации',
    managerPosition: state.data.Должность_руководителя ?? 'Должность руководителя не указана',
    managerName: state.data.Инициалы_фамилия_руководителя ?? 'И.О. Фамилия',
    legalAddress: state.data.Юридический_адрес ?? 'Юридический адрес не указан',
    actDate: parseDateToFormat(state.data.Дата_акта ?? new Date(), dateFormat),
    startDate: parseDateToFormat(state.data.Дата_начала ?? new Date(), dateFormat),
    chairPosition: commissionData.chairPosition,
    chairName: commissionData.chairName,
    commission: commissionData.members,
    wastes: state.wastes.length ? state.wastes : defaultWastes(),
    savedInstructions: state.memory?.savedInstructions ?? [],
    geminiSystemPrompt: state.memory?.geminiSystemPrompt ?? '',
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

function confirmationOptions() {
  return [
    { key: 'yes', label: 'Да' },
    { key: 'no', label: 'Нет' },
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

function isYesAnswer(normalizedAnswer) {
  return ['yes', 'да', 'использовать', 'ок', 'хорошо'].includes(normalizedAnswer);
}

function isNoAnswer(normalizedAnswer) {
  return ['no', 'нет', 'не использовать'].includes(normalizedAnswer);
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
  const text = String(value).toLocaleLowerCase('ru-RU');
  if (text.includes('неопас')) return 'неопасные';
  const match = text.match(/[1-4]/);
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
  if (text.includes('хран') || text.includes('долговремен')) return 9;
  if (text.includes('захорон')) return 10;
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

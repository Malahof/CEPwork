import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PDFParse } from 'pdf-parse';
import { buildMemorySystemPrompt, findOrganization, readUserMemory } from '../memory.js';
import { defaultDocsSnapshot, ensureDefaultDocsStructure } from '../../defaultDocs.js';
import { parseDateToFormat, processRepeatingBlocks, replaceDocxPlaceholders, replaceXmlPlaceholders } from '../../utils/docxHelpers.js';
import { refreshDisposalReferences, resolveDisposalMethod } from '../disposalResolver.js';
import {
  WASTE_EXTRACTION_MODES,
  extractWasteDataFromText,
  normalizeWasteExtractionMode,
  wasteExtractionModeOptions,
} from '../wasteDataExtractor.js';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';

export const code112FallbackMessage =
  'Извините, я пока не умею обрабатывать выбранный вами тип документации. Эта функция находится в разработке. Пожалуйста, выберите другой раздел или обратитесь к администратору.';

const DASH = '−';
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'agent-docs');
const DEFAULT_DOCS_PATH = path.join(PROJECT_ROOT, 'data', 'docs.json');
const DEFAULT_MEMORY_PATH = path.join(PROJECT_ROOT, 'data', 'user_memory.json');
const DEFAULT_DATE_FORMAT = 'DD.MM.YYYY';
const TEMPLATE_DIR = path.join(PROJECT_ROOT, 'templates', 'docx', 'inventory_act');
const CLASSIFIER_URL = 'https://www.ecoinfo.by/wp-content/uploads/2020/01/%D0%BA%D0%BB%D0%B0%D1%81%D1%81%D0%B8%D1%84%D0%B8%D0%BA%D0%B0%D1%82%D0%BE%D1%80-3%D0%A2.pdf';
const CLASSIFIER_PATH = path.join(PROJECT_ROOT, 'data', 'references', 'klassifikator-3T.pdf');
const CLASSIFIER_TEXT_PATH = path.join(PROJECT_ROOT, 'data', 'references', 'klassifikator-3T.txt');
const COMPOSITION_PATH = path.join(PROJECT_ROOT, 'data', 'references', 'composition.json');

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
  const docsPath = userSources.docsPath ?? process.env.DOCS_DATA_PATH ?? DEFAULT_DOCS_PATH;
  const memory = await resolveCode112Memory(userSources);
  const memoryMessages = applyMemoryDefaults(projectData, state, memory);

  mergeCollectedData(projectData, state, userSources);

  if (!state.startedAt) {
    state.startedAt = now;
    console.log('[code112] Starting new code112 project', { projectId: projectData.id });
    addAgentMessage(projectData, buildStartMessage(state), now);
    for (const message of memoryMessages) addAgentMessage(projectData, message, now);
    if (!hasOrganizationName(state)) {
      state.awaitingOrganizationName = true;
      console.log('[code112] Awaiting organization name');
      askUser(projectData, organizationNameQuestion(), [], now);
      projectData.updatedAt = now;
      return projectData;
    }
    state.awaitingOrganizationName = false;
    console.log('[code112] Organization name provided, creating project pages');
    await syncCode112ProjectPages(projectData, state, docsPath, now, { activateDocumentKey: 'appendix' });
    console.log('[code112] Project pages created successfully');
    askUser(projectData, 'С чего хотите начать?', menuOptions(), now);
    return projectData;
  }

  if (!state.activeDocument && !hasOrganizationName(state)) {
    state.awaitingOrganizationName = true;
  }

  if (!state.awaitingOrganizationName) {
    await syncCode112ProjectPages(projectData, state, docsPath, now);
  }

  if (!answer) {
    if (state.awaitingOrganizationName) {
      askUser(projectData, organizationNameQuestion(), [], now);
    } else {
      askUser(projectData, buildProgressMessage(state), menuOptions(), now);
    }
    return projectData;
  }

  addUserMessage(projectData, answer, now);

  if (state.awaitingOrganizationName) {
    if (isStopAnswer(answer)) {
      state.pausedAt = now;
      projectData.updatedAt = now;
      askUser(projectData, 'Работа по акту инвентаризации сохранена как «в работе». Когда вернётесь, сначала укажем название организации.', [], now);
      return projectData;
    }

    if (isOrganizationActionAnswer(answer)) {
      addAgentMessage(projectData, 'Сначала нужно указать название организации для акта инвентаризации.', now);
      askUser(projectData, organizationNameQuestion(), [], now);
      projectData.updatedAt = now;
      return projectData;
    }

    const organizationName = extractOrganizationNameAnswer(answer) || state.data.Название_организации;
    if (!isFilledTemplateValue(organizationName)) {
      askUser(projectData, organizationNameQuestion(), [], now);
      projectData.updatedAt = now;
      return projectData;
    }

    state.data.Название_организации = organizationName;
    state.awaitingOrganizationName = false;
    await syncCode112ProjectPages(projectData, state, docsPath, now, { activateDocumentKey: 'appendix' });

    const organizationQuestion = prepareOrganizationMemoryConfirmation(state, memory, organizationName);
    if (organizationQuestion) {
      askUser(projectData, organizationQuestion, confirmationOptions(), now);
    } else {
      askUser(projectData, 'С чего хотите начать?', menuOptions(), now);
    }
    projectData.updatedAt = now;
    return projectData;
  }

  const organizationConfirmation = handleOrganizationConfirmation(projectData, state, answer, memory, now);
  if (organizationConfirmation) {
    await syncCode112ProjectPages(projectData, state, docsPath, now);
    return organizationConfirmation;
  }

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

  if (isRefreshReferencesAnswer(answer)) {
    try {
      await refreshDisposalReferences();
    } catch (error) {
      console.warn('[code112] Не удалось обновить справочники', error);
      askUser(projectData, 'Не удалось обновить справочники из внешних источников. Продолжаю использовать локальный кэш и значения по умолчанию.', menuOptions(), now);
      projectData.updatedAt = now;
      return projectData;
    }
    if (state.extractedWasteList.length) {
      state.extractedWasteList = await resolveWasteDisposalMethods(state.extractedWasteList, { refresh: true });
      state.wastes = await resolveWasteDisposalMethods(state.wastes, { refresh: true });
      await syncCode112ProjectPages(projectData, state, docsPath, now, {
        refreshAppendixContent: true,
        refreshSourcesContent: true,
        refreshWasteFormationContent: true,
      });
    }
    askUser(projectData, 'Справочники обновлены. К чему теперь приступить?', menuOptions(), now);
    projectData.updatedAt = now;
    return projectData;
  }

  if (state.pendingSourcesExtraction) {
    const normalized = normalizeAnswer(answer);
    if (normalized === 'cancel' || isNoAnswer(normalized)) {
      state.pendingSourcesExtraction = null;
      state.activeDocument = 'sources';
      askUser(projectData, 'Загрузка отменена. К чему теперь приступить?', documentWorkOptions(state, 'sources'), now);
      projectData.updatedAt = now;
      return projectData;
    }
    if (normalized === 'all' || isYesAnswer(normalized)) {
      return processPendingSourcesExtraction(projectData, state, 'all', now, userSources);
    }
    askUser(projectData, 'Выберите, какие данные извлечь из загруженного файла.', sourcesExtractionModeOptions(), now);
    projectData.updatedAt = now;
    return projectData;
  }

  if (state.pendingUploadDocumentSelection) {
    const normalized = normalizeAnswer(answer);
    const selected = uploadDocumentSelectionOptions().find((o) =>
      normalized === o.key || normalized === normalizeAnswer(o.label) || answer.includes(o.label)
    );
    const pending = state.pendingUploadDocumentSelection;
    if (!selected) {
      askUser(projectData, 'Не удалось определить документ. Выберите из списка.', uploadDocumentSelectionOptions(), now);
      projectData.updatedAt = now;
      return projectData;
    }
    if (!['titleAct', 'appendix', 'sources', 'wasteFormation', 'measures'].includes(selected.key)) {
      state.pendingUploadDocumentSelection = null;
      askUser(projectData, `Загрузка файла для «${selected.label}» пока не поддерживается. К чему теперь приступить?`, menuOptions(), now);
      projectData.updatedAt = now;
      return projectData;
    }
    state.pendingUploadDocumentSelection = null;
    state.activeDocument = selected.key;
    state.updatedAt = now;
    const upload = projectData.extractedData.uploads[pending.uploadIndex];
    const buffer = pending.bufferBase64 ? Buffer.from(pending.bufferBase64, 'base64') : null;
    return registerCode112Upload(projectData, upload, { ...userSources, now, buffer });
  }

  if (state.pendingWasteExtraction) {
    const mode = normalizeWasteExtractionMode(answer);
    if (!mode) {
      askUser(projectData, 'Выберите, какие данные извлечь из загруженного файла.', wasteExtractionModeOptions(), now);
      projectData.updatedAt = now;
      return projectData;
    }
    return processPendingWasteExtraction(projectData, state, mode, now, userSources);
  }

  if (state.awaitingTitleData) {
    return handleTitleDataInput(projectData, state, answer, docsPath, now);
  }

  if (state.pendingFinalGeneration) {
    const normalized = normalizeAnswer(answer);
    if (isYesAnswer(normalized)) {
      state.pendingFinalGeneration = null;
      return performFinalGenerationAndArchive(projectData, state, userSources, outputDir, docsPath, now);
    }
    if (isNoAnswer(normalized) || normalizeAnswer(answer) === 'pause') {
      state.pendingFinalGeneration = null;
      state.pausedAt = now;
      askUser(projectData, 'Работа по акту инвентаризации сохранена. К чему теперь приступить?', menuOptions(), now);
      projectData.updatedAt = now;
      return projectData;
    }
    askUser(projectData, 'Все данные внесены. Хотите сгенерировать DOCX?', confirmationOptions(), now);
    projectData.updatedAt = now;
    return projectData;
  }

  if (state.pendingTitleExtraction) {
    const normalized = normalizeAnswer(answer);
    const { uploadIndex, bufferBase64 } = state.pendingTitleExtraction;
    if (isYesAnswer(normalized)) {
      state.pendingTitleExtraction = null;
      const buffer = bufferBase64 ? Buffer.from(bufferBase64, 'base64') : null;
      if (buffer) {
        const upload = projectData.extractedData.uploads[uploadIndex] ?? projectData.extractedData.uploads.at(-1);
        const fileType = String(upload?.fileName ?? '').toLowerCase();
        const data = await extractTitleDataFromFile(buffer, fileType);
        state.titleData = data;
        applyTitleDataToState(state, data);
      }
      return applyTitleDataFromUpload(projectData, state, uploadIndex, docsPath, now, 'titleAct');
    }
    state.pendingTitleExtraction = null;
    state.activeDocument = 'titleAct';
    askUser(projectData, 'Заполнение титула из файла отменено. К чему теперь приступить?', documentWorkOptions(state, 'titleAct'), now);
    projectData.updatedAt = now;
    return projectData;
  }

  if (state.pendingWasteFormationExtraction) {
    const normalized = normalizeAnswer(answer);
    const { uploadIndex, bufferBase64 } = state.pendingWasteFormationExtraction;
    if (isYesAnswer(normalized)) {
      state.pendingWasteFormationExtraction = null;
      const buffer = bufferBase64 ? Buffer.from(bufferBase64, 'base64') : null;
      return applyWasteFormationFileData(projectData, state, uploadIndex, docsPath, now, buffer);
    }
    state.pendingWasteFormationExtraction = null;
    state.activeDocument = 'wasteFormation';
    askUser(projectData, 'Заполнение из файла отменено. К чему теперь приступить?', documentWorkOptions(state, 'wasteFormation'), now);
    projectData.updatedAt = now;
    return projectData;
  }

  if (state.awaitingWasteFormationComposition) {
    return handleWasteFormationCompositionInput(projectData, state, answer, docsPath, now);
  }

  if (state.awaitingPhysicalState) {
    return handlePhysicalStateInput(projectData, state, answer, docsPath, now);
  }

  if (state.pendingDisposalConfirmation) {
    return handleDisposalConfirmation(projectData, state, answer, docsPath, now);
  }

  if (state.awaitingQuantities) {
    return handleQuantityInput(projectData, state, answer, docsPath, now);
  }

  if (state.awaitingNormatives) {
    return handleNormativeInput(projectData, state, answer, docsPath, now);
  }

  if (state.awaitingSourceDetails) {
    return handleSourceDetailsInput(projectData, state, answer, docsPath, now);
  }

  if (state.pendingSourcesConfirmation) {
    return handleSourceConfirmationInput(projectData, state, answer, docsPath, now);
  }

  if (state.awaitingSiteCount) {
    return handleSiteCountInput(projectData, state, answer, docsPath, now);
  }

  if (state.awaitingSourceQuantities) {
    return handleSourceQuantityInput(projectData, state, answer, docsPath, now);
  }

  if (state.pendingSourcesEdit) {
    return handleSourcesEdit(projectData, state, answer, docsPath, now);
  }

  if (state.pendingAppendixEdit) {
    return handleAppendixEdit(projectData, state, answer, docsPath, now);
  }

  if (state.pendingWasteImport) {
    const normalized = normalizeAnswer(answer);
    if (isGenerateAnswer(answer)) {
      if (state.extractedWasteList.length && !isWasteDataComplete(state)) {
        askUser(projectData, buildWasteDataIncompleteMessage(state), menuOptions(), now);
        projectData.updatedAt = now;
        return projectData;
      }
      state.pendingWasteImport = null;
      await generateDocuments(projectData, state, code112Documents, outputDir, docsPath, now);
      askUser(projectData, 'Все 5 документов по акту инвентаризации сформированы. К чему теперь приступить?', menuOptions(), now);
      return projectData;
    }
    if (state.pendingWasteImport.stage === 'review' && (isYesAnswer(normalized) || isUploadedWasteCommand(answer))) {
      return fillAppendixFromExtractedWastes(projectData, state, docsPath, now, { explicit: true, refreshAllPages: true });
    }
    if (isYesAnswer(normalized) || isUploadedWasteCommand(answer)) {
      return fillAppendixFromExtractedWastes(projectData, state, docsPath, now, { explicit: true, refreshAllPages: true });
    }
    if (state.pendingWasteImport.stage === 'edit') {
      return handleWasteListEdit(projectData, state, answer, docsPath, now);
    }
    if (isNoAnswer(normalized)) {
      state.pendingWasteImport = { ...state.pendingWasteImport, stage: 'edit' };
      askUser(projectData, buildWasteEditQuestion(state), [], now);
      projectData.updatedAt = now;
      return projectData;
    }
    askUser(projectData, buildWasteReviewQuestion(state), confirmationOptions(), now);
    projectData.updatedAt = now;
    return projectData;
  }

  if (state.activeDocument) {
    return finishActiveDocument(projectData, state, answer, outputDir, docsPath, now);
  }

  const selectedDocument = findDocument(answer);
  if (selectedDocument) {
    state.activeDocument = selectedDocument.key;
    state.files[selectedDocument.key].status = 'in_progress';
    await syncCode112ProjectPages(projectData, state, docsPath, now, { activateDocumentKey: selectedDocument.key });
    projectData.updatedAt = now;
    if (selectedDocument.key === 'appendix' && hasAppendixData(state)) {
      state.pendingAppendixEdit = { stage: 'confirm' };
      state.activeDocument = null;
      askUser(projectData, 'Для этого документа уже введены данные. Хотите что-то изменить?', confirmationOptions(), now);
      projectData.updatedAt = now;
      return projectData;
    }
    if (selectedDocument.key === 'sources' && hasSourcesData(state)) {
      state.pendingSourcesEdit = { stage: 'confirm' };
      state.activeDocument = null;
      askUser(projectData, 'Для этого документа уже введены данные. Хотите что-то изменить?', confirmationOptions(), now);
      projectData.updatedAt = now;
      return projectData;
    }
    if (selectedDocument.key === 'appendix' && state.extractedWasteList.length) {
      state.pendingWasteImport = {
        count: state.extractedWasteList.length,
        fileName: state.pendingWasteImport?.fileName ?? '',
        createdAt: now,
      };
      askUser(projectData, buildWasteImportQuestion(state), confirmationOptions(), now);
      return projectData;
    }
    askUser(projectData, buildDocumentQuestion(selectedDocument, state), documentWorkOptions(state, selectedDocument.key), now);
    return projectData;
  }

  if (isGenerateAnswer(answer)) {
    if (state.extractedWasteList.length && !isWasteDataComplete(state)) {
      askUser(projectData, buildWasteDataIncompleteMessage(state), menuOptions(), now);
      projectData.updatedAt = now;
      return projectData;
    }
    state.pendingFinalGeneration = { outputDir, docsPath };
    askUser(projectData, 'Все данные внесены. Хотите сгенерировать DOCX?', confirmationOptions(), now);
    projectData.updatedAt = now;
    return projectData;
  }

  if (isFillTemplateAnswer(answer)) {
    if (state.extractedWasteList.length && normalizeAnswer(answer).includes('прилож')) {
      return fillAppendixFromExtractedWastes(projectData, state, docsPath, now, { explicit: true, refreshAllPages: true });
    }
    await syncCode112ProjectPages(projectData, state, docsPath, now, { activateDocumentKey: 'appendix' });
    const message = state.wastes.length
      ? 'Заполнил предпросмотр страниц актуальными данными из проекта. Проверьте «Приложение к акту» в папке проекта и при необходимости добавьте строки отходов.'
      : 'Готов заполнить метки, но для приложения пока нет строк отходов. Отправьте строки вида «Отход: код;наименование;класс;количество;ед.;способ;источник;физсост».';
    addAgentMessage(projectData, message, now);
    askUser(projectData, 'К чему теперь приступить?', menuOptions(), now);
    projectData.updatedAt = now;
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
  if (state.awaitingOrganizationName) return organizationNameQuestion();
  if (state.pendingAppendixEdit) return buildAppendixEditQuestion(state);
  if (state.pendingSourcesEdit) return 'Для этого документа уже введены данные. Хотите что-то изменить?';
  if (state.pendingSourcesExtraction) return 'Какие данные извлечь из загруженного файла?';
  if (state.awaitingSourceQuantities) return buildSourceQuantityQuestion(state);
  if (state.pendingWasteExtraction) return 'Какие данные извлечь из загруженного файла?';
  if (state.pendingTitleExtraction) return 'Заполнить данные титула акта из загруженного файла?';
  if (state.awaitingTitleData) {
    const q = state.awaitingTitleData?.missing[state.awaitingTitleData.index];
    if (state.awaitingTitleData?.pendingMore) return 'Хотите добавить еще одного члена комиссии?';
    return q?.question ?? 'Укажите данные для титула акта.';
  }
  if (state.pendingFinalGeneration) return 'Все данные внесены. Хотите сгенерировать DOCX?';
  if (state.pendingDisposalConfirmation) {
    const pendingWaste = state.extractedWasteList.find((w) => wasteKey(w) === state.pendingDisposalConfirmation.wasteKey);
    if (pendingWaste) return buildDisposalConfirmationQuestion(pendingWaste);
    return 'Подтвердите способ обращения с отходом.';
  }
  if (state.awaitingQuantities) return buildQuantityQuestion(state);
  if (state.awaitingNormatives) return buildNormativeQuestion(state);
  if (state.activeDocument) return `Цэпик работает над файлом: ${documentByKey.get(state.activeDocument)?.label ?? state.activeDocument}`;
  return 'К чему теперь приступить?';
}

function uploadDocumentSelectionOptions() {
  return [
    { key: 'titleAct', label: 'Титул акта' },
    { key: 'appendix', label: 'Приложение к акту' },
    { key: 'sources', label: 'Источники образования' },
    { key: 'wasteFormation', label: 'Сведения о количестве' },
    { key: 'measures', label: 'Перечень мероприятий' },
  ];
}

export function getCode112Options(project) {
  const state = project.extractedData?.code112;
  if (!state) return [];
  if (state.pendingWasteExtraction) return wasteExtractionModeOptions();
  if (state.memory?.pendingOrganization) return confirmationOptions();
  if (state.pendingAppendixEdit) return appendixEditOptions(state);
  if (state.pendingSourcesEdit) return confirmationOptions();
  if (state.pendingSourcesExtraction) return sourcesExtractionModeOptions();
  if (state.pendingSourcesConfirmation) return confirmationOptions();
  if (state.awaitingSourceDetails) return [];
  if (state.awaitingSiteCount) return [];
  if (state.awaitingSourceQuantities) return [];
  if (state.pendingWasteImport) return confirmationOptions();
  if (state.pendingUploadDocumentSelection) return uploadDocumentSelectionOptions();
  if (state.awaitingWasteFormationComposition) return [];
  if (state.awaitingPhysicalState) return state.awaitingPhysicalState.stage === 'confirm' ? confirmationOptions() : [];
  if (state.pendingDisposalConfirmation) {
    const pendingWaste = state.extractedWasteList.find((w) => wasteKey(w) === state.pendingDisposalConfirmation.wasteKey);
    return disposalConfirmationOptions(pendingWaste);
  }
  if (state.awaitingQuantities) return [];
  if (state.awaitingNormatives) {
    return state.awaitingNormatives.needsInput ? [] : confirmationOptions();
  }
  if (state.pendingTitleExtraction) return confirmationOptions();
  if (state.pendingWasteFormationExtraction) return confirmationOptions();
  if (state.awaitingTitleData) return [];
  if (state.pendingFinalGeneration) return confirmationOptions();
  if (state.awaitingOrganizationName) return [];
  if (state.activeDocument) return documentWorkOptions(state, state.activeDocument);
  return menuOptions();
}

function isSourcesUpload(upload) {
  const fileName = String(upload.fileName ?? '').toLowerCase();
  const text = String(upload.text ?? '').toLowerCase();
  return fileName.includes('источник')
    || text.includes('источник')
    || text.includes('номер источника')
    || text.includes('наименование источника')
    || text.includes('корпус, цех, участок');
}

function isAppendixUpload(upload) {
  const fileName = String(upload.fileName ?? '').toLowerCase();
  const text = String(upload.text ?? '').toLowerCase();
  return fileName.includes('прилож')
    || text.includes('приложение к акту')
    || text.includes('норматив образования')
    || text.includes('подлежит заготовке')
    || text.includes('подлежит сортировке')
    || text.includes('количество образующихся отходов');
}

function isWasteFormationUpload(upload) {
  const text = String(upload.text ?? '').toLowerCase();
  return text.includes('состав отходов')
    || text.includes('агрегатное состояние')
    || text.includes('физико-химическая')
    || text.includes('сведения о количестве')
    || text.includes('опасные свойства')
    || text.includes('компонент');
}

function isTitleUpload(upload) {
  const text = String(upload.text ?? '').toLowerCase();
  return text.includes('руководитель:')
    || text.includes('председатель:')
    || text.includes('члены:')
    || text.includes('юридический адрес:')
    || text.includes('инвентаризация:');
}

function isMeasuresUpload(upload) {
  const fileName = String(upload.fileName ?? '').toLowerCase();
  const text = String(upload.text ?? '').toLowerCase();
  return fileName.includes('мероприят')
    || text.includes('перечень мероприятий')
    || text.includes('мероприятия');
}

export async function registerCode112Upload(project, upload, options = {}) {
  if (project.packageCode !== '112' && !project.extractedData?.code112) return null;

  const now = options.now ?? Date.now();
  const state = ensureGeneratorState(project, now);
  const uploads = Array.isArray(project.extractedData?.uploads) ? project.extractedData.uploads : [];
  const uploadIndex = Math.max(0, uploads.length - 1);
  const textSample = String(upload.text ?? '').slice(0, 200).replace(/\s+/g, ' ');

  console.log('[code112] registerCode112Upload: active document:', state.activeDocument, ', file:', upload.fileName, ', text sample:', textSample);

  let detected = null;
  if (isWasteFormationUpload(upload)) detected = 'wasteFormation';
  else if (isSourcesUpload(upload)) detected = 'sources';
  else if (isAppendixUpload(upload)) detected = 'appendix';
  else if (isTitleUpload(upload)) detected = 'titleAct';
  else if (isMeasuresUpload(upload)) detected = 'measures';
  console.log('[code112] registerCode112Upload: detected type:', detected);

  const bufferBase64 = options.buffer ? options.buffer.toString('base64') : null;

  if (!state.activeDocument) {
    console.log('[code112] registerCode112Upload: no active document, asking user to choose');
    state.pendingUploadDocumentSelection = {
      uploadIndex,
      fileName: upload.fileName,
      detected,
      bufferBase64,
      createdAt: now,
    };
    state.updatedAt = now;
    project.updatedAt = now;
    addAgentMessage(project, `Файл «${upload.fileName}» загружен. Для какого документа акта инвентаризации его использовать?`, now);
    askUser(project, 'Выберите документ, для которого предназначен файл.', uploadDocumentSelectionOptions(), now);
    return state.pendingUploadDocumentSelection;
  }

  if (detected && detected !== state.activeDocument) {
    console.log('[code112] registerCode112Upload: detected', detected, 'does not match active', state.activeDocument);
    state.pendingUploadDocumentSelection = {
      uploadIndex,
      fileName: upload.fileName,
      detected,
      expected: state.activeDocument,
      bufferBase64,
      createdAt: now,
    };
    state.updatedAt = now;
    project.updatedAt = now;
    const detectedLabel = documentByKey.get(detected)?.label ?? detected;
    const activeLabel = documentByKey.get(state.activeDocument)?.label ?? state.activeDocument;
    addAgentMessage(
      project,
      `Загруженный файл «${upload.fileName}» похож на «${detectedLabel}», а активен документ «${activeLabel}». Для какого документа использовать файл?`,
      now
    );
    askUser(
      project,
      'Загруженный файл, похоже, не соответствует выбранному документу. Убедитесь, что вы загружаете правильный файл, или выберите другой документ.',
      uploadDocumentSelectionOptions(),
      now
    );
    return state.pendingUploadDocumentSelection;
  }

  if (state.activeDocument === 'sources' || detected === 'sources') {
    console.log('[code112] registerCode112Upload: detected Sources upload, proposing sources extraction options');
    state.activeDocument = 'sources';
    state.files.sources.status = 'in_progress';

    let preParsed = null;
    if (options.buffer) {
      preParsed = await extractSourcesFromDocxBuffer(options.buffer);
      console.log('[code112] registerCode112Upload: pre-parsed', preParsed?.rows?.length ?? 0, 'source rows');
    }

    state.pendingSourcesExtraction = {
      uploadIndex,
      fileName: upload.fileName,
      text: upload.text ?? '',
      rows: preParsed && preParsed.rows.length ? preParsed.rows : null,
      createdAt: now,
    };
    state.updatedAt = now;
    project.updatedAt = now;
    addAgentMessage(
      project,
      `Файл «${upload.fileName}» похож на источники образования. Извлечь данные для Источников?`,
      now
    );
    askUser(project, 'Выберите режим извлечения данных из файла.', sourcesExtractionModeOptions(), now);
    return state.pendingSourcesExtraction;
  }

  if (state.activeDocument === 'wasteFormation' || detected === 'wasteFormation') {
    console.log('[code112] registerCode112Upload: detected Waste formation upload, asking for confirmation');
    state.activeDocument = 'wasteFormation';
    state.files.wasteFormation.status = 'in_progress';
    state.pendingWasteFormationExtraction = {
      uploadIndex,
      fileName: upload.fileName,
      text: upload.text ?? '',
      bufferBase64,
      createdAt: now,
    };
    state.updatedAt = now;
    project.updatedAt = now;
    addAgentMessage(
      project,
      `Файл «${upload.fileName}» похож на Сведения об образовании отходов. Заполнить колонки 9–10 (состав) из файла?`,
      now
    );
    askUser(project, 'Заполнить состав отходов из загруженного файла? (Если данные в справочнике отличаются, будет задан вопрос.)', confirmationOptions(), now);
    return state.pendingWasteFormationExtraction;
  }

  if (state.activeDocument === 'titleAct' || state.activeDocument === 'measures' || detected === 'titleAct' || detected === 'measures') {
    console.log('[code112] registerCode112Upload: detected title data file, asking for confirmation');
    state.activeDocument = 'titleAct';
    state.files.titleAct.status = 'in_progress';
    state.pendingTitleExtraction = {
      uploadIndex,
      fileName: upload.fileName,
      text: upload.text ?? '',
      bufferBase64,
      createdAt: now,
    };
    state.updatedAt = now;
    project.updatedAt = now;
    addAgentMessage(project, `Файл «${upload.fileName}» похож на данные для титула. Заполнить титул из файла?`, now);
    askUser(project, 'Заполнить данные титула акта из загруженного файла?', confirmationOptions(), now);
    return state.pendingTitleExtraction;
  }

  console.log('[code112] registerCode112Upload: using standard waste extraction for appendix/waste list');
  state.activeDocument = 'appendix';
  state.files.appendix.status = 'in_progress';
  state.pendingWasteExtraction = {
    uploadIndex,
    fileName: upload.fileName,
    text: upload.text ?? '',
    createdAt: now,
  };
  state.updatedAt = now;
  project.updatedAt = now;
  addAgentMessage(
    project,
    `Файл «${upload.fileName}» готов к разбору. Какие данные извлечь?`,
    now
  );
  askUser(project, 'Выберите режим извлечения данных из файла.', wasteExtractionModeOptions(), now);
  return state.pendingWasteExtraction;
}

function sourcesExtractionModeOptions() {
  return [
    { key: 'all', label: 'Извлечь все данные для Источников образования' },
    { key: 'cancel', label: 'Отмена' },
  ];
}

function normalizeSourcesExtractionMode(answer) {
  const normalized = normalizeAnswer(answer);
  if (normalized.includes('все')) return 'all';
  if (isYesAnswer(normalized)) return 'all';
  if (normalized === 'cancel' || isNoAnswer(normalized)) return 'cancel';
  return null;
}

async function processPendingWasteExtraction(project, state, mode, now, userSources = {}) {
  console.log('[code112] Processing waste extraction', { mode, uploadIndex: state.pendingWasteExtraction?.uploadIndex });
  
  const uploads = Array.isArray(project.extractedData?.uploads) ? project.extractedData.uploads : [];
  const upload = uploads[state.pendingWasteExtraction.uploadIndex] ?? uploads.at(-1) ?? state.pendingWasteExtraction;
  if (!upload) {
    console.warn('[code112] Upload not found for waste extraction');
    state.pendingWasteExtraction = null;
    askUser(project, 'Загруженный файл не найден. Загрузите файл ещё раз или введите отходы вручную.', menuOptions(), now);
    project.updatedAt = now;
    return project;
  }

  const extracted = extractWasteDataFromText(upload.text ?? '', mode)
    .map((waste) => normalizeWasteRow({
      code: waste.code,
      name: waste.name,
      normative: waste.norm ?? '',
      amount: waste.quantity ?? '',
    }))
    .filter((waste) => waste.code);
  
  console.log('[code112] Extracted wastes from file:', { fileName: upload.fileName, count: extracted.length, mode });
  
  if (!extracted.length) {
    console.warn('[code112] No waste codes found in uploaded file');
    state.pendingWasteExtraction = null;
    askUser(project, `В файле «${upload.fileName}» не нашёл 7-значные коды отходов. Введите строки вручную или загрузите другой файл.`, menuOptions(), now);
    project.updatedAt = now;
    return project;
  }

  let enriched = extracted;
  try {
    console.log('[code112] Enriching wastes with hazard classes');
    enriched = await enrichWasteListWithHazardClasses(extracted, userSources);
  } catch (error) {
    console.warn('[code112] Не удалось определить классы опасности по классификатору 3Т', error);
  }
  
  console.log('[code112] Resolving disposal methods for wastes');
  enriched = await resolveWasteDisposalMethods(enriched, userSources);

  state.extractedWasteList = mergeWastes(state.extractedWasteList, enriched).sort(compareWasteCodes);
  console.log('[code112] Total extracted wastes after merge:', state.extractedWasteList.length);
  
  // Also merge into state.wastes so pages show all wastes
  state.wastes = mergeWastes(state.wastes, state.extractedWasteList).sort(compareWasteCodes);
  console.log('[code112] Total state.wastes after merge:', state.wastes.length);
  
  state.pendingWasteExtraction = null;
  state.pendingWasteImport = {
    stage: 'review',
    mode,
    count: state.extractedWasteList.length,
    fileName: upload.fileName,
    createdAt: now,
  };
  state.updatedAt = now;
  project.updatedAt = now;

  // Immediately update docs.json pages after extraction
  const docsPath = userSources.docsPath ?? process.env.DOCS_DATA_PATH ?? DEFAULT_DOCS_PATH;
  console.log('[code112] Updating project pages after extraction');
  await syncCode112ProjectPages(project, state, docsPath, now, {
    refreshAppendixContent: true,
    refreshSourcesContent: true,
    refreshWasteFormationContent: true,
  });
  console.log('[code112] Project pages updated after extraction');

  askUser(project, buildWasteReviewQuestion(state), confirmationOptions(), now);
  return project;
}

async function processPendingSourcesExtraction(project, state, mode, now, userSources = {}) {
  console.log('[code112] Processing sources extraction', { mode, uploadIndex: state.pendingSourcesExtraction?.uploadIndex });

  const uploads = Array.isArray(project.extractedData?.uploads) ? project.extractedData.uploads : [];
  const upload = uploads[state.pendingSourcesExtraction?.uploadIndex] ?? uploads.at(-1) ?? state.pendingSourcesExtraction;
  if (!upload) {
    console.warn('[code112] Upload not found for sources extraction');
    state.pendingSourcesExtraction = null;
    askUser(project, 'Файл для Источников образования не найден. Загрузите файл снова.', documentWorkOptions(state, 'sources'), now);
    project.updatedAt = now;
    return project;
  }

  let extracted = [];
  if (Array.isArray(state.pendingSourcesExtraction?.rows) && state.pendingSourcesExtraction.rows.length) {
    extracted = state.pendingSourcesExtraction.rows;
    console.log('[code112] Using pre-parsed source rows:', extracted.length);
  } else {
    extracted = extractSourcesFromFile(upload.text ?? '');
  }
  console.log('[code112] Extracted sources from file:', { fileName: upload.fileName, count: extracted.length });

  if (!extracted.length) {
    console.warn('[code112] No source rows found in uploaded file');
    state.pendingSourcesExtraction = null;
    askUser(
      project,
      `Не удалось автоматически распознать таблицу. Пожалуйста, убедитесь, что файл содержит таблицу с колонками: Номер источника, Наименование источника, Корпус, цех, участок, Код отхода, Наименование отхода, Количество образующихся отходов. Попробуйте загрузить другой файл или введите данные вручную.`,
      documentWorkOptions(state, 'sources'),
      now
    );
    project.updatedAt = now;
    return project;
  }

  const missingCodes = [];
  for (const row of extracted) {
    const existing = state.wastes.find((w) => w.code === row.code);
    if (existing) {
      existing.sourceNumber = row.sourceNumber;
      existing.sourceName = row.sourceName;
      existing.site = row.site;
      const sourceQuantity = row.quantity || row.quantityRaw;
      if (sourceQuantity) existing.quantityKg = sourceQuantity;
      // Also update extractedWasteList
      const extractedExisting = state.extractedWasteList.find((w) => w.code === row.code);
      if (extractedExisting) {
        extractedExisting.sourceNumber = row.sourceNumber;
        extractedExisting.sourceName = row.sourceName;
        extractedExisting.site = row.site;
        if (sourceQuantity) extractedExisting.quantityKg = sourceQuantity;
      }
    } else {
      missingCodes.push(row.code);
      console.warn('[code112] Source code not in waste list, skipping:', row.code);
    }
  }

  if (missingCodes.length) {
    console.warn('[code112] Skipped source rows with unknown codes:', missingCodes);
  }

  state.extractedWasteList = state.extractedWasteList.sort(compareWasteCodes);
  state.wastes = state.wastes.sort(compareWasteCodes);
  state.pendingSourcesExtraction = null;
  state.files.sources.filledFromFile = true;
  state.files.sources.status = 'in_progress';
  state.updatedAt = now;
  project.updatedAt = now;

  const docsPath = userSources.docsPath ?? process.env.DOCS_DATA_PATH ?? DEFAULT_DOCS_PATH;
  console.log('[code112] Updating project sources and waste formation pages after extraction');
  await syncCode112ProjectPages(project, state, docsPath, now, {
    activateDocumentKey: 'sources',
    refreshSourcesContent: true,
    refreshWasteFormationContent: true,
  });
  console.log('[code112] Sources and waste formation pages updated after extraction');

  addAgentMessage(project, `Извлечено ${extracted.length} строк Источников образования.`, now);

  return startSourceDetailsCollection(project, state, docsPath, now);
}

function wastesMissingSourceDetails(state) {
  return state.wastes.filter((w) => {
    const sourceNumber = String(w.sourceNumber ?? '').trim();
    const sourceName = String(w.sourceName ?? '').trim();
    const site = String(w.site ?? '').trim();
    return !sourceNumber || sourceNumber === '—' || !sourceName || sourceName === '—' || !site || site === '—';
  });
}

async function startSourceDetailsCollection(project, state, docsPath, now) {
  const queue = wastesMissingSourceDetails(state);
  if (queue.length) {
    state.awaitingSourceDetails = { queue: queue.map((w) => w.code), index: 0 };
    state.activeDocument = 'sources';
    await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'sources', refreshSourcesContent: true });
    askUser(project, buildSourceDetailsQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }
  return startSourceConfirmation(project, state, docsPath, now);
}

function buildSourceDetailsQuestion(state) {
  const queue = state.awaitingSourceDetails?.queue || [];
  const index = state.awaitingSourceDetails?.index ?? 0;
  const code = queue[index];
  const waste = state.wastes.find((w) => w.code === code);
  if (!waste) return 'Укажите номер источника, наименование источника и участок для отхода.';
  return `Для отхода ${waste.code} (${waste.name || '—'}) укажите через точку с запятой: номер источника; наименование источника; участок (корпус, цех, участок). Пример: 1;Производственный процесс;Административно-производственный корпус`;
}

function parseSourceDetailsAnswer(answer, currentCode) {
  const text = String(answer).trim();

  const explicitMatch = text.match(/^(\d{5,})\s*[:=]\s*(.+)$/s);
  if (explicitMatch) {
    const code = explicitMatch[1];
    const rest = explicitMatch[2].trim();
    const parts = rest.split(';').map((p) => p.trim()).filter(Boolean);
    return { code, parts };
  }

  const parts = text.split(';').map((p) => p.trim()).filter(Boolean);
  return { code: currentCode, parts };
}

async function handleSourceDetailsInput(project, state, answer, docsPath, now) {
  const queue = state.awaitingSourceDetails?.queue || [];
  const index = state.awaitingSourceDetails?.index ?? 0;
  const currentCode = queue[index];

  const { code, parts } = parseSourceDetailsAnswer(answer, currentCode);
  const waste = state.wastes.find((w) => w.code === code);

  if (!waste || parts.length < 2) {
    addAgentMessage(project, 'Не удалось распознать данные. Используйте формат: номер;источник;участок или код: номер;источник;участок.', now);
    askUser(project, buildSourceDetailsQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  const sourceNumber = parts[0].replace(/\D/g, '');
  const sourceName = parts[1];
  const site = parts.slice(2).join('; ').trim();

  if (!sourceNumber || !sourceName) {
    addAgentMessage(project, 'Номер источника и наименование источника обязательны.', now);
    askUser(project, buildSourceDetailsQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  waste.sourceNumber = sourceNumber;
  waste.sourceName = sourceName;
  waste.site = site || '—';

  const extracted = state.extractedWasteList.find((w) => w.code === code);
  if (extracted) {
    extracted.sourceNumber = sourceNumber;
    extracted.sourceName = sourceName;
    extracted.site = waste.site;
  }

  console.log('[code112] Source details updated for', code, { sourceNumber, sourceName, site: waste.site });

  await syncCode112ProjectPages(project, state, docsPath, now, {
    activateDocumentKey: 'sources',
    refreshSourcesContent: true,
    refreshWasteFormationContent: true,
  });

  const nextIndex = index + 1;
  if (nextIndex < queue.length) {
    state.awaitingSourceDetails = { queue, index: nextIndex };
    askUser(project, buildSourceDetailsQuestion(state), [], now);
  } else {
    state.awaitingSourceDetails = null;
    await startSourceConfirmation(project, state, docsPath, now);
  }

  project.updatedAt = now;
  return project;
}

function buildSourceConfirmationSummary(state) {
  const lines = state.wastes
    .filter((w) => w.sourceName && w.sourceName !== '—')
    .map((w, i) => `${i + 1}. ${w.code} – ${w.name || w.wasteName || w.code}: ист. ${w.sourceNumber || '—'} «${w.sourceName || '—'}», участок ${w.site || '—'}`);
  return ['Проверьте данные источников:', ...lines, '', 'Все данные для источников образования введены верно?'].join('\n');
}

async function startSourceConfirmation(project, state, docsPath, now) {
  state.pendingSourcesConfirmation = { stage: 'confirm' };
  state.activeDocument = 'sources';
  await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'sources', refreshSourcesContent: true });
  askUser(project, buildSourceConfirmationSummary(state), confirmationOptions(), now);
  project.updatedAt = now;
  return project;
}

async function handleSourceConfirmationInput(project, state, answer, docsPath, now) {
  const stage = state.pendingSourcesConfirmation?.stage ?? 'confirm';

  if (stage === 'confirm') {
    const normalized = normalizeAnswer(answer);
    if (isYesAnswer(normalized)) {
      state.pendingSourcesConfirmation = null;
      return startSiteCountCollection(project, state, docsPath, now);
    }
    if (isNoAnswer(normalized)) {
      state.pendingSourcesConfirmation = { stage: 'edit' };
      askUser(project, 'Для какого отхода изменить данные? Введите код отхода или наименование.', [], now);
      project.updatedAt = now;
      return project;
    }
    askUser(project, buildSourceConfirmationSummary(state), confirmationOptions(), now);
    project.updatedAt = now;
    return project;
  }

  if (stage === 'edit') {
    const text = String(answer).trim();
    const byCode = state.wastes.find((w) => w.code === text);
    const byName = state.wastes.find((w) => normalizeAnswer(w.name || '') === normalizeAnswer(text));
    const waste = byCode || byName;
    if (!waste) {
      addAgentMessage(project, 'Не удалось найти отход. Попробуйте ещё раз.', now);
      askUser(project, 'Для какого отхода изменить данные? Введите код отхода или наименование.', [], now);
      project.updatedAt = now;
      return project;
    }
    state.pendingSourcesConfirmation = { stage: 'editFields', code: waste.code };
    askUser(project, `Для отхода ${waste.code} (${waste.name || '—'}) введите новые данные: номер источника; наименование источника; участок.`, [], now);
    project.updatedAt = now;
    return project;
  }

  if (stage === 'editFields') {
    const code = state.pendingSourcesConfirmation.code;
    const waste = state.wastes.find((w) => w.code === code);
    const parts = String(answer).trim().split(';').map((p) => p.trim()).filter(Boolean);
    if (!waste || parts.length < 2) {
      addAgentMessage(project, 'Не удалось распознать данные. Используйте формат: номер;источник;участок.', now);
      askUser(project, `Для отхода ${code} введите новые данные: номер источника; наименование источника; участок.`, [], now);
      project.updatedAt = now;
      return project;
    }
    const sourceNumber = parts[0].replace(/\D/g, '');
    const sourceName = parts[1];
    const site = parts.slice(2).join('; ').trim();
    if (!sourceNumber || !sourceName) {
      addAgentMessage(project, 'Номер источника и наименование обязательны.', now);
      askUser(project, `Для отхода ${waste.code} (${waste.name || '—'}) введите новые данные: номер источника; наименование источника; участок.`, [], now);
      project.updatedAt = now;
      return project;
    }
    waste.sourceNumber = sourceNumber;
    waste.sourceName = sourceName;
    waste.site = site || '—';
    const extracted = state.extractedWasteList.find((w) => w.code === code);
    if (extracted) {
      extracted.sourceNumber = sourceNumber;
      extracted.sourceName = sourceName;
      extracted.site = waste.site;
    }
    await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'sources', refreshSourcesContent: true });
    state.pendingSourcesConfirmation = { stage: 'confirm' };
    askUser(project, buildSourceConfirmationSummary(state), confirmationOptions(), now);
    project.updatedAt = now;
    return project;
  }

  return project;
}

function needsSiteCountPrompt(waste) {
  if (isFilledTemplateValue(waste.siteCount)) return false;
  const text = String(waste.site || '').trim();
  return /все\s*участки/i.test(text) || /весь\s*цех/i.test(text) || /все\s*корпуса/i.test(text);
}

async function startSiteCountCollection(project, state, docsPath, now) {
  const queue = state.wastes
    .filter((w) => w.sourceName && w.sourceName !== '—' && needsSiteCountPrompt(w))
    .map((w) => w.code);
  if (!queue.length) {
    return startSourceQuantityCollection(project, state, docsPath, now);
  }
  state.awaitingSiteCount = { queue, index: 0 };
  state.activeDocument = 'sources';
  await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'sources', refreshSourcesContent: true, refreshWasteFormationContent: true });
  askUser(project, buildSiteCountQuestion(state), [], now);
  project.updatedAt = now;
  return project;
}

function buildSiteCountQuestion(state) {
  const queue = state.awaitingSiteCount?.queue || [];
  const index = state.awaitingSiteCount?.index ?? 0;
  const code = queue[index];
  const waste = state.wastes.find((w) => w.code === code);
  if (!waste) return 'Укажите общее количество участков.';
  return `Для отхода ${waste.code} (${waste.name || '—'}) указано «Все участки». Укажите общее количество участков.`;
}

async function handleSiteCountInput(project, state, answer, docsPath, now) {
  const queue = state.awaitingSiteCount?.queue || [];
  const index = state.awaitingSiteCount?.index ?? 0;
  const code = queue[index];
  const waste = state.wastes.find((w) => w.code === code);

  const count = String(answer).trim().replace(/\D/g, '');
  if (!count || !waste) {
    addAgentMessage(project, 'Введите число участков.', now);
    askUser(project, buildSiteCountQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  waste.siteCount = count;
  const extracted = state.extractedWasteList.find((w) => w.code === code);
  if (extracted) extracted.siteCount = count;

  await syncCode112ProjectPages(project, state, docsPath, now, {
    activateDocumentKey: 'sources',
    refreshSourcesContent: true,
    refreshWasteFormationContent: true,
  });

  const nextIndex = index + 1;
  if (nextIndex >= queue.length) {
    state.awaitingSiteCount = null;
    return startSourceQuantityCollection(project, state, docsPath, now);
  }

  state.awaitingSiteCount = { queue, index: nextIndex };
  askUser(project, buildSiteCountQuestion(state), [], now);
  project.updatedAt = now;
  return project;
}

async function startSourceQuantityCollection(project, state, docsPath, now) {
  const queue = state.wastes
    .filter((w) => w.sourceName && w.sourceName !== '—')
    .map((w) => w.code);
  if (!queue.length) {
    state.activeDocument = 'sources';
    askUser(project, 'Количества для источников не требуются. К чему теперь приступить?', menuOptions(), now);
    project.updatedAt = now;
    return project;
  }
  state.awaitingSourceQuantities = { queue, index: 0 };
  state.quantityInputMode = 'source';
  state.activeDocument = 'sources';
  askUser(project, buildSourceQuantityQuestion(state), [], now);
  project.updatedAt = now;
  return project;
}

export async function extractSourcesFromDocxBuffer(buffer) {
  console.log('[code112] extractSourcesFromDocxBuffer: converting DOCX to HTML');
  try {
    const { value: html } = await mammoth.convertToHtml({ buffer });
    console.log('[code112] extractSourcesFromDocxBuffer: HTML length', html.length);

    const $ = cheerio.load(html);
    const tableRows = [];
    let pending = [];

    $('table tr').each((rowIndex, rowEl) => {
      const cells = [];
      const nextPending = pending.map((q) => (q ? q.slice() : []));
      for (let col = 0; col < nextPending.length; col++) {
        if (nextPending[col]?.length > 0) {
          cells[col] = nextPending[col].shift();
        }
      }

      let col = 0;
      $(rowEl)
        .find('td, th')
        .each((i, cellEl) => {
          while (cells[col] !== undefined) col++;
          const text = $(cellEl).text().trim().replace(/\s+/g, ' ');
          const rowspan = parseInt($(cellEl).attr('rowspan')) || 1;
          const colspan = parseInt($(cellEl).attr('colspan')) || 1;
          for (let c = 0; c < colspan; c++) {
            cells[col + c] = text;
            for (let r = 1; r < rowspan; r++) {
              if (!nextPending[col + c]) nextPending[col + c] = [];
              nextPending[col + c].push(text);
            }
          }
          col += colspan;
        });

      for (let col = 0; col < cells.length; col++) {
        if (cells[col] === undefined) cells[col] = '';
      }

      pending = nextPending;
      tableRows.push(cells);
    });

    console.log('[code112] extractSourcesFromDocxBuffer: expanded table rows', tableRows.length);

    const headerPatterns = [
      /номер\s*источника/,
      /наименование\s*источника/,
      /корпус.*цех.*участок/,
      /код\s*отхода/,
      /наименование\s*отхода/,
      /количество\s*образующихся/,
    ];

    let headerIndex = -1;
    for (let i = 0; i < tableRows.length; i++) {
      const normalized = tableRows[i].map((c) => c.toLowerCase().replace(/[*\s]+/g, ' ').trim());
      const matches = headerPatterns.filter((p) => normalized.some((c) => p.test(c))).length;
      if (matches >= 4) {
        headerIndex = i;
        console.log('[code112] extractSourcesFromDocxBuffer: header row at index', i);
        break;
      }
    }

    if (headerIndex === -1) {
      console.warn('[code112] extractSourcesFromDocxBuffer: no header row found');
      return { rows: [] };
    }

    const rows = [];
    for (let i = headerIndex + 1; i < tableRows.length; i++) {
      const cells = tableRows[i];
      if (!cells.length || cells.every((c) => !c.trim())) continue;

      const first = cells[0].trim();
      if (!first || /^\s*(\*|«\*»)/.test(first)) continue;
      if (cells.every((c) => /^\d$/.test(c.trim()))) continue;
      if (first.toLowerCase().includes('в соответствии с') || first.startsWith('(')) continue;

      const sourceNumber = first.replace(/\D/g, '') || String(rows.length + 1);
      if (!sourceNumber) continue;

      const codeCell = cells[3] || '';
      const codeMatch = codeCell.match(/\b\d{7}\b/) || cells.join(' ').match(/\b\d{7}\b/);
      if (!codeMatch) continue;

      const sourceName = (cells[1] || '').trim() || '—';
      const site = (cells[2] || '').trim() || '—';
      const wasteName = (cells[4] || '').trim() || '—';
      const quantityCell = (cells[5] || '').trim();

      let quantity = '';
      let quantityRaw = quantityCell;
      const isDash =
        !quantityCell ||
        /[−–—−-]+|^\*+--\*+$/.test(quantityCell) ||
        quantityCell.toLowerCase().includes('--');
      if (isDash) {
        quantityRaw = '−';
      } else {
        const numMatch = quantityCell.match(/[\d\s,]+/);
        if (numMatch) {
          quantity = numMatch[0].replace(/\s/g, '').replace(',', '.');
        } else {
          quantityRaw = '−';
        }
      }

      rows.push({
        sourceNumber: String(parseInt(sourceNumber, 10) || sourceNumber),
        sourceName,
        site,
        code: codeMatch[0],
        wasteName,
        quantity,
        quantityRaw,
      });
    }

    console.log('[code112] extractSourcesFromDocxBuffer: parsed', rows.length, 'rows', rows.slice(0, 3));
    return { rows };
  } catch (error) {
    console.warn('[code112] extractSourcesFromDocxBuffer: error', error.message);
    return { rows: [] };
  }
}

function extractSourcesFromFile(text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    if (/^(\*|«\*»)/.test(line.trim()) || /^\*+\s*-/.test(line.trim())) continue;

    let parts;
    if (line.includes('\t') || line.includes(';') || line.includes('|')) {
      parts = line.split(/[\t;|]/).map((part) => part.trim()).filter(Boolean);
    } else {
      parts = line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
    }

    if (parts.length < 5) continue;
    if (!/^\d{1,3}$/.test(parts[0].replace(/\D/g, ''))) continue;

    const sourceNumber = parts[0].replace(/\D/g, '');
    const sourceName = parts[1];
    const site = parts[2];
    const codeMatch = parts[3].match(/\d{7}/);
    if (!codeMatch) continue;
    if (/наименование|код отхода/i.test(sourceName)) continue;
    const code = codeMatch[0];
    const wasteName = parts[4];
    const quantityCell = (parts[5] ?? '').trim();

    let quantity = '';
    let quantityRaw = quantityCell;
    const isDash =
      !quantityCell ||
      /[-–—\-]+|^–$|^-$|^\*\*/.test(quantityCell) ||
      quantityCell.toLowerCase().includes('--');
    if (isDash) {
      quantityRaw = '−';
    } else {
      const numMatch = quantityCell.match(/[\d\s,]+/);
      if (numMatch) {
        quantity = numMatch[0].replace(/\s/g, '').replace(',', '.');
        quantityRaw = quantity;
      } else {
        quantityRaw = '−';
      }
    }

    rows.push({
      sourceNumber: sourceNumber || String(rows.length + 1),
      sourceName: sourceName || '—',
      site: site || '—',
      code,
      wasteName: wasteName || '—',
      quantity,
      quantityRaw,
    });
  }

  return rows;
}

function splitCellHtml($, html) {
  if (!html) return [];
  const $wrapper = $('<div>').html(html);
  const lines = [];
  $wrapper.find('p, li').each((i, el) => {
    lines.push($(el).text().trim());
  });
  if (!lines.length) {
    const text = $wrapper.text().split(/\r?\n|<br\s*\/?>/i).map((t) => t.trim()).filter(Boolean);
    return text;
  }
  return lines.filter(Boolean);
}

function parseCompositionCell($, nameHtml, percentHtml) {
  const names = splitCellHtml($, nameHtml);
  const percents = splitCellHtml($, percentHtml);
  if (!names.length && !percents.length) return [];

  const hasName = names.some((n) => n.length > 0);
  if (hasName && !percents.length) {
    return names.map((name) => ({ name, percentage: '−' }));
  }

  const components = [];
  const max = Math.max(names.length, percents.length);
  for (let i = 0; i < max; i++) {
    const name = names[i] ?? '';
    const percentage = percents[i] ?? '';
    if (!name && !percentage) continue;
    components.push({
      name: name || '−',
      percentage: percentage || '−',
    });
  }
  return components;
}

export async function extractWasteFormationFromDocxBuffer(buffer) {
  console.log('[code112] extractWasteFormationFromDocxBuffer: converting DOCX to HTML');
  try {
    const { value: html } = await mammoth.convertToHtml({ buffer });
    console.log('[code112] extractWasteFormationFromDocxBuffer: HTML length', html.length);
    const $ = cheerio.load(html);

    const tableRows = [];
    const tableHtmls = [];
    let pending = [];
    let pendingHtml = [];

    $('table tr').each((rowIndex, rowEl) => {
      const cells = [];
      const htmls = [];
      const nextPending = pending.map((q) => (q ? q.slice() : []));
      const nextPendingHtml = pendingHtml.map((q) => (q ? q.slice() : []));

      for (let col = 0; col < nextPending.length; col++) {
        if (nextPending[col]?.length > 0) {
          cells[col] = nextPending[col].shift();
          htmls[col] = nextPendingHtml[col].shift();
        }
      }

      let col = 0;
      $(rowEl)
        .find('td, th')
        .each((i, cellEl) => {
          while (cells[col] !== undefined) col++;
          const text = $(cellEl).text().trim().replace(/\s+/g, ' ');
          const cellHtml = $(cellEl).html() || '';
          const rowspan = parseInt($(cellEl).attr('rowspan')) || 1;
          const colspan = parseInt($(cellEl).attr('colspan')) || 1;
          for (let c = 0; c < colspan; c++) {
            cells[col + c] = text;
            htmls[col + c] = cellHtml;
            for (let r = 1; r < rowspan; r++) {
              if (!nextPending[col + c]) nextPending[col + c] = [];
              if (!nextPendingHtml[col + c]) nextPendingHtml[col + c] = [];
              nextPending[col + c].push(text);
              nextPendingHtml[col + c].push(cellHtml);
            }
          }
          col += colspan;
        });

      for (let c = 0; c < cells.length; c++) {
        if (cells[c] === undefined) cells[c] = '';
        if (htmls[c] === undefined) htmls[c] = '';
      }

      pending = nextPending;
      pendingHtml = nextPendingHtml;
      tableRows.push(cells);
      tableHtmls.push(htmls);
    });

    console.log('[code112] extractWasteFormationFromDocxBuffer: expanded table rows', tableRows.length);

    const headerPatterns = [
      /код\s*отхода/,
      /наименование\s*отхода/,
      /агрегатное\s*состояние/,
      /состав\s*отходов/,
      /опасные\s*свойства/,
    ];

    let headerIndex = -1;
    for (let i = 0; i < tableRows.length; i++) {
      const normalized = tableRows[i].map((c) => c.toLowerCase().replace(/[\*\s]+/g, ' ').trim());
      const matches = headerPatterns.filter((p) => normalized.some((c) => p.test(c))).length;
      if (matches >= 3) {
        headerIndex = i;
        console.log('[code112] extractWasteFormationFromDocxBuffer: header row at index', i);
        break;
      }
    }

    if (headerIndex === -1) {
      console.warn('[code112] extractWasteFormationFromDocxBuffer: no header row found');
      return { rows: [] };
    }

    const rows = [];
    for (let i = headerIndex + 1; i < tableRows.length; i++) {
      const cells = tableRows[i];
      const htmls = tableHtmls[i];
      if (!cells.length || cells.every((c) => !c.trim())) continue;
      if (cells.every((c) => /^\d$/.test(c.trim()))) continue;
      if (cells.some((c) => c.toLowerCase().includes('в соответствии с'))) continue;

      const codeMatch = (cells[0] || '').match(/\b\d{7}\b/) || cells.join(' ').match(/\b\d{7}\b/);
      if (!codeMatch) continue;

      const code = codeMatch[0];
      const physicalState = (cells[7] ?? '').trim();
      const properties = (cells[10] ?? '').trim();
      const hazardClassText = (cells[11] ?? '').trim();
      const composition = parseCompositionCell($, htmls[8], htmls[9]);

      rows.push({ code, physicalState, properties, hazardClassText, composition });
    }

    console.log('[code112] extractWasteFormationFromDocxBuffer: parsed', rows.length, 'rows', rows.slice(0, 2));
    return { rows };
  } catch (error) {
    console.error('[code112] extractWasteFormationFromDocxBuffer: error', error);
    return { rows: [] };
  }
}

const NO_TOXICITY_CODES = new Set([
  '410401', '1410403', '1410404', '1410407', '1410600', '1410800', '1410801',
  '1410802', '1410804', '1411000', '1411900', '1470710', '1470711', '1470718',
  '1471500', '1719905',
]);

const LOWER_FLAMMABILITY_CODES = new Set(['470400', '1470714', '5810301', '5810501', '5810609']);

function matchesRule(code, rule) {
  const c = String(code);
  if (!c) return false;
  const block = Number(c[0]);
  const section = c.length >= 2 ? Number(c[1]) : null;
  const group = c.length >= 3 ? Number(c[2]) : null;
  if (rule.block != null && block !== rule.block) return false;
  if (rule.section != null && section !== rule.section) return false;
  if (rule.group != null && group !== rule.group) return false;
  return true;
}

function determineHazardProperties(code, hazardClass) {
  const c = String(code);
  const cls = normalizeHazardClass(hazardClass);

  if (cls === 'неопасные') {
    console.log('[code112] determineHazardProperties:', { code, class: cls, properties: '−' });
    return '−';
  }

  const properties = [];

  // п/п 1 – Экотоксичность
  const ecotoxicityRules = [
    { block: 3, section: 1 },
    { block: 5, section: 1, group: 1 },
    { block: 5, section: 1, group: 3 },
    { block: 5, section: 2, group: 7 },
    { block: 5, section: 4 },
    { block: 5, section: 9, group: 4 },
    { block: 5, section: 9, group: 5 },
    { block: 8 },
  ];
  if (ecotoxicityRules.some((rule) => matchesRule(c, rule))) {
    properties.push('Экотоксичность');
  }

  // п/п 2 – Токсичность
  const noToxicity = NO_TOXICITY_CODES.has(c)
    || matchesRule(c, { block: 1, section: 6 })
    || matchesRule(c, { block: 1, section: 7, group: 1 })
    || matchesRule(c, { block: 1, section: 7, group: 3 });
  if (!noToxicity && ['1', '2', '3', '4'].includes(cls)) {
    properties.push('Токсичность');
  }

  // п/п 3.1 – Взрывоопасность и пожароопасность по группам горючести
  const flammabilityGroupRules = [
    { block: 1, section: 4 },
    { block: 1, section: 6 },
    { block: 1, section: 7 },
    { block: 1, section: 8 },
    { block: 5, section: 3 },
    { block: 5, section: 7 },
    { block: 5, section: 8 },
    { block: 5, section: 9 },
  ];
  if (flammabilityGroupRules.some((rule) => matchesRule(c, rule))) {
    properties.push('Взрывоопасность и пожароопасность по группам горючести и токсичности продуктов горения');
  }

  // п/п 3.2 – Взрывоопасность и пожароопасность по температуре вспышки
  const flammabilityTempRules = [
    { block: 1, section: 2 },
    { block: 5, section: 4 },
    { block: 5, section: 5 },
  ];
  if (flammabilityTempRules.some((rule) => matchesRule(c, rule))) {
    properties.push('Взрывоопасность и пожароопасность по температуре вспышки и воспламенения');
  }

  // п/п 4 – Нижний концентрационный предел распространения пламени
  if (LOWER_FLAMMABILITY_CODES.has(c)) {
    properties.push('Нижний концентрационный предел распространения пламени');
  }

  // п/п 5 – Инфекционность
  if (matchesRule(c, { block: 7 })) {
    properties.push('Инфекционность');
  }

  const result = properties.length ? properties.join(' ') : '';
  console.log('[code112] determineHazardProperties:', { code, class: cls, properties: result });
  return result;
}

function formatComposition(components) {
  if (!components.length) return '';
  if (components.length === 1) {
    return `${components[0].name}`;
  }
  return components.map((c) => c.name).join('<br>');
}

function formatCompositionPercent(components) {
  if (!components.length) return '';
  if (components.length === 1) {
    return `${components[0].percentage ?? components[0].percent}`;
  }
  return components.map((c) => c.percentage ?? c.percent).join('<br>');
}

let compositionReferenceCache = null;

async function loadCompositionReference() {
  if (compositionReferenceCache) return compositionReferenceCache;
  try {
    await mkdir(path.dirname(COMPOSITION_PATH), { recursive: true });
    const text = await readFile(COMPOSITION_PATH, 'utf8');
    const data = JSON.parse(text);
    compositionReferenceCache = Array.isArray(data) ? data : [];
    return compositionReferenceCache;
  } catch (err) {
    console.warn('[code112] composition reference not found, creating empty', err.message);
    await mkdir(path.dirname(COMPOSITION_PATH), { recursive: true });
    await writeFile(COMPOSITION_PATH, '[]', 'utf8');
    compositionReferenceCache = [];
    return compositionReferenceCache;
  }
}

async function saveCompositionReference(data) {
  compositionReferenceCache = data;
  await mkdir(path.dirname(COMPOSITION_PATH), { recursive: true });
  await writeFile(COMPOSITION_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function parseMemberLine(line) {
  const text = String(line).trim();
  if (!text) return { position: 'Должность', name: 'И.О. Фамилия' };
  // Match "Position I.O. Surname" (initials with dot, possibly space)
  const match = text.match(/^(.*?)\s+([А-ЯЁ]\.\s*[А-ЯЁ]?\.?\s*\S+)$/);
  if (match) {
    return { position: match[1].trim(), name: match[2].trim() };
  }
  return { position: text, name: 'И.О. Фамилия' };
}

function extractTitleDataFromText(text) {
  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const data = {
    manager: null,
    chair: null,
    members: [],
    legalAddress: null,
    startDate: null,
    endDate: null,
  };

  let inMembers = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    if (lower.startsWith('руководитель:')) {
      data.manager = parseMemberLine(line.replace(/^руководитель:/i, ''));
      inMembers = false;
      continue;
    }
    if (lower.startsWith('председатель:')) {
      data.chair = parseMemberLine(line.replace(/^председатель:/i, ''));
      inMembers = false;
      continue;
    }
    if (lower.startsWith('члены:')) {
      inMembers = true;
      const after = line.replace(/^члены:/i, '').trim();
      if (after) {
        const parts = after.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
        for (const part of parts) {
          data.members.push(parseMemberLine(part));
        }
      }
      continue;
    }
    if (lower.startsWith('юридический адрес:')) {
      data.legalAddress = line.replace(/^юридический адрес:/i, '').trim();
      inMembers = false;
      continue;
    }
    if (lower.startsWith('инвентаризация:')) {
      const rangeText = line.replace(/^инвентаризация:/i, '').trim();
      const dates = rangeText.match(/\d{2}\.\d{2}\.\d{4}/g);
      if (dates && dates.length >= 2) {
        data.startDate = dates[0];
        data.endDate = dates[1];
      } else if (dates && dates.length === 1) {
        data.endDate = dates[0];
      }
      inMembers = false;
      continue;
    }

    if (inMembers) {
      data.members.push(parseMemberLine(line));
    }
  }

  return data;
}

async function extractTitleDataFromFile(buffer, fileType) {
  let text = '';
  const type = String(fileType ?? '').toLowerCase();
  if (type.includes('docx')) {
    const { value } = await mammoth.extractRawText({ buffer });
    text = value;
  } else if (type.includes('pdf')) {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      text = result.text ?? '';
    } finally {
      await parser.destroy();
    }
  } else if (Buffer.isBuffer(buffer)) {
    text = buffer.toString('utf8');
  } else {
    text = String(buffer ?? '');
  }
  return extractTitleDataFromText(text);
}

const parseTitleData = extractTitleDataFromText;

function applyTitleDataToState(state, data) {
  if (data.manager) {
    state.data.Должность_руководителя = data.manager.position;
    state.data.Инициалы_фамилия_руководителя = data.manager.name;
  }
  if (data.chair) {
    state.data.Должность_председателя = data.chair.position;
    state.data.Инициалы_фамилия_председателя = data.chair.name;
  }
  if (data.legalAddress) state.data.Юридический_адрес = data.legalAddress;
  if (data.startDate) state.data.Дата_начала = data.startDate;
  if (data.endDate) state.data.Дата_акта = data.endDate;
  if (data.members.length) {
    state.data.Комиссия = data.members.map((m) => `${m.position} - ${m.name}`).join('\n');
  }
}

function missingTitleDataFields(state) {
  const fields = [
    { key: 'manager', question: 'Укажите должность и инициалы с фамилией руководителя (например, Директор Д.В. Финевич).' },
    { key: 'legalAddress', question: 'Укажите юридический адрес организации.' },
    { key: 'startDate', question: 'Укажите дату начала инвентаризации в формате ДД.ММ.ГГГГ.' },
    { key: 'endDate', question: 'Укажите дату окончания инвентаризации в формате ДД.ММ.ГГГГ.' },
    { key: 'chair', question: 'Укажите должность и инициалы с фамилией председателя комиссии.' },
    { key: 'member0', question: 'Укажите должность и инициалы с фамилией первого члена комиссии.' },
    { key: 'member1', question: 'Укажите должность и инициалы с фамилией второго члена комиссии.' },
  ];
  const missing = [];
  for (const f of fields) {
    if (f.key === 'manager' && (!state.data.Должность_руководителя || !state.data.Инициалы_фамилия_руководителя)) missing.push(f);
    else if (f.key === 'legalAddress' && !state.data.Юридический_адрес) missing.push(f);
    else if (f.key === 'startDate' && !state.data.Дата_начала) missing.push(f);
    else if (f.key === 'endDate' && !state.data.Дата_акта) missing.push(f);
    else if (f.key === 'chair' && (!state.data.Должность_председателя || !state.data.Инициалы_фамилия_председателя)) missing.push(f);
    else if (f.key.startsWith('member')) {
      const members = resolveCommissionData(state.data).members;
      const index = Number(f.key.replace('member', ''));
      if (!members[index]) missing.push(f);
    }
  }
  return missing;
}

async function ensureTitleData(project, state, docsPath, now) {
  if (state.titleDataComplete) {
    console.log('[code112] ensureTitleData: title data already complete');
    return false;
  }
  if (!state.awaitingTitleData) {
    const missing = missingTitleDataFields(state);
    if (missing.length === 0) {
      state.titleDataComplete = true;
      console.log('[code112] ensureTitleData: all fields already present');
      return false;
    }
    state.awaitingTitleData = { missing, index: 0, pendingMore: false };
  }

  const q = state.awaitingTitleData.missing[state.awaitingTitleData.index];
  if (state.awaitingTitleData.pendingMore) {
    askUser(project, 'Хотите добавить еще одного члена комиссии?', confirmationOptions(), now);
  } else if (q) {
    await syncCode112ProjectPages(project, state, docsPath, now, { refreshAllPages: true });
    askUser(project, q.question, [], now);
  } else {
    // members done, ask for more
    state.awaitingTitleData.pendingMore = true;
    askUser(project, 'Хотите добавить еще одного члена комиссии?', confirmationOptions(), now);
  }
  project.updatedAt = now;
  state.updatedAt = now;
  return true;
}

async function applyTitleDataFromUpload(project, state, uploadIndex, docsPath, now, documentKey) {
  const uploads = Array.isArray(project.extractedData?.uploads) ? project.extractedData.uploads : [];
  const upload = uploads[uploadIndex];
  if (!upload) {
    askUser(project, 'Файл для титула не найден. Загрузите файл снова.', documentWorkOptions(state, documentKey), now);
    project.updatedAt = now;
    return project;
  }

  console.log('[code112] applyTitleDataFromUpload: parsing', upload.fileName);
  const data = extractTitleDataFromText(upload.text ?? '');
  state.titleData = data;
  applyTitleDataToState(state, data);
  state.files[documentKey].filledFromFile = true;
  state.files[documentKey].status = 'in_progress';
  state.titleDataComplete = false;
  state.updatedAt = now;

  const started = await ensureTitleData(project, state, docsPath, now);
  if (!started) {
    await syncCode112ProjectPages(project, state, docsPath, now, { refreshAllPages: true, activateDocumentKey: 'titleAct' });
    askUser(project, `Данные титула из файла «${upload.fileName}» применены. К чему теперь приступить?`, menuOptions(), now);
  }
  project.updatedAt = now;
  return project;
}

async function handleTitleDataInput(project, state, answer, docsPath, now) {
  const q = state.awaitingTitleData?.missing[state.awaitingTitleData.index];
  if (!q && !state.awaitingTitleData?.pendingMore) return project;

  if (state.awaitingTitleData.pendingMore) {
    const normalized = normalizeAnswer(answer);
    if (isYesAnswer(normalized)) {
      const members = resolveCommissionData(state.data).members;
      state.awaitingTitleData.index = state.awaitingTitleData.missing.length;
      state.awaitingTitleData.missing.push({
        key: `member${members.length}`,
        question: `Укажите должность и инициалы с фамилией ${members.length + 1}-го члена комиссии.`,
      });
      state.awaitingTitleData.pendingMore = false;
      await syncCode112ProjectPages(project, state, docsPath, now, { refreshAllPages: true });
      askUser(project, `Укажите должность и инициалы с фамилией ${members.length + 1}-го члена комиссии.`, [], now);
    } else if (isNoAnswer(normalized)) {
      state.awaitingTitleData = null;
      state.titleDataComplete = true;
      await syncCode112ProjectPages(project, state, docsPath, now, { refreshAllPages: true, activateDocumentKey: 'titleAct' });
      askUser(project, 'Данные титула сохранены. К чему теперь приступить?', menuOptions(), now);
    } else {
      askUser(project, 'Хотите добавить еще одного члена комиссии?', confirmationOptions(), now);
    }
    project.updatedAt = now;
    state.updatedAt = now;
    return project;
  }

  if (q.key === 'manager' || q.key === 'chair') {
    const member = parseMemberLine(answer);
    if (q.key === 'manager') {
      state.data.Должность_руководителя = member.position;
      state.data.Инициалы_фамилия_руководителя = member.name;
    } else {
      state.data.Должность_председателя = member.position;
      state.data.Инициалы_фамилия_председателя = member.name;
    }
  } else if (q.key === 'legalAddress') {
    state.data.Юридический_адрес = answer.trim();
  } else if (q.key === 'startDate' || q.key === 'endDate') {
    const dateText = answer.trim().match(/\d{2}\.\d{2}\.\d{4}/)?.[0] ?? answer.trim();
    if (q.key === 'startDate') state.data.Дата_начала = dateText;
    if (q.key === 'endDate') state.data.Дата_акта = dateText;
  } else if (q.key.startsWith('member')) {
    const member = parseMemberLine(answer);
    const current = resolveCommissionData(state.data);
    const existingMembers = current.members;
    const index = Number(q.key.replace('member', ''));
    if (existingMembers[index]) {
      existingMembers[index] = member;
    } else {
      existingMembers.push(member);
    }
    state.data.Комиссия = existingMembers.map((m) => `${m.position} - ${m.name}`).join('\n');
  }

  state.awaitingTitleData.index++;
  const next = state.awaitingTitleData.missing[state.awaitingTitleData.index];
  if (next) {
    await syncCode112ProjectPages(project, state, docsPath, now, { refreshAllPages: true });
    askUser(project, next.question, [], now);
  } else {
    // All base members entered, ask if more
    state.awaitingTitleData.pendingMore = true;
    await syncCode112ProjectPages(project, state, docsPath, now, { refreshAllPages: true });
    askUser(project, 'Хотите добавить еще одного члена комиссии?', confirmationOptions(), now);
  }
  project.updatedAt = now;
  state.updatedAt = now;
  return project;
}

async function applyWasteFormationFileData(project, state, uploadIndex, docsPath, now, bufferOverride = null) {
  const uploads = Array.isArray(project.extractedData?.uploads) ? project.extractedData.uploads : [];
  const upload = uploads[uploadIndex];
  if (!upload) {
    askUser(project, 'Файл для Сведений об образовании отходов не найден. Загрузите файл снова.', documentWorkOptions(state, 'wasteFormation'), now);
    project.updatedAt = now;
    return project;
  }

  const sourceBuffer = bufferOverride || upload.buffer;
  const { rows } = sourceBuffer
    ? await extractWasteFormationFromDocxBuffer(sourceBuffer)
    : { rows: [] };

  if (!rows.length) {
    console.warn('[code112] No waste formation rows found in uploaded file');
    askUser(project, 'Не удалось распознать таблицу Сведений об образовании отходов. Проверьте колонки: Код отхода, Состав, Содержание, %.', documentWorkOptions(state, 'wasteFormation'), now);
    project.updatedAt = now;
    return project;
  }

  console.log('[code112] Applying waste formation data', { fileName: upload.fileName, rows: rows.length });

  const compositionRef = await loadCompositionReference();
  const updatedRef = [...compositionRef];

  for (const row of rows) {
    const waste = state.wastes.find((w) => w.code === row.code);
    if (!waste) continue;

    if (row.composition?.length) {
      const names = formatComposition(row.composition);
      const percents = formatCompositionPercent(row.composition);
      if (names) waste.composition = names;
      if (percents) waste.compositionPercent = percents;

      const refIndex = updatedRef.findIndex((r) => r.code === row.code);
      const refEntry = {
        code: row.code,
        name: waste.name,
        components: row.composition,
      };
      if (refIndex >= 0) {
        updatedRef[refIndex] = refEntry;
      } else {
        updatedRef.push(refEntry);
      }
    }

    if (row.physicalState && (!waste.physicalState || waste.physicalState === 'не указано')) {
      waste.physicalState = row.physicalState;
    }
  }

  await saveCompositionReference(updatedRef);

  state.files.wasteFormation.filledFromFile = true;
  state.files.wasteFormation.status = 'in_progress';
  state.updatedAt = now;

  console.log('[code112] applyWasteFormationFileData: saved, starting waste formation data collection');
  const started = await ensureWasteFormationData(project, state, docsPath, now);
  if (!started) {
    await syncCode112ProjectPages(project, state, docsPath, now, {
      activateDocumentKey: 'wasteFormation',
      refreshWasteFormationContent: true,
    });
    askUser(
      project,
      `Все данные для страницы "Сведения о количестве" введены. К чему теперь приступить?`,
      documentWorkOptions(state, 'wasteFormation'),
      now
    );
  }
  project.updatedAt = now;
  return project;
}

function buildWasteFormationCompositionQuestion(state) {
  const queue = state.awaitingWasteFormationComposition?.queue || [];
  const index = state.awaitingWasteFormationComposition?.index ?? 0;
  const code = queue[index];
  const waste = state.wastes.find((w) => w.code === code);
  if (!waste) return 'Укажите состав отхода в формате "Компонент: процент; Компонент: процент".';
  return `Для отхода ${waste.code} (${waste.name || '—'}) не указан состав. Введите состав и процентное содержание в формате "Компонент1: процент; Компонент2: процент". Пример: "Резина: 82; Металл: 18". Если состав сложный и не поддаётся разбивке, введите "Сложнокомпонентный состав" — тогда в колонке 10 останется «−».`;
}

function parseCompositionInput(text) {
  const parts = String(text).split(/[;\n]/).map((p) => p.trim()).filter(Boolean);
  const components = [];
  for (const part of parts) {
    const match = part.match(/^(.+?):\s*([\d,\-]+)\s*%?$/);
    if (!match) return null;
    const name = match[1].trim();
    const percentage = String(match[2]).replace(',', '.');
    components.push({ name, percentage });
  }
  return components.length ? components : null;
}

async function handleWasteFormationCompositionInput(project, state, answer, docsPath, now) {
  const comp = state.awaitingWasteFormationComposition;
  if (!comp) return project;

  const normalized = normalizeAnswer(answer);
  const code = comp.queue[comp.index];
  const waste = state.wastes.find((w) => w.code === code);
  if (!waste) {
    comp.index++;
    if (comp.index >= comp.queue.length) {
      state.awaitingWasteFormationComposition = null;
      await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'wasteFormation', refreshWasteFormationContent: true });
      askUser(project, 'Состав всех отходов заполнен. К чему теперь приступить?', documentWorkOptions(state, 'wasteFormation'), now);
    } else {
      askUser(project, buildWasteFormationCompositionQuestion(state), [], now);
    }
    project.updatedAt = now;
    return project;
  }

  if (normalized === '−' || normalized === 'неданных' || normalized === 'нет' || answer.trim() === '−') {
    waste.composition = '−';
    waste.compositionPercent = '−';
    waste.compositionComponents = [];
  } else if (normalized === 'сложнокомпонентный состав' || answer.trim().toLowerCase() === 'сложнокомпонентный состав') {
    waste.composition = 'Сложнокомпонентный состав';
    waste.compositionPercent = '−';
    waste.compositionComponents = [];
  } else {
    const components = parseCompositionInput(answer);
    if (!components) {
      askUser(project, 'Не удалось разобрать состав. Используйте формат "Компонент: процент; Компонент: процент".', [], now);
      project.updatedAt = now;
      return project;
    }
    waste.composition = formatComposition(components);
    waste.compositionPercent = formatCompositionPercent(components);
    waste.compositionComponents = components;
    const ref = await loadCompositionReference();
    const idx = ref.findIndex((r) => r.code === waste.code);
    const entry = { code: waste.code, name: waste.name, components };
    if (idx >= 0) ref[idx] = entry; else ref.push(entry);
    await saveCompositionReference(ref);
  }

  comp.index++;
  if (comp.index >= comp.queue.length) {
    state.awaitingWasteFormationComposition = null;
    const started = await ensureWasteFormationData(project, state, docsPath, now);
    if (!started) {
      await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'wasteFormation', refreshWasteFormationContent: true });
      askUser(project, 'Состав всех отходов заполнен. К чему теперь приступить?', documentWorkOptions(state, 'wasteFormation'), now);
    }
  } else {
    await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'wasteFormation', refreshWasteFormationContent: true });
    askUser(project, buildWasteFormationCompositionQuestion(state), [], now);
  }
  project.updatedAt = now;
  return project;
}

function buildPhysicalStateQuestion(state) {
  const q = state.awaitingPhysicalState;
  if (!q) return 'Укажите физическое состояние отходов.';
  if (q.stage === 'confirm') {
    return 'Укажите физическое состояние отходов. По умолчанию все отходы — "твердые". Хотите изменить для каких-либо отходов?';
  }
  return 'Введите коды отходов, для которых нужно установить "жидкие", через запятую (например, 5410201, 5410202). Или введите "Все тв" для всех отходов (оставить "твердые") или "Все жд" для всех "жидкие".';
}

async function handlePhysicalStateInput(project, state, answer, docsPath, now) {
  const q = state.awaitingPhysicalState;
  if (!q) return project;

  const normalized = normalizeAnswer(answer);
  if (q.stage === 'confirm') {
    if (isNoAnswer(normalized)) {
      state.physicalStateConfirmed = true;
      state.wasteFormationDataComplete = true;
      state.awaitingPhysicalState = null;
      state.wastes.forEach((w) => { w.physicalState = w.physicalState || 'твердые'; });
      await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'wasteFormation', refreshWasteFormationContent: true });
      askUser(project, 'Физическое состояние сохранено. К чему теперь приступить?', documentWorkOptions(state, 'wasteFormation'), now);
      project.updatedAt = now;
      return project;
    }
    if (isYesAnswer(normalized)) {
      state.awaitingPhysicalState = { stage: 'codes' };
      await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'wasteFormation', refreshWasteFormationContent: true });
      askUser(project, buildPhysicalStateQuestion(state), [], now);
      project.updatedAt = now;
      return project;
    }
    askUser(project, buildPhysicalStateQuestion(state), confirmationOptions(), now);
    project.updatedAt = now;
    return project;
  }

  const lower = answer.toLowerCase().trim();
  if (lower === 'все тв' || lower === 'все твердые') {
    state.wastes.forEach((w) => { w.physicalState = 'твердые'; });
  } else if (lower === 'все жд' || lower === 'все жидкие') {
    state.wastes.forEach((w) => { w.physicalState = 'жидкие'; });
  } else {
    const entries = answer.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    for (const entry of entries) {
      const parts = entry.split(/\s+/);
      const code = parts[0];
      const token = parts.slice(1).join(' ').toLowerCase();
      const waste = state.wastes.find((w) => w.code === code);
      if (waste) {
        if (token.includes('жд') || token.includes('жидк')) {
          waste.physicalState = 'жидкие';
        } else if (token.includes('тв') || token.includes('тверд')) {
          waste.physicalState = 'твердые';
        } else {
          waste.physicalState = 'жидкие';
        }
      }
    }
  }

  state.physicalStateConfirmed = true;
  state.wasteFormationDataComplete = true;
  state.awaitingPhysicalState = null;
  await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'wasteFormation', refreshWasteFormationContent: true });
  askUser(project, 'Физическое состояние сохранено. К чему теперь приступить?', documentWorkOptions(state, 'wasteFormation'), now);
  project.updatedAt = now;
  return project;
}

async function ensureWasteFormationData(project, state, docsPath, now) {
  if (state.wasteFormationDataComplete) {
    console.log('[code112] ensureWasteFormationData: data collection already complete');
    return false;
  }

  const missingComposition = state.wastes.filter((w) => !w.composition);
  if (missingComposition.length && !state.awaitingWasteFormationComposition) {
    console.log('[code112] ensureWasteFormationData: missing composition for', missingComposition.map((w) => w.code).join(', '));
    state.awaitingWasteFormationComposition = {
      queue: missingComposition.map((w) => w.code),
      index: 0,
    };
    await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'wasteFormation', refreshWasteFormationContent: true });
    askUser(project, buildWasteFormationCompositionQuestion(state), [], now);
    return true;
  }

  if (!state.physicalStateConfirmed && !state.awaitingPhysicalState) {
    console.log('[code112] ensureWasteFormationData: requesting physical state confirmation');
    state.wastes.forEach((w) => { w.physicalState = w.physicalState || 'твердые'; });
    state.awaitingPhysicalState = { stage: 'confirm' };
    await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'wasteFormation', refreshWasteFormationContent: true });
    askUser(project, buildPhysicalStateQuestion(state), confirmationOptions(), now);
    return true;
  }

  return false;
}

function applyWasteFormationAnswer(state, answer) {
  const text = String(answer).trim();
  if (!text) return false;

  const lower = text.toLowerCase();

  // Physical state: all solid/liquid
  if (/^все\s*(?:тв|твердые)$/i.test(text)) {
    for (const waste of state.wastes) waste.physicalState = 'твердые';
    return true;
  }
  if (/^все\s*(?:жд|жидкие)$/i.test(text)) {
    for (const waste of state.wastes) waste.physicalState = 'жидкие';
    return true;
  }

  // codes + жд or тв
  const physicalMatch = text.match(/^([\d,;\s]+)\s+(?:тв|твердые)$/i);
  if (physicalMatch) {
    const codes = physicalMatch[1].split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
    for (const waste of state.wastes) {
      if (codes.includes(waste.code)) waste.physicalState = 'твердые';
    }
    return true;
  }
  const liquidMatch = text.match(/^([\d,;\s]+)\s+(?:жд|жидкие)$/i);
  if (liquidMatch) {
    const codes = liquidMatch[1].split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
    for (const waste of state.wastes) {
      if (codes.includes(waste.code)) waste.physicalState = 'жидкие';
    }
    return true;
  }

  // Composition for one code: 1720100: Древесина: 100
  const compositionLine = text.split(/\r?\n/).find((line) => /^\d{7}\s*[:\-]\s*.+/.test(line.trim()));
  if (compositionLine) {
    const [code, rest] = compositionLine.split(/[:\-]/, 2);
    const waste = state.wastes.find((w) => w.code === code.trim());
    if (waste && rest) {
      const components = rest
        .split(/[;\/]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const m = part.match(/^(.+?)\s*[:\-]?\s*(\d+(?:[,.]\d+)?)\s*%?$/);
          if (m) return { name: m[1].trim(), percent: m[2].replace('.', ',') };
          return { name: part, percent: '' };
        });
      if (components.length) {
        waste.composition = formatComposition(components);
        waste.compositionPercent = formatCompositionPercent(components);
        return true;
      }
    }
  }

  return false;
}

async function resolveWasteDisposalMethods(wastes, options = {}) {
  console.log('[code112] Resolving disposal methods for', wastes.length, 'wastes');
  const resolved = [];
  for (const waste of wastes) {
    if (waste.handling || waste.suggestedHandling) {
      console.log('[code112] Waste', waste.code, 'already has handling:', waste.handling || waste.suggestedHandling);
      resolved.push(waste);
      continue;
    }
    try {
      const result = await resolveDisposalMethod(waste.code, options);
      console.log('[code112] Resolved disposal for', waste.code, 'method:', result.method, 'source:', result.source);
      resolved.push({
        ...waste,
        suggestedHandling: result.method ?? '',
        handlingSource: result.source,
      });
    } catch (error) {
      console.warn('[code112] Не удалось определить способ обращения', waste.code, error);
      resolved.push({
        ...waste,
        suggestedHandling: waste.code === '9120400' ? '' : 'захоронение',
        handlingSource: 'default-after-error',
      });
    }
  }
  console.log('[code112] Disposal resolution completed, resolved:', resolved.length, 'wastes');
  return resolved;
}

async function askNextDisposalConfirmation(project, state, docsPath, now) {
  const index = state.extractedWasteList.findIndex((waste) => shouldConfirmDisposal(waste));
  if (index === -1) {
    state.pendingDisposalConfirmation = null;
    if (state.afterDisposalEdit) {
      state.afterDisposalEdit = false;
      console.log('[code112] All disposal methods confirmed during edit, syncing pages');
      return completeAppendixEditSync(project, state, docsPath, now);
    }
    if (state.completingAfterDisposal) {
      state.completingAfterDisposal = false;
      console.log('[code112] All disposal methods confirmed after normatives, finalizing');
      return completeExtractedWasteFill(project, state, docsPath, now);
    }
    state.pendingWasteImport = null;
    console.log('[code112] All disposal methods confirmed, starting normative collection');
    return startNormativeCollection(project, state, docsPath, now);
  }

  const waste = state.extractedWasteList[index];
  state.pendingDisposalConfirmation = { wasteKey: wasteKey(waste), createdAt: now };
  askUser(project, buildDisposalConfirmationQuestion(waste), disposalConfirmationOptions(waste), now);
  project.updatedAt = now;
  return project;
}

async function handleDisposalConfirmation(project, state, answer, docsPath, now) {
  console.log('[code112] Handling disposal confirmation:', answer);
  const pendingKey = state.pendingDisposalConfirmation?.wasteKey;
  const index = state.extractedWasteList.findIndex((waste) => wasteKey(waste) === pendingKey);
  console.log('[code112] Disposal pending key:', pendingKey, 'index:', index);
  if (index === -1) {
    state.pendingDisposalConfirmation = null;
    return askNextDisposalConfirmation(project, state, docsPath, now);
  }

  const normalized = normalizeAnswer(answer);
  const waste = state.extractedWasteList[index];
  const disposalOptionMap = { sorting: 'сортировка', reuse: 'использование', burial: 'захоронение' };
  const resolvedAnswer = disposalOptionMap[answer] ?? answer;
  const manualHandling = parseHandlingAnswer(resolvedAnswer);
  if (isYesAnswer(normalized) && waste.suggestedHandling) {
    state.extractedWasteList[index] = { ...waste, handling: waste.suggestedHandling, handlingConfirmed: true };
  } else if (isNoAnswer(normalized)) {
    state.extractedWasteList[index] = { ...waste, handling: '', handlingConfirmed: false };
  } else if (manualHandling) {
    state.extractedWasteList[index] = {
      ...waste,
      suggestedHandling: manualHandling,
      handling: manualHandling,
      handlingConfirmed: true,
      handlingSource: 'manual',
    };
  } else {
    askUser(project, buildDisposalConfirmationQuestion(waste), disposalConfirmationOptions(waste), now);
    project.updatedAt = now;
    return project;
  }

  // Keep state.wastes in sync so appendix columns 5–10 reflect the confirmed method
  const stateWasteIndex = state.wastes.findIndex((w) => wasteKey(w) === pendingKey);
  if (stateWasteIndex !== -1) {
    state.wastes[stateWasteIndex] = { ...state.wastes[stateWasteIndex], ...state.extractedWasteList[index] };
  }
  state.wastes = mergeWastes(state.wastes, state.extractedWasteList).sort(compareWasteCodes);

  await syncCode112ProjectPages(project, state, docsPath, now, {
    activateDocumentKey: 'appendix',
    refreshAppendixContent: true,
    refreshSourcesContent: true,
    refreshWasteFormationContent: true,
  });

  state.pendingDisposalConfirmation = null;
  project.updatedAt = now;
  return askNextDisposalConfirmation(project, state, docsPath, now);
}

const docsManualFieldDenylist = new Set(['Файл_DOCX', 'Итоги']);

export function parseManualInput(text, options = {}) {
  const fields = {};
  const wastes = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().replaceAll(' ', '_');
    const value = line.slice(separator + 1).trim();
    if (!key || !value) continue;
    if (options.ignoreTemplateInstructions && isTemplateInstructionField(line, key)) continue;
    if (options.ignoreTemplateInstructions && !isFilledTemplateValue(value)) continue;
    if (key.toLocaleLowerCase('ru-RU') === 'отход') {
      wastes.push(...parseWasteRows(value));
    } else {
      fields[key] = value;
    }
  }

  return { fields, wastes };
}

function isTemplateInstructionField(line, key) {
  return line.startsWith('`') || line.startsWith('|') || docsManualFieldDenylist.has(key);
}

export function parseWasteRows(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const parts = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/[;|]/)
      .map((part) => part.trim());
    if (parts.length < 2) continue;
    const [code, name, hazardClass = '', amount = '', unit = '', handling = '', source = '', physicalState = '', normative = ''] = parts;
    if (!/^\d{2,}$/.test(code)) continue;
    rows.push(normalizeWasteRow({ code, name, hazardClass, amount, unit, handling, source, physicalState, normative }));
  }

  return rows;
}

export function buildAppendixRows(wastes) {
  const rows = [];
  const grouped = groupWastesByHazard(wastes);

  for (const group of ['1', '2', '3', '4', 'неопасные', 'не указан']) {
    const items = grouped.get(group) ?? [];
    for (const item of items) rows.push(buildAppendixWasteRow(item));
    rows.push(buildTotalRow(group, items));
  }

  return rows;
}

export function extractWasteListFromText(text) {
  const byKey = new Map();
  const extractedRows = extractWasteDataFromText(text, WASTE_EXTRACTION_MODES.codesNames).map((waste) => ({
    code: waste.code,
    name: waste.name,
    normative: waste.norm ?? '',
    amount: waste.quantity ?? '',
  }));
  for (const waste of [...extractedRows, ...parseDelimitedWasteTable(text), ...parseWasteRows(text), ...parseInlineWasteRows(text)]) {
    const normalized = normalizeExtractedWaste(waste);
    if (!normalized) continue;
    byKey.set(`${normalized.code}:${normalizeAnswer(normalized.name)}`, normalized);
  }
  return [...byKey.values()].sort(compareWasteCodes);
}

export function groupWastesByClass(wasteList) {
  const groups = {
    1: [],
    2: [],
    3: [],
    4: [],
    'non-hazardous': [],
    unknown: [],
  };

  for (const waste of wasteList) {
    const classKey = normalizeHazardClass(waste.hazardClass);
    if (['1', '2', '3', '4'].includes(classKey)) groups[classKey].push(waste);
    else if (classKey === 'неопасные') groups['non-hazardous'].push(waste);
    else groups.unknown.push(waste);
  }

  for (const wastes of Object.values(groups)) wastes.sort(compareWasteCodes);
  return groups;
}

export async function enrichWasteListWithHazardClasses(wasteList, options = {}) {
  const classifierText = options.classifierText ?? await readWasteClassifierText();
  return wasteList.map((waste) => ({
    ...waste,
    hazardClass: normalizeHazardClass(
      waste.hazardClass && waste.hazardClass !== 'не указан'
        ? waste.hazardClass
        : findHazardClassByCode(classifierText, waste.code)
    ),
  }));
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
  if (!templatePath.endsWith('.docx')) {
    throw new Error(`Для code112 поддерживаются только DOCX-шаблоны: ${templatePath}`);
  }

  console.log('[code112] Загрузка DOCX-шаблона', { templatePath, outputPath });
  let buffer;
  try {
    buffer = await readFile(templatePath);
  } catch (error) {
    throw new Error(`DOCX-шаблон code112 не найден или недоступен: ${templatePath}`, { cause: error });
  }

  if (buffer.subarray(0, 2).toString('utf8') !== 'PK') {
    throw new Error(`Файл шаблона code112 не является DOCX: ${templatePath}`);
  }

  console.log('[code112] Применение меток DOCX-шаблона', {
    template: path.basename(templatePath),
    bytes: buffer.length,
    commissionRows: data.commission.length,
    wasteRows: data.wastes.length,
  });
  buffer = await applyInventoryDocxTemplate(buffer, path.basename(templatePath), data);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
  console.log('[code112] DOCX-файл сохранён', { outputPath, bytes: buffer.length });
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
  const sources = Array.isArray(data.sources) && data.sources.length ? data.sources : data.wastes;
  return sources.map((source, index) => ({
    номер_источника: source.sourceNumber ?? String(index + 1),
    источник: source.sourceName ?? source.источник ?? source.source ?? 'Источник не указан',
    участок: source.site ?? source.участок ?? 'Участок не указан',
    код: source.code,
    отход: source.wasteName ?? source.отход ?? source.name ?? 'Отход не указан',
    количество_кг_шт: source.quantity ?? source.quantityKg ?? source.количество_кг_шт ?? '[количество_кг_шт]',
  }));
}

function computeSiteCount(site, siteCount) {
  const sc = siteCount != null && String(siteCount).trim() ? String(siteCount).trim() : '';
  if (sc && !/^\[[^\]]+\]$/.test(sc)) return sc;
  const text = String(site || '').trim();
  if (!text || text === '−' || text === '-') return '[кол-во_участков]';
  if (/все\s*участки/i.test(text) || /весь\s*цех/i.test(text)) return '[кол-во_участков]';
  const parts = text.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  return String([...new Set(parts)].length);
}

function parseSourceQuantity(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/-?\d+(?:[,.]\d+)?/);
  const amount = match ? parseNumber(match[0]) : 0;
  const lower = text.toLowerCase();
  if (lower.includes('шт')) return { amount, unit: 'шт.' };
  if (lower.includes('т') && !lower.includes('кг')) return { amount, unit: 'т' };
  return { amount, unit: 'кг' };
}

function sourceQuantityToTons(value) {
  const text = String(value ?? '').trim();
  if (!text || text === '−' || text === '-' || isDashQuantity(text)) return '−';
  const { amount, unit } = parseSourceQuantity(text);
  if (!amount) return '−';
  if (unit === 'шт.') return `${formatNumber(amount)} шт.`;
  if (unit === 'т') return `${formatNumber(amount)}`;
  return `${formatNumber(amount / 1000)}`;
}

function wasteGenerationRows(data) {
  return data.wastes.map((waste) => ({
    код: waste.code,
    отход: waste.name,
    источник: waste.sourceName ?? waste.источник ?? waste.source ?? 'Источник не указан',
    'кол-во_участков': computeSiteCount(waste.site, waste.siteCount),
    количество_т_шт: sourceQuantityToTons(waste.quantityKg),
    количество: formatAmount(waste),
    норматив: parseNumber(waste.amount) > 0 ? (waste.normative || (waste.code === '9120400' ? '0,054 т / на 1 сотрудника в год' : DASH)) : DASH,
    физ_сост: (waste.physicalState && waste.physicalState !== 'не указано') ? waste.physicalState : 'твердые',
    состав: waste.composition || DASH,
    'состав_%': waste.compositionPercent || DASH,
    свойства: waste.properties || determineHazardProperties(waste.code, waste.hazardClass) || DASH,
    класс: getClassDescription(waste.hazardClass),
  }));
}

function appendixWasteVariables(waste) {
  const values = {
    код: waste.code,
    отход: waste.name,
    класс: getClassDescription(waste.hazardClass),
    норматив: waste.normative || (waste.code === '9120400' ? '0,054 т / на 1 сотрудника в год' : DASH),
    количество: formatAmount(waste),
    кол_заготовка: DASH,
    кол_сортировка: DASH,
    кол_использование: DASH,
    кол_обезвреживание: DASH,
    кол_хранение: DASH,
    кол_захоронение: DASH,
  };
  const activeHandling = parseNumber(waste.amount) > 0 ? (waste.handling || waste.suggestedHandling) : '';
  const key = handlingToAppendixKey(activeHandling);
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

async function resolveCode112Memory(userSources) {
  if (userSources.memory !== undefined) return userSources.memory;
  const memoryPath = userSources.memoryPath ?? process.env.USER_MEMORY_PATH ?? (userSources.loadDefaultMemory ? DEFAULT_MEMORY_PATH : '');
  if (!memoryPath) return null;
  return readUserMemory(memoryPath);
}

function ensureGeneratorState(project, now) {
  project.extractedData = project.extractedData && typeof project.extractedData === 'object' ? project.extractedData : {};
  if (!project.extractedData.code112 || typeof project.extractedData.code112 !== 'object') {
    console.log('[code112] Creating new code112 state');
    project.extractedData.code112 = {
      status: 'in_progress',
      startedAt: null,
      updatedAt: now,
      activeDocument: null,
      awaitingOrganizationName: false,
      pendingUploadDocumentSelection: null,
      pendingWasteExtraction: null,
      pendingWasteImport: null,
      pendingAppendixEdit: null,
      pendingSourcesEdit: null,
      afterDisposalEdit: false,
      completingAfterDisposal: false,
      pendingDisposalConfirmation: null,
      pendingSourcesExtraction: null,
      pendingWasteFormationExtraction: null,
      awaitingWasteFormationComposition: null,
      awaitingPhysicalState: null,
      physicalStateConfirmed: false,
      wasteFormationDataComplete: false,
      awaitingTitleData: null,
      titleDataComplete: false,
      pendingTitleExtraction: null,
      pendingFinalGeneration: null,
      titleData: null,
      awaitingWasteDetails: null,
      awaitingQuantities: null,
      awaitingNormatives: null,
      awaitingSourceDetails: null,
      pendingSourcesConfirmation: null,
      awaitingSiteCount: null,
      awaitingSourceQuantities: null,
      quantityInputMode: null,
      data: {},
      wastes: [],
      extractedWasteList: [],
      sources: [],
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
            filledFromFile: false,
          },
        ])
      ),
    };
  } else {
    console.log('[code112] Using existing code112 state');
    // Preserve existing data if it exists
    if (!project.extractedData.code112.data) {
      project.extractedData.code112.data = {};
    }
    // Ensure critical fields are initialized
    project.extractedData.code112.pendingUploadDocumentSelection = project.extractedData.code112.pendingUploadDocumentSelection ?? null;
    project.extractedData.code112.pendingWasteFormationExtraction = project.extractedData.code112.pendingWasteFormationExtraction ?? null;
    project.extractedData.code112.awaitingWasteFormationComposition = project.extractedData.code112.awaitingWasteFormationComposition ?? null;
    project.extractedData.code112.awaitingPhysicalState = project.extractedData.code112.awaitingPhysicalState ?? null;
    project.extractedData.code112.physicalStateConfirmed = project.extractedData.code112.physicalStateConfirmed ?? false;
    project.extractedData.code112.wasteFormationDataComplete = project.extractedData.code112.wasteFormationDataComplete ?? project.extractedData.code112.physicalStateConfirmed ?? false;
    project.extractedData.code112.awaitingTitleData = project.extractedData.code112.awaitingTitleData ?? null;
    project.extractedData.code112.titleDataComplete = project.extractedData.code112.titleDataComplete ?? false;
    project.extractedData.code112.pendingTitleExtraction = project.extractedData.code112.pendingTitleExtraction ?? null;
    project.extractedData.code112.pendingFinalGeneration = project.extractedData.code112.pendingFinalGeneration ?? null;
    project.extractedData.code112.titleData = project.extractedData.code112.titleData ?? null;
    project.extractedData.code112.startedAt = project.extractedData.code112.startedAt ?? null;
    project.extractedData.code112.status = project.extractedData.code112.status || 'in_progress';
    project.extractedData.code112.updatedAt = Number.isFinite(project.extractedData.code112.updatedAt) ? project.extractedData.code112.updatedAt : now;
    project.extractedData.code112.wastes = Array.isArray(project.extractedData.code112.wastes) ? project.extractedData.code112.wastes : [];
    if (!project.extractedData.code112.files) {
      project.extractedData.code112.files = Object.fromEntries(
        code112Documents.map((document) => [
          document.key,
          {
            key: document.key,
            label: document.label,
            status: 'pending',
            fileName: document.fileName,
            downloadUrl: null,
            generatedAt: null,
            filledFromFile: false,
          },
        ])
      );
    }
  }
  
  project.extractedData.code112.awaitingOrganizationName = Boolean(project.extractedData.code112.awaitingOrganizationName);
  project.extractedData.code112.pendingWasteExtraction = project.extractedData.code112.pendingWasteExtraction ?? null;
  project.extractedData.code112.pendingWasteImport = project.extractedData.code112.pendingWasteImport ?? null;
  project.extractedData.code112.pendingAppendixEdit = project.extractedData.code112.pendingAppendixEdit ?? null;
  project.extractedData.code112.afterDisposalEdit = project.extractedData.code112.afterDisposalEdit ?? false;
  project.extractedData.code112.completingAfterDisposal = project.extractedData.code112.completingAfterDisposal ?? false;
  project.extractedData.code112.pendingDisposalConfirmation = project.extractedData.code112.pendingDisposalConfirmation ?? null;
  project.extractedData.code112.pendingSourcesExtraction = project.extractedData.code112.pendingSourcesExtraction ?? null;
  project.extractedData.code112.pendingSourcesEdit = project.extractedData.code112.pendingSourcesEdit ?? null;
  project.extractedData.code112.awaitingWasteDetails = project.extractedData.code112.awaitingWasteDetails ?? null;
  project.extractedData.code112.awaitingQuantities = project.extractedData.code112.awaitingQuantities ?? null;
  project.extractedData.code112.awaitingNormatives = project.extractedData.code112.awaitingNormatives ?? null;
  project.extractedData.code112.awaitingSourceQuantities = project.extractedData.code112.awaitingSourceQuantities ?? null;
  project.extractedData.code112.quantityInputMode = project.extractedData.code112.quantityInputMode ?? null;
  project.extractedData.code112.extractedWasteList = Array.isArray(project.extractedData.code112.extractedWasteList)
    ? project.extractedData.code112.extractedWasteList.map(normalizeWasteRow).filter((waste) => waste.code)
    : [];
  
  console.log('[code112] State ensured, organization name:', project.extractedData.code112.data.Название_организации, 'startedAt:', project.extractedData.code112.startedAt);
  return project.extractedData.code112;
}

function mergeCollectedData(project, state, userSources) {
  const uploadedText = (Array.isArray(project.extractedData.uploads) ? project.extractedData.uploads : [])
    .map((upload) => upload.text)
    .filter((text) => typeof text === 'string')
    .join('\n');
  const manualText = typeof userSources.answer === 'string' ? userSources.answer : '';
  const parsed = parseManualInput(manualText);
  state.data = {
    ...extractFieldsFromSources(uploadedText),
    ...state.data,
    ...parsed.fields,
  };
  state.wastes = mergeWastes(state.wastes, parsed.wastes);
}

function buildStartMessage(state) {
  return [
    'Вы выбрали создание пакета документов для акта инвентаризации (код 112).',
    'Цэпик будет вести работу по пяти файлам и сохранять прогресс проекта.',
    'Сначала укажем организацию, затем я создам папку проекта и пять редактируемых страниц.',
    buildProgressMessage(state),
  ].join('\n');
}

function organizationNameQuestion() {
  return 'Укажите название организации, для которой разрабатывается документация.';
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
    'Отправьте данные строками вида «Поле: значение», загрузите файл-источник или используйте команду «Сгенерировать все» для финального DOCX.',
  ].join('\n');
}

function detectFileDocumentType(upload) {
  const fileName = String(upload?.fileName ?? '').toLowerCase();
  const text = String(upload?.text ?? '').toLowerCase();

  if (fileName.includes('источник')
    || text.includes('номер источника')
    || text.includes('наименование источника')
    || text.includes('корпус, цех, участок')) {
    return 'sources';
  }

  if (fileName.includes('образован')
    || fileName.includes('количество')
    || text.includes('состав отходов')
    || text.includes('агрегатное состояние')
    || text.includes('физико-химическая')) {
    return 'wasteFormation';
  }

  if (fileName.includes('прилож')
    || fileName.includes('отходы')
    || text.match(/\b\d{7}\b/)?.length > 0) {
    return 'appendix';
  }

  if (fileName.includes('мероприят')) {
    return 'measures';
  }

  if (fileName.includes('титул')
    || fileName.includes('акт')
    || text.includes('руководитель:')
    || text.includes('председатель:')
    || text.includes('члены:')
    || text.includes('юридический адрес:')
    || text.includes('инвентаризация:')) {
    return 'titleAct';
  }

  if (fileName.includes('мероприят') || text.includes('мероприятия') || text.includes('перечень мероприятий')) {
    return 'measures';
  }

  if (text.match(/\b\d{7}\b/)) return 'appendix';

  return null;
}

async function handleUseUploadedFile(project, state, document, docsPath, now) {
  const uploads = Array.isArray(project.extractedData?.uploads) ? project.extractedData.uploads : [];
  const lastUpload = uploads.at(-1);

  if (!lastUpload) {
    console.log('[code112] handleUseUploadedFile: no uploads, active document:', document.key);
    askUser(
      project,
      `Файл ещё не загружен. Загрузите файл для «${document.label}» и повторите «Заполнить из загруженного файла».`,
      documentWorkOptions(state, document.key),
      now
    );
    project.updatedAt = now;
    return project;
  }

  const detectedType = detectFileDocumentType(lastUpload);
  console.log('[code112] handleUseUploadedFile: active document:', document.key, ', file:', lastUpload.fileName, ', detected:', detectedType);

  if (detectedType !== document.key) {
    const actualLabel = detectedType ? (documentByKey.get(detectedType)?.label ?? 'неизвестен') : 'неизвестен';
    const message =
      document.key === 'sources'
        ? `Для страницы "Источники образования" требуется файл с данными источников (колонки: Номер источника, Наименование источника, Корпус, цех, участок, Код отхода, Наименование отхода, Количество). Загруженный файл, похоже, является ${actualLabel === 'Приложение к акту инвентаризации' ? 'Приложением к акту' : `«${actualLabel}»`}. Пожалуйста, загрузите правильный файл, и затем выберите "Заполнить из загруженного файла".`
        : `Для страницы «${document.label}» требуется файл с данными ${document.label}. Загруженный файл, похоже, является «${actualLabel}». Пожалуйста, загрузите правильный файл, и затем выберите «Заполнить из загруженного файла».`;
    askUser(project, message, documentWorkOptions(state, document.key), now);
    project.updatedAt = now;
    return project;
  }

  if (document.key === 'appendix') {
    return fillAppendixFromExtractedWastes(project, state, docsPath, now, { explicit: true, refreshAllPages: true });
  }

  if (document.key === 'sources') {
    state.pendingSourcesExtraction = {
      uploadIndex: uploads.length - 1,
      fileName: lastUpload.fileName,
      text: lastUpload.text ?? '',
      rows: null,
      createdAt: now,
    };
    state.files.sources.status = 'in_progress';
    return processPendingSourcesExtraction(project, state, 'all', now, { docsPath });
  }

  if (document.key === 'wasteFormation') {
    return applyWasteFormationFileData(project, state, uploads.length - 1, docsPath, now);
  }

  if (document.key === 'titleAct' || document.key === 'measures') {
    return applyTitleDataFromUpload(project, state, uploads.length - 1, docsPath, now, document.key);
  }

  askUser(
    project,
    `Заполнение файла «${document.label}» из загруженного файла пока не поддерживается.`,
    documentWorkOptions(state, document.key),
    now
  );
  project.updatedAt = now;
  return project;
}

async function finishActiveDocument(project, state, answer, outputDir, docsPath, now) {
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

  if (isGenerateAnswer(answer)) {
    if (state.extractedWasteList.length && !isWasteDataComplete(state)) {
      askUser(project, buildWasteDataIncompleteMessage(state), documentWorkOptions(state, document.key), now);
      return project;
    }
    state.activeDocument = null;
    state.pendingFinalGeneration = { outputDir, docsPath };
    askUser(project, 'Все данные внесены. Хотите сгенерировать DOCX?', confirmationOptions(), now);
    project.updatedAt = now;
    return project;
  }

  if (isUploadedWasteCommand(answer)) {
    return await handleUseUploadedFile(project, state, document, docsPath, now);
  }

  if (document.key === 'appendix' && (normalizeAnswer(answer) === 'createdraft' || normalizeAnswer(answer) === normalizeAnswer('Создать черновик'))) {
    return fillAppendixFromExtractedWastes(project, state, docsPath, now, { explicit: true, refreshAllPages: true });
  }

  if (document.key === 'wasteFormation' && applyWasteFormationAnswer(state, answer)) {
    await syncCode112ProjectPages(project, state, docsPath, now, {
      activateDocumentKey: 'wasteFormation',
      refreshWasteFormationContent: true,
    });
    askUser(project, `Данные для файла «${document.label}» сохранены. К чему теперь приступить?`, documentWorkOptions(state, document.key), now);
    project.updatedAt = now;
    return project;
  }

  const parsedAnswer = parseManualInput(answer);
  const directWasteRows = parseWasteRows(answer);
  const detailApplied = applyWasteDetailAnswer(state, answer);
  if (Object.keys(parsedAnswer.fields).length || parsedAnswer.wastes.length || directWasteRows.length || detailApplied) {
    state.data = {
      ...state.data,
      ...parsedAnswer.fields,
    };
    state.wastes = mergeWastes(state.wastes, [...parsedAnswer.wastes, ...directWasteRows]);
    await syncCode112ProjectPages(project, state, docsPath, now, {
      activateDocumentKey: document.key,
      refreshAppendixContent: document.key === 'appendix',
    });
    const nextQuestion = document.key === 'appendix' ? buildNextWasteDetailsQuestion(state) : '';
    askUser(project, nextQuestion || `Данные для файла «${document.label}» сохранены. К чему теперь приступить?`, nextQuestion ? documentWorkOptions(state, document.key) : menuOptions(), now);
    project.updatedAt = now;
    return project;
  }

  if (document.key === 'wasteFormation') {
    const started = await ensureWasteFormationData(project, state, docsPath, now);
    if (started) {
      project.updatedAt = now;
      return project;
    }
  }

  if ((document.key === 'titleAct' || document.key === 'measures') && state.awaitingTitleData) {
    return handleTitleDataInput(project, state, answer, docsPath, now);
  }

  if (document.key === 'titleAct' || document.key === 'measures') {
    const started = await ensureTitleData(project, state, docsPath, now);
    if (started) {
      project.updatedAt = now;
      return project;
    }
  }

  askUser(
    project,
    document.key === 'appendix'
      ? buildNextWasteDetailsQuestion(state) || 'Для финальной генерации отправьте «Сгенерировать все» или добавьте данные для приложения.'
      : buildDocumentQuestion(document, state),
    documentWorkOptions(state, document.key),
    now
  );
  project.updatedAt = now;
  return project;
}

async function fillAppendixFromExtractedWastes(project, state, docsPath, now, options = {}) {
  console.log('[code112] Filling appendix from extracted wastes', { 
    extractedCount: state.extractedWasteList.length,
    explicit: options.explicit,
    refreshAllPages: options.refreshAllPages
  });
  
  if (!state.extractedWasteList.length) {
    console.warn('[code112] No extracted wastes to fill appendix');
    state.pendingWasteImport = null;
    askUser(project, 'В загруженных файлах пока не найден список отходов. Загрузите DOCX, XLSX, CSV, TXT или PDF с колонками кода и наименования.', documentWorkOptions(state, 'appendix'), now);
    project.updatedAt = now;
    return project;
  }

  state.wastes = mergeWastes(state.wastes, state.extractedWasteList).sort(compareWasteCodes);
  console.log('[code112] Merged wastes count:', state.wastes.length);

  state.files.appendix.filledFromFile = true;
  state.pendingWasteImport = null;
  state.activeDocument = 'appendix';
  state.files.appendix.status = 'in_progress';
  state.awaitingWasteDetails = nextMissingWasteDetails(state.wastes);
  
  console.log('[code112] Starting quantity collection for extracted wastes');
  return startQuantityCollection(project, state, docsPath, now);
}

function startQuantityCollection(project, state, docsPath, now) {
  console.log('[code112] Starting quantity collection');
  state.awaitingWasteDetails = null;
  state.pendingWasteImport = null;
  state.activeDocument = 'appendix';
  state.files.appendix.status = 'in_progress';
  state.awaitingQuantities = { index: 0 };
  state.quantityInputMode = 'single';
  state.updatedAt = now;
  project.updatedAt = now;
  askUser(project, buildQuantityQuestion(state), [], now);
  return project;
}

function startsWithNumber(value) {
  return /^\d/.test(String(value).trim());
}

function hasNormativeMarker(value) {
  const normalized = ` ${normalizeAnswer(value)} `;
  return normalized.includes(' на ') || normalized.includes(' в год ');
}

function isDashQuantity(value) {
  const text = String(value).trim();
  return /^[−–—\-]+\*?$|^\*+--\*+$|^(\*\*)?--(\*\*)?$/i.test(text);
}

function validateQuantityText(value) {
  const text = String(value).trim();
  if (!text) return { valid: false, message: 'Введите значение.' };
  if (hasNormativeMarker(text)) {
    return {
      valid: false,
      message: 'Похоже, вы ввели норматив образования, а не годовое количество. Пожалуйста, введите годовое количество в виде числа (например, 10 т или 4,8).',
    };
  }
  if (!startsWithNumber(text)) {
    return {
      valid: false,
      message: 'Введите годовое количество числом, возможно с единицей (например, 10 т или 150 шт.).',
    };
  }
  return { valid: true };
}

function validateSourceQuantityText(value) {
  const text = String(value).trim();
  if (!text) return { valid: false, message: 'Введите значение или −.' };
  if (isDashQuantity(text)) return { valid: true };
  return validateQuantityText(value);
}

function validateNormativeText(value) {
  const text = String(value).trim();
  if (!text) return { valid: false, message: 'Введите значение.' };
  if (!startsWithNumber(text)) {
    return {
      valid: false,
      message: 'Норматив должен начинаться с числа (например, 0,0002 т на 1 т сырья).',
    };
  }
  if (!hasNormativeMarker(text)) {
    return {
      valid: false,
      message: 'Похоже, вы ввели годовое количество, а не норматив образования. Пожалуйста, введите норматив в формате: число единица на ... (например, 0,0002 т на 1 т сырья).',
    };
  }
  return { valid: true };
}

function buildSourceQuantityQuestion(state) {
  const queue = state.awaitingSourceQuantities?.queue || [];
  const index = state.awaitingSourceQuantities?.index ?? 0;
  const code = queue[index];
  const waste = state.wastes.find((w) => w.code === code);
  if (!waste) return 'Укажите количество образующихся отходов в кг (или шт.) для каждого источника.';
  const current = isFilledTemplateValue(waste.quantityKg) && !isDashQuantity(waste.quantityKg)
    ? `текущее: ${waste.quantityKg}`
    : 'текущее: −';
  return `Для отхода ${waste.code} (${waste.name}), источник «${waste.sourceName || '—'}», укажите количество образующихся отходов (кг или шт.). ${current}. Пример: 70 или 150 шт. Введите −, чтобы оставить без значения.`;
}

function parseSourceQuantityList(text) {
  const entries = [];
  const parts = String(text).split(/[;\n]/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^(\d{5,})\s*[:=]\s*(.+)$/);
    if (match) {
      entries.push({ code: match[1], quantity: match[2].trim() });
    }
  }
  return entries;
}

function applySourceQuantityToWaste(state, code, quantity) {
  const target = state.wastes.find((w) => w.code === code);
  const extractedTarget = state.extractedWasteList.find((w) => w.code === code);
  if (!target) {
    console.warn('[code112] Source quantity target not found:', code);
    return false;
  }
  const q = quantity.trim();
  const parsed = parseSourceQuantity(q);
  let stored = q;
  if (isMercuryWaste(target.code, target.name) && parsed.unit !== 'шт.') {
    stored = `${formatNumber(parsed.amount)} шт.`;
  }
  target.quantityKg = stored;
  if (extractedTarget) extractedTarget.quantityKg = stored;
  console.log('[code112] Source quantity set for', code, ':', stored);
  return true;
}

async function handleSourceQuantityInput(project, state, answer, docsPath, now) {
  console.log('[code112] Handling source quantity input:', answer);
  const list = parseSourceQuantityList(answer);
  let applied = 0;
  const invalidMessages = [];

  if (list.length) {
    for (const { code, quantity } of list) {
      const validation = validateSourceQuantityText(quantity);
      if (!validation.valid) {
        console.warn('[code112] Invalid source quantity for', code, ':', quantity, validation.message);
        invalidMessages.push(`${code}: ${validation.message}`);
        continue;
      }
      if (applySourceQuantityToWaste(state, code, quantity)) {
        applied++;
      } else {
        invalidMessages.push(`${code}: не удалось применить значение '${quantity}'`);
      }
    }
    console.log('[code112] Applied source quantities from list:', applied, 'of', list.length);
  } else if (/[;\n]/.test(String(answer).trim()) && !String(answer).includes(':') && !String(answer).includes('=')) {
    console.warn('[code112] Source quantity list without code:value separators:', answer);
    addAgentMessage(
      project,
      'Похоже, вы ввели несколько значений, но без кодов отходов. Пожалуйста, используйте формат: 1110406: 10; 5350202: 4.',
      now
    );
    askUser(project, buildSourceQuantityQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  } else {
    const validation = validateSourceQuantityText(answer);
    if (!validation.valid) {
      console.warn('[code112] Invalid source quantity input:', answer, validation.message);
      addAgentMessage(project, validation.message, now);
      askUser(project, buildSourceQuantityQuestion(state), [], now);
      project.updatedAt = now;
      return project;
    }
    const queue = state.awaitingSourceQuantities?.queue || [];
    const index = state.awaitingSourceQuantities?.index ?? 0;
    const currentCode = queue[index];
    if (currentCode && applySourceQuantityToWaste(state, currentCode, answer)) {
      applied++;
      console.log('[code112] Applied source quantity for', currentCode);
    } else {
      console.warn('[code112] Could not parse source quantity from:', answer);
      addAgentMessage(project, 'Не удалось распознать количество. Попробуйте, например, 70 или 150 шт.', now);
      askUser(project, buildSourceQuantityQuestion(state), [], now);
      project.updatedAt = now;
      return project;
    }
  }

  await syncCode112ProjectPages(project, state, docsPath, now, {
    activateDocumentKey: 'sources',
    refreshSourcesContent: true,
    refreshWasteFormationContent: true,
  });
  console.log('[code112] Страницы обновлены после ввода количеств по источникам');

  if (invalidMessages.length) {
    addAgentMessage(
      project,
      `Обработаны только корректные значения. Проверьте ошибки в списке:\n${invalidMessages.join('\n')}`,
      now
    );
    askUser(project, buildSourceQuantityQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  if (list.length) {
    console.log('[code112] Source quantity list processed');
    state.awaitingSourceQuantities = null;
    state.quantityInputMode = null;
    state.files.sources.status = 'ready';
    state.activeDocument = 'sources';
    askUser(project, 'Все количества по источникам сохранены. К чему теперь приступить?', menuOptions(), now);
    project.updatedAt = now;
    return project;
  }

  const queue = state.awaitingSourceQuantities?.queue || [];
  const nextIndex = (state.awaitingSourceQuantities?.index ?? 0) + 1;
  if (nextIndex >= queue.length) {
    console.log('[code112] All source quantities collected');
    state.awaitingSourceQuantities = null;
    state.quantityInputMode = null;
    state.files.sources.status = 'ready';
    state.activeDocument = 'sources';
    askUser(project, 'Все количества по источникам сохранены. К чему теперь приступить?', menuOptions(), now);
    project.updatedAt = now;
    return project;
  }

  state.awaitingSourceQuantities = { queue, index: nextIndex };
  askUser(project, buildSourceQuantityQuestion(state), [], now);
  project.updatedAt = now;
  return project;
}

async function handleQuantityInput(project, state, answer, docsPath, now) {
  console.log('[code112] Handling quantity input:', answer);
  const list = parseQuantityList(answer);
  let applied = 0;
  const invalidMessages = [];

  if (list.length) {
    resetAllQuantities(state);
    for (const { code, amount } of list) {
      const validation = validateQuantityText(amount);
      if (!validation.valid) {
        console.warn('[code112] Invalid quantity for', code, ':', amount, validation.message);
        invalidMessages.push(`${code}: ${validation.message}`);
        continue;
      }
      if (applyQuantityToWaste(state, code, amount)) {
        applied++;
      } else {
        invalidMessages.push(`${code}: не удалось применить значение '${amount}'`);
      }
    }
    console.log('[code112] Applied quantities from list:', applied, 'of', list.length);
  } else if (/[;\n]/.test(String(answer).trim()) && !String(answer).includes(':') && !String(answer).includes('=')) {
    console.warn('[code112] Quantity list without code:value separators:', answer);
    addAgentMessage(
      project,
      'Похоже, вы ввели несколько значений, но без кодов отходов. Пожалуйста, используйте формат: 1110406: 10; 5350202: 4,8.',
      now
    );
    askUser(project, buildQuantityQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  } else {
    const validation = validateQuantityText(answer);
    if (!validation.valid) {
      console.warn('[code112] Invalid quantity input:', answer, validation.message);
      addAgentMessage(project, validation.message, now);
      askUser(project, buildQuantityQuestion(state), [], now);
      project.updatedAt = now;
      return project;
    }
    const currentIndex = state.awaitingQuantities?.index ?? 0;
    const current = state.extractedWasteList[currentIndex];
    if (current && applyQuantityToWaste(state, current.code, answer)) {
      applied++;
      console.log('[code112] Applied quantity for', current.code);
    } else {
      console.warn('[code112] Could not parse quantity from:', answer);
      addAgentMessage(project, 'Не удалось распознать годовое количество. Попробуйте, например, 10 т или 150 шт.', now);
      askUser(project, buildQuantityQuestion(state), [], now);
      project.updatedAt = now;
      return project;
    }
  }

  // Update wastes and pages so the preview reflects entered quantities
  state.wastes = mergeWastes(state.wastes, state.extractedWasteList).sort(compareWasteCodes);
  await syncCode112ProjectPages(project, state, docsPath, now, {
    activateDocumentKey: 'appendix',
    refreshAllPages: true,
  });
  const updatedCodes = state.extractedWasteList.filter((w) => isFilledTemplateValue(w.amount)).map((w) => w.code);
  console.log('[code112] Обновлены годовые количества для отходов:', updatedCodes.length);
  console.log('[code112] Страницы обновлены после ввода количеств');

  // Do not advance if any list entries were invalid
  if (invalidMessages.length) {
    addAgentMessage(
      project,
      `Обработаны только корректные значения. Проверьте ошибки в списке:\n${invalidMessages.join('\n')}`,
      now
    );
    askUser(project, buildQuantityQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  // If a list was entered, treat it as the definitive set and move to normatives
  if (list.length) {
    console.log('[code112] Quantity list processed, proceeding to normative collection');
    state.awaitingQuantities = null;
    state.quantityInputMode = null;
    return startNormativeCollection(project, state, docsPath, now);
  }

  const nextIndex = state.extractedWasteList.findIndex((waste) => !isFilledTemplateValue(waste.amount));
  if (nextIndex === -1) {
    console.log('[code112] All quantities collected, proceeding to normative collection');
    state.awaitingQuantities = null;
    state.quantityInputMode = null;
    return startNormativeCollection(project, state, docsPath, now);
  }

  state.awaitingQuantities = { index: nextIndex };
  state.quantityInputMode = 'single';
  askUser(project, buildQuantityQuestion(state), [], now);
  project.updatedAt = now;
  return project;
}

function parseQuantityList(text) {
  const entries = [];
  const parts = String(text).split(/[;\n]/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^(\d{5,})\s*[:=]\s*(.+)$/);
    if (match) {
      entries.push({ code: match[1], amount: match[2].trim() });
    }
  }
  console.log('[code112] Parsed quantity list:', entries.length, 'entries');
  return entries;
}

function resetAllQuantities(state) {
  for (const waste of state.extractedWasteList) {
    waste.amount = '';
    waste.unit = 'т';
    waste.amountKg = 0;
  }
  for (const waste of state.wastes) {
    waste.amount = '';
    waste.unit = 'т';
    waste.amountKg = 0;
  }
  console.log('[code112] Cleared all quantities before applying list, count:', state.extractedWasteList.length);
}

function hasExplicitUnit(value) {
  return /(?:^|\d)\s*(?:шт|штук|т|тонн|кг|килограмм)/iu.test(String(value));
}

function applyQuantityToWaste(state, code, amountText) {
  const parsed = parseAmountWithUnit(amountText);
  if (!parsed.amount || !/^\d/.test(parsed.amount.replace(',', '.'))) {
    return false;
  }
  const target = state.extractedWasteList.find((waste) => waste.code === code);
  if (!target) {
    console.warn('[code112] Quantity code not found in extracted list:', code);
    return false;
  }
  const explicitUnit = hasExplicitUnit(amountText);
  let unit = parsed.unit;
  if (!explicitUnit && isMercuryWaste(target.code, target.name)) {
    unit = 'шт.';
  }
  target.amount = parsed.amount;
  target.unit = unit;
  target.amountKg = normalizeAmountKg(parsed.amount, unit);
  const stateWaste = state.wastes.find((waste) => waste.code === code && normalizeAnswer(waste.name) === normalizeAnswer(target.name));
  if (stateWaste) {
    stateWaste.amount = parsed.amount;
    stateWaste.unit = unit;
    stateWaste.amountKg = target.amountKg;
  }
  console.log('[code112] Quantity set for', code, ':', parsed.amount, unit);
  return true;
}

function buildQuantityQuestion(state) {
  const index = state.awaitingQuantities?.index ?? 0;
  const waste = state.extractedWasteList[index];
  if (!waste) {
    return 'Укажите годовое количество для каждого отхода. Пример: 0,054 т или 12 шт. Можно ввести список: 9120400: 0,054; 1140202: 1,2.';
  }
  return `Для отхода ${waste.code} (${waste.name}) укажите годовое количество. Пример: 0,054 т или 12 шт. Можно сразу ввести список: 9120400: 0,054; 1140202: 1,2.`;
}

async function startNormativeCollection(project, state, docsPath, now) {
  console.log('[code112] Starting normative collection');
  state.pendingDisposalConfirmation = null;
  const queue = state.extractedWasteList
    .filter((waste) => parseNumber(waste.amount) > 0)
    .map((waste) => waste.code)
    .sort((a, b) => String(a).localeCompare(String(b), 'ru', { numeric: true }));
  if (!queue.length) {
    console.log('[code112] No normatives needed (all zero quantities)');
    return completeExtractedWasteFill(project, state, docsPath, now);
  }
  const waste = state.extractedWasteList.find((w) => w.code === queue[0]);
  const needsInput = !isFilledTemplateValue(waste?.normative);
  state.awaitingNormatives = { queue, index: 0, needsInput };
  state.updatedAt = now;
  project.updatedAt = now;
  askUser(project, buildNormativeQuestion(state), [], now);
  return project;
}

function isConfirmedNormative(waste) {
  return Boolean(waste.normativeConfirmed);
}

async function handleNormativeInput(project, state, answer, docsPath, now) {
  console.log('[code112] Handling normative input:', answer);
  const queue = state.awaitingNormatives?.queue || [];
  const index = state.awaitingNormatives?.index ?? 0;
  const currentCode = queue[index];
  const current = currentCode ? state.extractedWasteList.find((waste) => waste.code === currentCode) : null;

  if (!current || parseNumber(current.amount) <= 0) {
    console.warn('[code112] No current waste for normative input, advancing');
    return advanceNormativeCollection(project, state, docsPath, now);
  }

  // If we are in confirmation mode (existing normative), handle yes/no first
  if (state.awaitingNormatives && !state.awaitingNormatives.needsInput) {
    const normalized = normalizeAnswer(answer);
    if (isYesAnswer(normalized)) {
      current.normativeConfirmed = true;
      console.log('[code112] Existing normative confirmed for', current.code);
      console.log('[code112] Обработан норматив для отхода', current.code, ', переходим к следующему');
      return advanceNormativeCollection(project, state, docsPath, now);
    }
    if (isNoAnswer(normalized)) {
      console.log('[code112] Existing normative rejected for', current.code, ', asking for new value');
      state.awaitingNormatives.needsInput = true;
      askUser(project, buildNormativeQuestion(state), [], now);
      project.updatedAt = now;
      return project;
    }
    // Any other input may be a new normative, treat as entering new value
    state.awaitingNormatives.needsInput = true;
  }

  let applied = 0;
  const invalidMessages = [];
  const list = parseNormativeList(answer);
  if (list.length) {
    for (const { code, normative } of list) {
      const validation = validateNormativeText(normative);
      if (!validation.valid) {
        console.warn('[code112] Invalid normative for', code, ':', normative, validation.message);
        invalidMessages.push(`${code}: ${validation.message}`);
        continue;
      }
      if (applyNormativeToWaste(state, code, normative)) {
        applied++;
      } else {
        invalidMessages.push(`${code}: не удалось применить норматив '${normative}'`);
      }
    }
    console.log('[code112] Applied normatives from list:', applied, 'of', list.length);
  } else if (/[;\n]/.test(String(answer).trim()) && !String(answer).includes(':') && !String(answer).includes('=')) {
    console.warn('[code112] Normative list without code:value separators:', answer);
    addAgentMessage(
      project,
      'Похоже, вы ввели несколько нормативов, но без кодов отходов. Пожалуйста, используйте формат: 1110406: 0,1 т на 1 т; 5350202: 0,0002 т на 1 т.',
      now
    );
    askUser(project, buildNormativeQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  } else if (isFilledTemplateValue(answer)) {
    const validation = validateNormativeText(answer);
    if (!validation.valid) {
      console.warn('[code112] Invalid normative input:', answer, validation.message);
      addAgentMessage(project, validation.message, now);
      askUser(project, buildNormativeQuestion(state), [], now);
      project.updatedAt = now;
      return project;
    }
    current.normative = answer.trim();
    current.normativeConfirmed = true;
    const stateWaste = state.wastes.find((waste) => waste.code === current.code && normalizeAnswer(waste.name) === normalizeAnswer(current.name));
    if (stateWaste) {
      stateWaste.normative = current.normative;
      stateWaste.normativeConfirmed = true;
    }
    applied++;
    console.log('[code112] Applied normative for', current.code);
  } else {
    console.warn('[code112] Could not parse normative from:', answer);
    addAgentMessage(project, 'Не удалось распознать норматив. Введите значение, например 0,1 т на 1 т продукции.', now);
    askUser(project, buildNormativeQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  if (!applied) {
    askUser(project, buildNormativeQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  // Sync pages so the preview reflects updated normatives
  state.wastes = mergeWastes(state.wastes, state.extractedWasteList).sort(compareWasteCodes);
  await syncCode112ProjectPages(project, state, docsPath, now, {
    activateDocumentKey: 'appendix',
    refreshAllPages: true,
  });
  console.log('[code112] Страницы обновлены после ввода нормативов');

  // Do not advance if any list entries were invalid
  if (invalidMessages.length) {
    addAgentMessage(
      project,
      `Обработаны только корректные нормативы. Проверьте ошибки в списке:\n${invalidMessages.join('\n')}`,
      now
    );
    askUser(project, buildNormativeQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  console.log('[code112] Обработан норматив для отхода', current.code, ', переходим к следующему');

  return advanceNormativeCollection(project, state, docsPath, now);
}

async function advanceNormativeCollection(project, state, docsPath, now) {
  const queue = state.awaitingNormatives?.queue || [];
  let i = (state.awaitingNormatives?.index ?? -1) + 1;
  while (i < queue.length) {
    const waste = state.extractedWasteList.find((w) => w.code === queue[i]);
    if (waste && parseNumber(waste.amount) > 0 && !waste.normativeConfirmed) break;
    i++;
  }
  if (i >= queue.length) {
    console.log('[code112] All normatives collected, completing appendix fill');
    state.awaitingNormatives = null;
    return completeExtractedWasteFill(project, state, docsPath, now);
  }

  const waste = state.extractedWasteList.find((w) => w.code === queue[i]);
  const needsInput = !isFilledTemplateValue(waste?.normative);
  state.awaitingNormatives = { queue, index: i, needsInput };
  askUser(project, buildNormativeQuestion(state), [], now);
  project.updatedAt = now;
  return project;
}

function parseNormativeList(text) {
  const entries = [];
  const parts = String(text).split(/[;\n]/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^(\d{5,})\s*[:=]\s*(.+)$/);
    if (match) {
      entries.push({ code: match[1], normative: match[2].trim() });
    }
  }
  console.log('[code112] Parsed normative list:', entries.length, 'entries');
  return entries;
}

function applyNormativeToWaste(state, code, normative) {
  const target = state.extractedWasteList.find((waste) => waste.code === code);
  if (!target || parseNumber(target.amount) <= 0) {
    console.warn('[code112] Normative target not found or zero quantity:', code);
    return false;
  }
  if (!isFilledTemplateValue(normative)) {
    return false;
  }
  target.normative = normative.trim();
  target.normativeConfirmed = true;
  const stateWaste = state.wastes.find((waste) => waste.code === code && normalizeAnswer(waste.name) === normalizeAnswer(target.name));
  if (stateWaste) {
    stateWaste.normative = target.normative;
    stateWaste.normativeConfirmed = true;
  }
  console.log('[code112] Normative set for', code, ':', target.normative);
  return true;
}

function buildNormativeQuestion(state) {
  const queue = state.awaitingNormatives?.queue || [];
  const index = state.awaitingNormatives?.index ?? 0;
  const code = queue[index];
  const waste = code ? state.extractedWasteList.find((w) => w.code === code) : null;
  if (!waste) {
    return 'Укажите норматив образования отхода. Пример: 0,0002 т на 1 т сырья.';
  }
  if (state.awaitingNormatives && !state.awaitingNormatives.needsInput && isFilledTemplateValue(waste.normative)) {
    return `Для отхода ${waste.code} (${waste.name}) указан норматив: ${waste.normative}. Оставить? Да / Нет`;
  }
  return `Для отхода ${waste.code} (${waste.name}) укажите норматив образования. Пример: 0,0002 т на 1 т сырья.`;
}

async function completeExtractedWasteFill(project, state, docsPath, now) {
  console.log('[code112] Completing appendix fill from extracted wastes');
  state.awaitingQuantities = null;
  state.quantityInputMode = null;
  state.awaitingNormatives = null;
  state.pendingDisposalConfirmation = null;
  state.pendingWasteImport = null;
  state.completingAfterDisposal = false;
  state.activeDocument = 'appendix';
  state.files.appendix.status = 'in_progress';
  state.updatedAt = now;

  const pendingDisposalIndex = state.extractedWasteList.findIndex((waste) => shouldConfirmDisposal(waste));
  if (pendingDisposalIndex !== -1) {
    state.completingAfterDisposal = true;
    console.log('[code112] Pending disposal confirmation found, asking before finalization');
    return askNextDisposalConfirmation(project, state, docsPath, now);
  }

  await syncCode112ProjectPages(project, state, docsPath, now, {
    activateDocumentKey: 'appendix',
    refreshAppendixContent: true,
    refreshSourcesContent: true,
    refreshWasteFormationContent: true,
  });

  const message = `Все нормативы внесены. Заполнил редактируемые страницы «Приложение к акту», «Источники образования» и «Образование отходов» данными из загруженного файла: ${state.extractedWasteList.length} отходов.`;
  console.log('[code112] Appendix filled successfully', { wastesCount: state.extractedWasteList.length });
  addAgentMessage(project, message, now);
  askUser(project, 'Все нормативы внесены. Отправьте «Сгенерировать все» для финальных DOCX.', menuOptions(), now);
  project.updatedAt = now;
  return project;
}

function buildWasteImportQuestion(state) {
  const count = state.pendingWasteImport?.count ?? state.extractedWasteList.length;
  return `Найдено ${count} отходов. Заполнить колонки 2–3 (код и наименование) в Приложении к акту?`;
}

function buildWasteReviewQuestion(state) {
  return [
    `Из файла извлечено ${state.extractedWasteList.length} отходов. Страницы (Приложение, Источники, Образование) обновлены.`,
    'Проверьте данные в предпросмотре.',
    'Всё верно? Да / Нет.',
  ].join('\n');
}

function buildWasteEditQuestion(state) {
  const list = state.extractedWasteList.map((w) => `${w.code} — ${w.name}`).join('\n');
  return [
    'Вы можете добавить или удалить отходы из списка. Введите команды:',
    'Добавить: 9120300; 3134200',
    'Удалить: 5820601; 1110406',
    'Готово — завершить редактирование и перейти к вводу годовых количеств.',
    '',
    'Текущий список:',
    list || '(список пуст)',
  ].join('\n');
}

async function handleWasteListEdit(project, state, answer, docsPath, now) {
  const normalized = normalizeAnswer(answer);
  console.log('[code112] Handling waste list edit:', answer);

  if (normalized === 'готово' || answer.trim().toLowerCase().startsWith('готово')) {
    console.log('[code112] Waste editing finished, starting quantity collection');
    state.pendingWasteImport = null;
    if (!state.extractedWasteList.length) {
      askUser(project, 'Список отходов пуст. Загрузите файл или добавьте отходы.', menuOptions(), now);
      project.updatedAt = now;
      return project;
    }
    return fillAppendixFromExtractedWastes(project, state, docsPath, now, { explicit: true, refreshAllPages: true });
  }

  const addMatch = answer.match(/добавить[:\s]*(.+)/iu);
  const removeMatch = answer.match(/удалить[:\s]*(.+)/iu);

  if (addMatch) {
    const codes = addMatch[1].split(/[;,\s]+/).map((c) => c.trim()).filter(Boolean).filter((c) => /^\d{5,}$/.test(c));
    if (codes.length) {
      const classifierText = await readWasteClassifierText();
      const newWastes = [];
      for (const code of codes) {
        if (state.extractedWasteList.some((w) => w.code === code)) continue;
        const entries = classifierEntriesForCode(classifierText, code);
        const firstEntry = entries[0] || '';
        const hazardClass = findHazardClassByCode(classifierText, code);
        const name = firstEntry ? extractWasteNameFromClassifierEntry(firstEntry, code) : `Отход ${code}`;
        if (!firstEntry) {
          console.warn('[code112] Waste name not found in classifier for code', code, ', using fallback');
        }
        console.log('[code112] Adding waste', code, 'name:', name, 'class:', hazardClass);
        const newWaste = normalizeWasteRow({
          code,
          name,
          hazardClass,
          amount: '',
          unit: '',
          handling: '',
          source: '',
          physicalState: '',
          normative: '',
        });
        newWastes.push(newWaste);
      }
      if (newWastes.length) {
        const resolved = await resolveWasteDisposalMethods(newWastes);
        state.extractedWasteList = mergeWastes(state.extractedWasteList, resolved).sort(compareWasteCodes);
        state.wastes = mergeWastes(state.wastes, resolved).sort(compareWasteCodes);
        console.log('[code112] Added wastes:', newWastes.map((w) => ({ code: w.code, name: w.name, hazardClass: w.hazardClass, handling: w.suggestedHandling })));
      }
      await syncCode112ProjectPages(project, state, docsPath, now, {
        refreshAppendixContent: true,
        refreshSourcesContent: true,
        refreshWasteFormationContent: true,
      });
    }
    askUser(project, buildWasteEditQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  if (removeMatch) {
    const codes = removeMatch[1].split(/[;,\s]+/).map((c) => c.trim()).filter(Boolean).filter((c) => /^\d{5,}$/.test(c));
    if (codes.length) {
      state.extractedWasteList = state.extractedWasteList.filter((w) => !codes.includes(w.code));
      state.wastes = state.wastes.filter((w) => !codes.includes(w.code));
      console.log('[code112] Removed wastes:', codes);
      await syncCode112ProjectPages(project, state, docsPath, now, {
        refreshAppendixContent: true,
        refreshSourcesContent: true,
        refreshWasteFormationContent: true,
      });
    }
    askUser(project, buildWasteEditQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  askUser(project, buildWasteEditQuestion(state), [], now);
  project.updatedAt = now;
  return project;
}

function hasAppendixData(state) {
  return state.extractedWasteList.some((waste) => parseNumber(waste.amount) > 0);
}

function hasSourcesData(state) {
  return state.wastes.some((w) => isFilledTemplateValue(w.sourceName) || isFilledTemplateValue(w.site));
}

function buildAppendixEditQuestion(state) {
  const stage = state.pendingAppendixEdit?.stage;
  if (stage === 'select') {
    return 'Что хотите изменить?';
  }
  return 'Для этого документа уже введены данные. Хотите что-то изменить?';
}

function appendixEditOptions(state) {
  if (state.pendingAppendixEdit?.stage === 'select') {
    return [
      { key: 'wasteList', label: 'Список отходов' },
      { key: 'quantities', label: 'Годовые количества' },
      { key: 'normatives', label: 'Нормативы' },
      { key: 'handling', label: 'Способы обращения' },
      { key: 'cancel', label: 'Отмена' },
    ];
  }
  return confirmationOptions();
}

async function completeAppendixEditSync(project, state, docsPath, now) {
  state.pendingAppendixEdit = null;
  state.activeDocument = null;
  state.wastes = mergeWastes(state.wastes, state.extractedWasteList).sort(compareWasteCodes);
  await syncCode112ProjectPages(project, state, docsPath, now, {
    activateDocumentKey: 'appendix',
    refreshAllPages: true,
  });
  askUser(project, 'Изменения сохранены. К чему теперь приступить?', menuOptions(), now);
  project.updatedAt = now;
  return project;
}

async function handleAppendixEdit(project, state, answer, docsPath, now) {
  const stage = state.pendingAppendixEdit?.stage;
  if (stage === 'confirm') {
    const normalized = normalizeAnswer(answer);
    if (isYesAnswer(normalized)) {
      state.pendingAppendixEdit = { stage: 'select' };
      askUser(project, buildAppendixEditQuestion(state), appendixEditOptions(state), now);
      project.updatedAt = now;
      return project;
    }
    if (isNoAnswer(normalized)) {
      return completeAppendixEditSync(project, state, docsPath, now);
    }
    askUser(project, buildAppendixEditQuestion(state), confirmationOptions(), now);
    project.updatedAt = now;
    return project;
  }

  const option = appendixEditOptions(state).find((o) => normalizeAnswer(answer) === o.key || normalizeAnswer(answer) === normalizeAnswer(o.label));
  if (!option || option.key === 'cancel') {
    return completeAppendixEditSync(project, state, docsPath, now);
  }

  state.pendingAppendixEdit = null;

  if (option.key === 'wasteList') {
    state.pendingWasteImport = { stage: 'edit' };
    askUser(project, buildWasteEditQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  if (option.key === 'quantities') {
    for (const waste of state.extractedWasteList) {
      waste.amount = '';
      waste.unit = 'т';
      waste.amountKg = 0;
      waste.normativeConfirmed = false;
    }
    for (const waste of state.wastes) {
      waste.amount = '';
      waste.unit = 'т';
      waste.amountKg = 0;
      waste.normativeConfirmed = false;
    }
    state.awaitingQuantities = { index: 0 };
    state.quantityInputMode = 'single';
    askUser(project, buildQuantityQuestion(state), [], now);
    project.updatedAt = now;
    return project;
  }

  if (option.key === 'normatives') {
    for (const waste of state.extractedWasteList) {
      waste.normativeConfirmed = false;
    }
    for (const waste of state.wastes) {
      waste.normativeConfirmed = false;
    }
    return startNormativeCollection(project, state, docsPath, now);
  }

  if (option.key === 'handling') {
    for (const waste of state.extractedWasteList) {
      waste.handling = '';
      waste.handlingConfirmed = false;
    }
    for (const waste of state.wastes) {
      waste.handling = '';
      waste.handlingConfirmed = false;
    }
    state.afterDisposalEdit = true;
    return askNextDisposalConfirmation(project, state, docsPath, now);
  }

  return completeAppendixEditSync(project, state, docsPath, now);
}

async function handleSourcesEdit(project, state, answer, docsPath, now) {
  const normalized = normalizeAnswer(answer);
  if (isYesAnswer(normalized)) {
    state.pendingSourcesEdit = null;
    state.activeDocument = 'sources';
    await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'sources', refreshSourcesContent: true });
    askUser(project, buildDocumentQuestion(documentByKey.get('sources'), state), documentWorkOptions(state, 'sources'), now);
    project.updatedAt = now;
    return project;
  }
  if (isNoAnswer(normalized)) {
    state.pendingSourcesEdit = null;
    state.activeDocument = null;
    await syncCode112ProjectPages(project, state, docsPath, now, { activateDocumentKey: 'sources', refreshSourcesContent: true });
    askUser(project, 'Текущие данные Источников образования сохранены. К чему теперь приступить?', menuOptions(), now);
    project.updatedAt = now;
    return project;
  }
  askUser(project, 'Для этого документа уже введены данные. Хотите что-то изменить?', confirmationOptions(), now);
  project.updatedAt = now;
  return project;
}

function shouldConfirmDisposal(waste) {
  if (waste.handlingConfirmed) return false;
  if (waste.handling) return false;
  return Boolean(waste.amount || waste.suggestedHandling || waste.code === '9120400');
}

function buildDisposalConfirmationQuestion(waste) {
  const method = waste.suggestedHandling || 'не определён';
  const column = disposalColumnNumber(method);
  if (waste.code === '9120400' || !waste.suggestedHandling) {
    return `Для отхода ${waste.code} (${waste.name}) требуется указать способ обращения вручную. Выберите: сортировка, использование, захоронение.`;
  }
  return `Для отхода ${waste.code} найден способ: ${method}. Годовое количество ${formatAmount(waste)} будет помещено в колонку ${column}. Подтвердить? Да / Нет / Изменить вручную.`;
}

function disposalColumnNumber(method) {
  const key = handlingToAppendixKey(method);
  return {
    кол_заготовка: '5',
    кол_сортировка: '6',
    кол_использование: '7',
    кол_обезвреживание: '8',
    кол_хранение: '9',
    кол_захоронение: '10',
  }[key] ?? '[номер]';
}

function wasteKey(waste) {
  return `${waste.code}:${normalizeAnswer(waste.name)}`;
}

function buildNextWasteDetailsQuestion(state) {
  const next = nextMissingWasteDetails(state.wastes);
  state.awaitingWasteDetails = next;
  if (!next) return '';

  const waste = state.wastes[next.index];
  return [
    `Для отхода ${waste.code} — ${waste.name} укажите недостающие данные.`,
    'Формат: «Норматив: 0,0002 т на 1 т сырья; Количество: 0,5 т; Способ: хранение».',
    'Можно отправить «Сгенерировать все», если хотите сформировать DOCX с текущими данными.',
  ].join('\n');
}

function nextMissingWasteDetails(wastes) {
  const index = wastes.findIndex((waste) => !isFilledTemplateValue(waste.normative) || !isFilledTemplateValue(waste.amount) || !isFilledTemplateValue(waste.handling));
  return index === -1 ? null : { index, code: wastes[index].code };
}

function applyWasteDetailAnswer(state, answer) {
  if (!state.awaitingWasteDetails) return false;
  const waste = state.wastes[state.awaitingWasteDetails.index];
  if (!waste) {
    state.awaitingWasteDetails = null;
    return false;
  }

  const fields = parseLooseFields(answer);
  let changed = false;
  if (fields.норматив) {
    waste.normative = fields.норматив;
    changed = true;
  }
  if (fields.количество) {
    const { amount, unit } = parseAmountWithUnit(fields.количество);
    waste.amount = amount;
    waste.unit = unit || waste.unit;
    waste.amountKg = normalizeAmountKg(waste.amount, waste.unit);
    changed = true;
  }
  if (fields.способ) {
    waste.handling = fields.способ;
    changed = true;
  }
  if (fields.источник) {
    waste.source = fields.источник;
    changed = true;
  }
  if (fields.физсост || fields.физическое_состояние) {
    waste.physicalState = fields.физсост ?? fields.физическое_состояние;
    changed = true;
  }

  state.awaitingWasteDetails = nextMissingWasteDetails(state.wastes);
  return changed;
}

async function generateDocuments(project, state, documents, outputDir, docsPath, now) {
  await syncProjectDataFromDocs(project, state, docsPath);
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

  await syncCode112ProjectPages(project, state, docsPath, now, {
    activateDocumentKey: (documents.find((document) => document.key === 'titleAct') ?? documents[0])?.key,
  });

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

async function archiveProjectInEcoProjects(projectsPath, projectId) {
  try {
    const raw = await readFile(projectsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.projects)) {
      const index = parsed.projects.findIndex((p) => p.id === projectId);
      if (index >= 0) {
        parsed.projects[index].status = 'completed';
        parsed.projects[index].archivedAt = Date.now();
      }
      const tmpPath = `${projectsPath}.tmp`;
      await writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`);
      await rename(tmpPath, projectsPath);
    }
  } catch (error) {
    console.warn('[code112] archiveProjectInEcoProjects failed', error.message);
  }
}

async function archiveProjectInDocs(project, state, docsPath, now) {
  const snapshot = await readDocsSnapshot(docsPath);
  const projectFolderId = `agent-${project.id}`;
  const year = new Date(now).getFullYear();
  const organizationName = state.data.Название_организации || projectFolderTitle(project, state, buildTemplateData(project, state)) || 'Новый проект';

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

  const projectFolderIndex = snapshot.folders.findIndex((f) => f.id === projectFolderId);
  if (projectFolderIndex >= 0) {
    snapshot.folders[projectFolderIndex].parentId = archiveProjectId;
  }

  if (snapshot.activePageId && snapshot.activePageId.startsWith(`agent-${project.id}-code112`)) {
    snapshot.activePageId = null;
  }

  await writeDocsSnapshot(docsPath, snapshot);
  console.log('[code112] Project archived to', archiveProjectId);
}

async function performFinalGenerationAndArchive(project, state, userSources, outputDir, docsPath, now) {
  await generateDocuments(project, state, code112Documents, outputDir, docsPath, now);
  await archiveProjectInDocs(project, state, docsPath, now);
  const agentProjectsPath = userSources.agentProjectsPath ?? path.join(path.dirname(docsPath), 'eco_projects.json');
  await archiveProjectInEcoProjects(agentProjectsPath, project.id);
  state.status = 'completed';
  askUser(project, 'Документы сгенерированы и помещены в архив. Работа завершена.', [], now);
  project.updatedAt = now;
  return project;
}

export async function syncCode112ProjectPages(project, state, docsPath, now, options = {}) {
  console.log('[code112] syncCode112ProjectPages: started', {
    projectId: project.id,
    organizationName: state.data.Название_организации,
    docsPath,
  });

  const snapshot = await readDocsSnapshot(docsPath);
  const data = buildTemplateData(project, state);
  
  // Ensure snapshot.pages is an array
  if (!Array.isArray(snapshot.pages)) {
    console.warn('[code112] syncCode112ProjectPages: snapshot.pages is not an array, initializing as empty array');
    snapshot.pages = [];
  }
  
  // Ensure snapshot.folders is an array
  if (!Array.isArray(snapshot.folders)) {
    console.warn('[code112] syncCode112ProjectPages: snapshot.folders is not an array, initializing as empty array');
    snapshot.folders = [];
  }
  
  ensureFolder(snapshot, {
    id: 'in-progress',
    title: 'В разработке',
    parentId: null,
    order: 2,
    isExpanded: true,
  });
  console.log('[code112] syncCode112ProjectPages: ensured in-progress folder');

  const projectFolderId = `agent-${project.id}`;
  const workFolderId = `agent-${project.id}-code112`;
  
  // Check if project folder exists
  const existingProjectFolder = snapshot.folders.find((folder) => folder.id === projectFolderId);
  if (!existingProjectFolder) {
    console.log('[code112] syncCode112ProjectPages: project folder missing, creating...', { projectFolderId });
  } else {
    console.log('[code112] syncCode112ProjectPages: project folder exists', { projectFolderId, title: existingProjectFolder.title });
  }
  
  const projectFolderName = state.data.Название_организации || projectFolderTitle(project, state, data) || 'Новый проект';
  ensureFolder(snapshot, {
    id: projectFolderId,
    title: projectFolderName,
    parentId: 'in-progress',
    order: nextOrder(snapshot.folders.filter((folder) => folder.parentId === 'in-progress')),
    isExpanded: true,
  });
  console.log('[code112] syncCode112ProjectPages: project folder created/updated', { projectFolderId, title: projectFolderName });
  
  ensureFolder(snapshot, {
    id: workFolderId,
    title: 'Акт инвентаризации',
    parentId: projectFolderId,
    order: 0,
    isExpanded: true,
  });
  console.log('[code112] syncCode112ProjectPages: work folder created/updated', { workFolderId });

  state.docs = {
    projectFolderId,
    workFolderId,
    updatedAt: now,
  };

  // Explicitly create all 5 project pages with logging
  const pageParentId = workFolderId;
  const addedKeys = [];
  for (let i = 0; i < code112Documents.length; i++) {
    const document = code112Documents[i];
    const pageId = code112PageId(project.id, document.key);
    console.log('[code112] syncCode112ProjectPages: adding page', document.key, '...');
    
    let existingPage = null;
    let existingPageIndex = -1;
    try {
      existingPageIndex = snapshot.pages.findIndex((item) => item && item.id === pageId);
      existingPage = existingPageIndex >= 0 ? snapshot.pages[existingPageIndex] : null;
    } catch (e) {
      console.warn('[code112] syncCode112ProjectPages: error finding existing page', document.key, e.message);
    }
    
    const refreshedContent = refreshedProjectPageContent(document, data, options);
    const templateContent = buildEditableTemplatePageContent(document);
    const file = state.files && state.files[document.key] ? state.files[document.key] : null;
    
    const page = {
      id: pageId,
      title: document.label,
      content: options.force ? (templateContent) : (refreshedContent ?? existingPage?.content ?? templateContent),
      parentId: pageParentId,
      order: i,
      createdAt: existingPage?.createdAt ?? now,
      updatedAt: now,
      templateValues: pageTemplateValues(document, data, file),
    };
    
    if (existingPageIndex === -1) {
      snapshot.pages.push(page);
      console.log('[code112] syncCode112ProjectPages: page', document.key, 'added');
    } else {
      snapshot.pages[existingPageIndex] = {
        ...existingPage,
        ...page,
      };
      console.log('[code112] syncCode112ProjectPages: page', document.key, 'updated');
    }
    addedKeys.push(document.key);
  }

  const pagesInWorkFolder = snapshot.pages.filter((page) => page && page.parentId === pageParentId).length;
  console.log('[code112] syncCode112ProjectPages: all', addedKeys.length, 'pages added/updated in', pageParentId, '(total in work folder:', pagesInWorkFolder, ')');

  // Set active page based on the requested document key
  if (options.activateDocumentKey) {
    const requestedPageId = code112PageId(project.id, options.activateDocumentKey);
    snapshot.activePageId = requestedPageId;
    console.log('[code112] syncCode112ProjectPages: activePageId set to', requestedPageId);
  }

  await writeDocsSnapshot(docsPath, snapshot);
  console.log('[code112] syncCode112ProjectPages: docs.json saved', { 
    activePageId: snapshot.activePageId, 
    projectFolderId,
    workFolderId,
    pages: addedKeys.length,
    pagesInWorkFolder,
    addedKeys,
    folders: snapshot.folders.length
  });
}

function refreshedProjectPageContent(document, data, options) {
  if (options.refreshAllPages) {
    if (document.key === 'appendix') return buildAppendixProjectPageContent(data);
    if (document.key === 'sources') return buildSourcesProjectPageContent(data);
    if (document.key === 'wasteFormation') return buildWasteFormationProjectPageContent(data);
    return null;
  }
  if (options.refreshAppendixContent && document.key === 'appendix') return buildAppendixProjectPageContent(data);
  if (options.refreshSourcesContent && document.key === 'sources') return buildSourcesProjectPageContent(data);
  if (options.refreshWasteFormationContent && document.key === 'wasteFormation') return buildWasteFormationProjectPageContent(data);
  return null;
}

async function syncProjectDataFromDocs(project, state, docsPath) {
  const snapshot = await readDocsSnapshot(docsPath);
  const pageTexts = code112Documents
    .map((document) => snapshot.pages.find((page) => page.id === code112PageId(project.id, document.key))?.content)
    .filter((content) => typeof content === 'string')
    .join('\n');
  if (!pageTexts) return;

  const parsed = parseManualInput(pageTexts, { ignoreTemplateInstructions: true });
  const fields = Object.fromEntries(
    Object.entries(parsed.fields).filter(([, value]) => isFilledTemplateValue(value))
  );
  state.data = {
    ...state.data,
    ...fields,
  };
  state.wastes = mergeWastes(state.wastes, parsed.wastes);
}

function code112PageId(projectId, documentKey) {
  return `agent-${projectId}-code112-${documentKey}`;
}

function projectFolderTitle(project, state, data) {
  const explicitName = state.data.Название_проекта || state.data.Имя_проекта || state.data.Проект;
  if (isFilledTemplateValue(explicitName)) return explicitName;
  if (isFilledTemplateValue(state.data.Название_организации)) return state.data.Название_организации;
  if (isFilledTemplateValue(data.organizationName) && data.organizationName !== 'Название организации не указано') {
    return data.organizationName;
  }
  return `Новый проект ${String(project.id).slice(0, 8)}`;
}

function buildEditableTemplatePageContent(document) {
  if (document.key === 'appendix') {
    return `# Приложение к акту

Файл DOCX: \`templates/docx/inventory_act/appendix_template.docx\`

Название организации: [название_организации]
Дата акта: [дата_акта]

## Строки отходов

Заполняйте строки через чат в формате:
\`Отход: код;наименование;класс;количество;единица;способ обращения;источник;физическое состояние\`

| Код | Отход | Класс | Норматив | Количество | Заготовка | Сортировка | Использование | Обезвреживание | Хранение | Захоронение |
|---|---|---|---|---|---|---|---|---|---|---|
| [код] | [отход] | [класс] | [норматив] | [количество] | [кол_заготовка] | [кол_сортировка] | [кол_использование] | [кол_обезвреживание] | [кол_хранение] | [кол_захоронение] |

Итоги: [сумма_кол4], [сумма_кол5], [сумма_кол6], [сумма_кол7], [сумма_кол8], [сумма_кол9], [сумма_кол10]
`;
  }

  if (document.key === 'sources') {
    return `# Источники образования отходов

Файл DOCX: \`templates/docx/inventory_act/sources_template.docx\`

Название организации: [название_организации]

| № источника | Источник | Участок | Код | Отход | Количество |
|---|---|---|---|---|---|
| [номер_источника] | [источник] | [участок] | [код] | [отход] | [количество_кг_шт] |
`;
  }

  if (document.key === 'wasteFormation') {
    return `# Образование отходов

Файл DOCX: \`templates/docx/inventory_act/waste_generation_template.docx\`

Название организации: [название_организации]

| Источник | Отход | Код | Класс | Количество | Физическое состояние | Состав | Норматив |
|---|---|---|---|---|---|---|---|
| [источник] | [отход] | [код] | [класс] | [количество] | [физ_сост] | [состав] | [норматив] |

Количество участков: [кол-во_участков]
Количество т/шт: [количество_т_шт]
Состав, %: [состав_%]
Свойства: [свойства]
`;
  }

  if (document.key === 'measures') {
    return `# Перечень мероприятий

Файл DOCX: \`templates/docx/inventory_act/measures_template.docx\`

Должность председателя: [должность_председателя]
Инициалы фамилия председателя: [инициалы_фамилия_председателя]
`;
  }

  return `# Титул акта

Файл DOCX: \`templates/docx/inventory_act/title_page_template.docx\`

Название организации: [название_организации]
Должность руководителя: [должность_руководителя]
Инициалы фамилия руководителя: [инициалы_фамилия_руководителя]
Юридический адрес: [юридический_адрес]
Дата акта: [дата_акта]
Дата начала: [дата_начала]
Должность председателя: [должность_председателя]
Инициалы фамилия председателя: [инициалы_фамилия_председателя]

## Комиссия

- [должность_члена_комиссии] — [инициалы_фамилия_члена_комиссии]
`;
}

function buildAppendixProjectPageContent(data) {
  console.log('[code112] Building appendix page content with', data.wastes.length, 'wastes');
  const groups = groupWastesByClass(data.wastes);
  console.log('[code112] Waste groups for appendix:', {
    class1: groups[1]?.length || 0,
    class2: groups[2]?.length || 0,
    class3: groups[3]?.length || 0,
    class4: groups[4]?.length || 0,
    nonHazardous: groups['non-hazardous']?.length || 0,
    unknown: groups.unknown?.length || 0
  });
  
  const groupBlocks = [
    ['1', '1 класс опасности', groups[1]],
    ['2', '2 класс опасности', groups[2]],
    ['3', '3 класс опасности', groups[3]],
    ['4', '4 класс опасности', groups[4]],
    ['non-hazardous', 'Неопасные отходы', groups['non-hazardous']],
    ['unknown', 'Класс опасности не указан', groups.unknown],
  ]
    .filter(([, , wastes]) => wastes.length)
    .map(([, title, wastes]) => {
      console.log('[code112] Building appendix group:', title, 'with', wastes.length, 'wastes');
      return buildAppendixGroupMarkdown(title, wastes);
    })
    .join('\n\n');

  console.log('[code112] Appendix page content built with', data.wastes.length, 'wastes total');
  return `# Приложение к акту

Файл DOCX: \`templates/docx/inventory_act/appendix_template.docx\`

Название организации: ${data.organizationName}
Дата акта: ${data.actDate}

## Строки отходов

${groupBlocks || 'Отходы пока не добавлены. Загрузите файл со списком отходов или отправьте строки через чат.'}

Итоги: ${appendixTotalsSummary(data.wastes)}
`;
}

function buildSourcesProjectPageContent(data) {
  const sources = [...data.wastes].sort(compareWasteCodes);
  console.log('[code112] Building sources page content with', sources.length, 'rows');
  const rows = sourceRows({ wastes: sources }).map((values, index) => {
    return `| ${[
      values.номер_источника || String(index + 1),
      values.источник || '—',
      values.участок || '—',
      values.код || '—',
      values.отход || '—',
      values.количество_кг_шт || '—',
    ].map(escapeMarkdownTableCell).join(' | ')} |`;
  });
  console.log('[code112] Sources page content built with', rows.length, 'rows');
  return `# Источники образования отходов

Файл DOCX: \`templates/docx/inventory_act/sources_template.docx\`

Название организации: ${data.organizationName}

| № источника | Источник | Участок | Код | Отход | Количество |
|---|---|---|---|---|---|
${rows.join('\n') || '| [номер_источника] | [источник] | [участок] | [код] | [отход] | [количество_кг_шт] |'}
`;
}

function buildWasteFormationProjectPageContent(data) {
  console.log('[code112] Building waste formation page content with', data.wastes.length, 'wastes');
  const wastes = [...data.wastes].sort(compareWasteCodes);
  const rows = wastes.map((waste) => {
    const values = wasteGenerationRows({ wastes: [waste] })[0];
    return `| ${[
      waste.code,
      waste.name,
      values.источник || '[источник]',
      values['кол-во_участков'] || '[кол-во_участков]',
      values.количество_т_шт || '[количество_т_шт]',
      values.количество || '[количество]',
      values.норматив || '[норматив]',
      values.физ_сост || '[физ_сост]',
      values.состав || '[состав]',
      values['состав_%'] || '[состав_%]',
      values.свойства || '[свойства]',
      values.класс || '[класс]',
    ].map(escapeMarkdownTableCell).join(' | ')} |`;
  });
  console.log('[code112] Waste formation page content built with', rows.length, 'rows');
  return `# Образование отходов

Файл DOCX: \`templates/docx/inventory_act/waste_generation_template.docx\`

Название организации: ${data.organizationName}

| Код | Отход | Источник | Кол-во участков | Количество т/шт | Количество | Норматив | Физическое состояние | Состав | Состав, % | Свойства | Класс |
|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n') || '| [код] | [отход] | [источник] | [кол-во_участков] | [количество_т_шт] | [количество] | [норматив] | [физ_сост] | [состав] | [состав_%] | [свойства] | [класс] |'}
`;
}

function buildAppendixGroupMarkdown(title, wastes) {
  return [
    `### ${title}`,
    '',
    '| Код | Отход | Класс | Норматив | Количество | Заготовка | Сортировка | Использование | Обезвреживание | Хранение | Захоронение |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...wastes.map((waste) => buildAppendixMarkdownRow(waste)),
  ].join('\n');
}

function buildAppendixMarkdownRow(waste) {
  const values = appendixWasteVariables(waste);
  const cells = [
    values.код,
    values.отход,
    getClassDescription(waste.hazardClass),
    values.норматив,
    values.количество,
    values.кол_заготовка,
    values.кол_сортировка,
    values.кол_использование,
    values.кол_обезвреживание,
    values.кол_хранение,
    values.кол_захоронение,
  ];
  return `| ${cells.map(escapeMarkdownTableCell).join(' | ')} |`;
}

function appendixTotalsSummary(wastes) {
  const totals = appendixTotalVariables(wastes);
  return [
    `колонка 4 — ${totals.сумма_кол4}`,
    `колонка 5 — ${totals.сумма_кол5}`,
    `колонка 6 — ${totals.сумма_кол6}`,
    `колонка 7 — ${totals.сумма_кол7}`,
    `колонка 8 — ${totals.сумма_кол8}`,
    `колонка 9 — ${totals.сумма_кол9}`,
    `колонка 10 — ${totals.сумма_кол10}`,
  ].join('; ');
}

function escapeMarkdownTableCell(value) {
  return String(value ?? '').replaceAll('|', '\\|');
}

function pageTemplateValues(document, data, file) {
  const firstWaste = [...data.wastes].sort((a, b) => a.code.localeCompare(b.code, 'ru'))[0];
  const firstWasteValues = firstWaste
    ? {
        ...appendixWasteVariables(firstWaste),
        ...sourceRows({ wastes: [firstWaste] })[0],
        ...wasteGenerationRows({ wastes: [firstWaste] })[0],
      }
    : {};
  const totals = document.key === 'appendix' ? appendixTotalVariables(data.wastes) : {};
  return {
    ...templateVariables(data),
    ...firstWasteValues,
    ...totals,
    ссылка_docx: file?.downloadUrl ?? '',
  };
}

function isFilledTemplateValue(value) {
  return typeof value === 'string' && value.trim() && !/^\[[^\]]+\]$/.test(value.trim());
}

export async function readDocsSnapshot(docsPath) {
  try {
    const parsed = JSON.parse(await readFile(docsPath, 'utf8'));
    return normalizeDocsSnapshot(parsed);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return structuredClone(defaultDocsSnapshot);
    }
    throw error;
  }
}

async function writeDocsSnapshot(docsPath, snapshot) {
  await mkdir(path.dirname(docsPath), { recursive: true });
  const tmpPath = `${docsPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(normalizeDocsSnapshot(snapshot), null, 2)}\n`);
  await rename(tmpPath, docsPath);
}

function normalizeDocsSnapshot(value) {
  return ensureDefaultDocsStructure({
    pages: Array.isArray(value?.pages) ? value.pages.map(normalizeDocPage) : [],
    folders: Array.isArray(value?.folders) ? value.folders.map(normalizeDocFolder) : [],
    activePageId: typeof value?.activePageId === 'string' || value?.activePageId === null ? value.activePageId : null,
  });
}

function ensureFolder(snapshot, folder) {
  const index = snapshot.folders.findIndex((item) => item.id === folder.id);
  if (index === -1) {
    snapshot.folders.push(folder);
    return;
  }
  snapshot.folders[index] = {
    ...snapshot.folders[index],
    ...folder,
    isExpanded: snapshot.folders[index].isExpanded,
  };
}

function normalizeDocPage(page) {
  return {
    id: String(page.id),
    title: String(page.title),
    content: String(page.content ?? ''),
    parentId: typeof page.parentId === 'string' ? page.parentId : null,
    order: Number.isFinite(page.order) ? page.order : 0,
    createdAt: Number.isFinite(page.createdAt) ? page.createdAt : Date.now(),
    updatedAt: Number.isFinite(page.updatedAt) ? page.updatedAt : Date.now(),
    ...(page.isTemplate === undefined ? {} : { isTemplate: Boolean(page.isTemplate) }),
    ...(page.templateVariables === undefined ? {} : { templateVariables: page.templateVariables }),
    ...(page.templateValues === undefined ? {} : { templateValues: normalizeTemplateValues(page.templateValues) }),
  };
}

function normalizeTemplateValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [String(key), item === null || item === undefined ? '' : String(item)])
  );
}

function normalizeDocFolder(folder) {
  return {
    id: String(folder.id),
    title: String(folder.title),
    parentId: typeof folder.parentId === 'string' ? folder.parentId : null,
    order: Number.isFinite(folder.order) ? folder.order : 0,
    isExpanded: Boolean(folder.isExpanded),
  };
}

function nextOrder(items) {
  return items.reduce((max, item) => Math.max(max, Number.isFinite(item.order) ? item.order : 0), -1) + 1;
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
  return path.join(outputDir, slugify(data.organizationName), project.id, slugify('Акт инвентаризации'));
}

function askUser(project, question, options, now) {
  const optionText = options.length ? `\n\nВарианты:\n${options.map((option) => `• ${option.label}`).join('\n')}` : '';
  addAgentMessage(project, `${question}${optionText}`, now);
}

function menuOptions() {
  return [
    ...code112Documents.map((document) => ({ key: document.key, label: document.label })),
    { key: 'generateAll', label: 'Закончить / Сгенерировать DOCX' },
    { key: 'pause', label: 'Остановиться и продолжить позже' },
  ];
}

function documentWorkOptions(state = null, docKey = null) {
  const options = [
    { key: 'useUploadedFile', label: 'Заполнить из загруженного файла' },
    { key: 'cancel', label: 'Отмена' },
    { key: 'pause', label: 'Остановиться и продолжить позже' },
  ];
  if (state?.files?.[docKey]?.filledFromFile) {
    return options.filter((o) => o.key !== 'useUploadedFile');
  }
  return options;
}

function confirmationOptions() {
  return [
    { key: 'yes', label: 'Да' },
    { key: 'no', label: 'Нет' },
  ];
}

function disposalConfirmationOptions(waste) {
  if (waste && (waste.code === '9120400' || !waste.suggestedHandling)) {
    return [
      { key: 'sorting', label: 'сортировка' },
      { key: 'reuse', label: 'использование' },
      { key: 'burial', label: 'захоронение' },
    ];
  }
  return [
    { key: 'yes', label: 'Да' },
    { key: 'no', label: 'Нет' },
    { key: 'manual', label: 'Изменить вручную' },
  ];
}

function isWasteDataComplete(state) {
  return (
    !state.awaitingQuantities &&
    !state.pendingDisposalConfirmation &&
    !state.awaitingNormatives &&
    !state.pendingWasteImport
  );
}

function buildWasteDataIncompleteMessage(state) {
  const parts = [];
  if (state.awaitingQuantities) parts.push('годовое количество отходов');
  if (state.pendingDisposalConfirmation) parts.push('подтверждение способа обращения');
  if (state.awaitingNormatives) parts.push('нормативы образования');
  if (state.pendingWasteImport) parts.push('заполнение приложения из загруженного файла');
  return `Прежде чем сгенерировать документы, дозаполните: ${parts.join(', ')}.`;
}

function isGenerateAnswer(answer) {
  const normalized = normalizeAnswer(answer);
  return ['generateall', 'finish', 'done'].includes(normalized)
    || normalized === normalizeAnswer('Сгенерировать все')
    || normalized === normalizeAnswer('Сгенерировать DOCX')
    || normalized === normalizeAnswer('Закончить');
}

function isFillTemplateAnswer(answer) {
  const normalized = normalizeAnswer(answer);
  return (normalized.includes('заполн') || normalized.includes('подстав') || normalized.includes('замен'))
    && (normalized.includes('метк') || normalized.includes('прилож') || normalized.includes('шаблон'));
}

function isRefreshReferencesAnswer(answer) {
  const normalized = normalizeAnswer(answer);
  return normalized.includes('обновить справочник') || normalized.includes('обновить справочники');
}

function isUploadedWasteCommand(answer) {
  const normalized = normalizeAnswer(answer);
  return normalized === 'useuploadedfile'
    || normalized.includes('используй загруж')
    || normalized.includes('использовать загруж')
    || normalized.includes('вставь отход')
    || normalized.includes('вставить отход')
    || normalized.includes('заполни приложение данными из файла')
    || normalized.includes('заполнить приложение данными из файла')
    || normalized.includes('заполни приложение из файла')
    || normalized.includes('заполнить приложение из файла');
}

function parseHandlingAnswer(answer) {
  const normalized = normalizeAnswer(answer);
  if (normalized === 'manual' || normalized.includes('изменить вручную')) return '';
  if (normalized.includes('заготов')) return 'заготовка';
  if (normalized.includes('сортиров')) return 'сортировка';
  if (normalized.includes('использ')) return 'использование';
  if (normalized.includes('обезвреж')) return 'обезвреживание';
  if (normalized.includes('хран')) return 'хранение';
  if (normalized.includes('захорон')) return 'захоронение';
  return '';
}

const documentAliases = new Map([
  ['titleAct', ['титул', 'титул акта']],
  ['appendix', ['приложение', 'приложение к акту']],
  ['sources', ['источники', 'источники образования']],
  ['wasteFormation', ['сведения', 'образование отходов', 'сведения о количестве']],
  ['measures', ['перечень', 'мероприятия', 'перечень мероприятий']],
]);

function findDocument(answer) {
  const normalized = normalizeAnswer(answer);
  const byAlias = [...documentAliases.entries()]
    .find(([, aliases]) => aliases.some((alias) => normalized === normalizeAnswer(alias)))?.[0];
  return documentByKey.get(answer) ?? documentByLabel.get(normalized) ?? documentByKey.get(byAlias);
}

function isStopAnswer(answer) {
  const normalized = normalizeAnswer(answer);
  return normalized === 'pause' || normalized === normalizeAnswer('Остановиться и продолжить позже') || normalized === normalizeAnswer('стоп');
}

function isOrganizationActionAnswer(answer) {
  const normalized = normalizeAnswer(answer);
  return Boolean(findDocument(answer))
    || isGenerateAnswer(answer)
    || isFillTemplateAnswer(answer)
    || isUploadedWasteCommand(answer)
    || normalized === 'createdraft'
    || normalized === normalizeAnswer('Создать черновик')
    || normalized === 'cancel'
    || normalized === normalizeAnswer('Отмена');
}

function extractOrganizationNameAnswer(answer) {
  const parsed = parseManualInput(answer);
  const explicitName = parsed.fields.Название_организации ?? parsed.fields.Организация;
  if (isFilledTemplateValue(explicitName)) return cleanupOrganizationName(explicitName);

  const match = answer.match(/(?:создадим\s+)?акт\s+инвентаризации\s+для\s+(.+)$/iu);
  if (match) {
    const tail = cleanupOrganizationName(match[1]);
    const quoted = tail.match(/[«"“]([^»"”]+)[»"”]/u);
    if (/^(?:ооо|зао|оао|ао|ип|общество|компания)(?:\s|$)/iu.test(tail)) return tail;
    return cleanupOrganizationName(quoted?.[1] ?? tail);
  }

  return cleanupOrganizationName(answer);
}

function cleanupOrganizationName(value) {
  return String(value)
    .trim()
    .replace(/^[—–-]\s*/u, '')
    .replace(/[.。]+$/u, '')
    .trim();
}

function hasOrganizationName(state) {
  return isFilledTemplateValue(state.data.Название_организации);
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

function parseLooseFields(text) {
  const fields = {};
  for (const chunk of String(text).split(/[;\n]/)) {
    const separator = chunk.indexOf(':');
    if (separator === -1) continue;
    const key = normalizeAnswer(chunk.slice(0, separator)).replaceAll(' ', '_');
    const value = chunk.slice(separator + 1).trim();
    if (!key || !value) continue;
    fields[key] = value;
  }
  return fields;
}

function parseAmountWithUnit(value) {
  const text = String(value).trim();
  const amount = text.match(/-?\d+(?:[,.]\d+)?/)?.[0]?.replace('.', ',') ?? text;
  const unit = normalizeUnit(text);
  return { amount, unit };
}

function parseDelimitedWasteTable(text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let header = null;

  for (const line of lines) {
    const delimiter = detectTableDelimiter(line);
    if (!delimiter) continue;
    const parts = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(delimiter)
      .map((part) => part.trim())
      .filter((part, index, array) => part || index > 0 && index < array.length - 1);
    if (parts.length < 2) continue;

    const normalizedParts = parts.map(normalizeAnswer);
    const codeIndex = normalizedParts.findIndex((part) => part.includes('код'));
    const nameIndex = normalizedParts.findIndex((part) => part.includes('наимен') || part.includes('отход'));
    if (codeIndex !== -1 && nameIndex !== -1) {
      header = { codeIndex, nameIndex };
      continue;
    }

    const effectiveCodeIndex = header?.codeIndex ?? 0;
    const effectiveNameIndex = header?.nameIndex ?? 1;
    const code = parts[effectiveCodeIndex];
    const name = parts[effectiveNameIndex];
    if (/^\d{5,}$/.test(code) && isFilledTemplateValue(name)) {
      rows.push({ code, name });
    }
  }

  return rows;
}

function detectTableDelimiter(line) {
  if (line.includes('|')) return /\|/;
  if (line.includes(';')) return /;/;
  if (line.includes('\t')) return /\t/;
  if (line.includes(',')) return /,/;
  return null;
}

function parseInlineWasteRows(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(\d{5,})\s+(.+)$/u);
      if (!match) return null;
      const name = cleanupWasteName(match[2]);
      if (!isFilledTemplateValue(name) || /^[-—\d\s.,]+$/.test(name)) return null;
      return { code: match[1], name };
    })
    .filter(Boolean);
}

function cleanupWasteName(value) {
  return String(value)
    .replace(/\s+(?:неопасные|первый|второй|третий|четвертый|четв[её]ртый|\d(?:-й)?\s+класс|\*)\b.*$/iu, '')
    .trim();
}

function normalizeExtractedWaste(waste) {
  const normalized = normalizeWasteRow({
    code: String(waste.code ?? '').trim(),
    name: String(waste.name ?? '').trim(),
    hazardClass: waste.hazardClass ?? '',
    amount: waste.amount ?? '',
    unit: waste.unit ?? '',
    handling: waste.handling ?? '',
    source: waste.source ?? '',
    physicalState: waste.physicalState ?? '',
    normative: waste.normative ?? '',
  });
  if (!/^\d{5,}$/.test(normalized.code) || !isFilledTemplateValue(normalized.name)) return null;
  return normalized;
}

async function readWasteClassifierText() {
  try {
    return await readFile(CLASSIFIER_TEXT_PATH, 'utf8');
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const buffer = await readWasteClassifierPdf();
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    await mkdir(path.dirname(CLASSIFIER_TEXT_PATH), { recursive: true });
    await writeFile(CLASSIFIER_TEXT_PATH, result.text);
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function readWasteClassifierPdf() {
  try {
    return await readFile(CLASSIFIER_PATH);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const response = await fetch(CLASSIFIER_URL);
  if (!response.ok) {
    throw new Error(`Не удалось скачать классификатор 3Т: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(CLASSIFIER_PATH), { recursive: true });
  await writeFile(CLASSIFIER_PATH, buffer);
  return buffer;
}

function isNotFoundError(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function findHazardClassByCode(classifierText, code) {
  const entries = classifierEntriesForCode(classifierText, code);
  let starFound = false;
  for (const entry of entries) {
    const hazardClass = extractHazardClassFromClassifierEntry(entry);
    if (!hazardClass) continue;
    if (hazardClass === '*') {
      starFound = true;
      continue;
    }
    return hazardClass;
  }
  return starFound ? 'не указан' : 'не указан';
}

function classifierEntriesForCode(classifierText, code) {
  const normalizedText = String(classifierText).replace(/\r/g, '\n');
  const matches = [...normalizedText.matchAll(new RegExp(`(?:^|\\n|\\s)${escapeRegExp(code)}\\s+`, 'g'))];
  return matches.map((match) => {
    const start = match.index ?? 0;
    const rest = normalizedText.slice(start + match[0].length);
    const nextCode = rest.search(/\n?\s*\d{7}\s+/);
    const end = nextCode > 0 ? start + match[0].length + nextCode : start + 900;
    return normalizedText.slice(start, end);
  });
}

function extractHazardClassFromClassifierEntry(entry) {
  const normalized = normalizeAnswer(entry);
  if (normalized.includes('неопас')) return 'неопасные';
  if (/(?:первый|1(?:-й)?\s+класс|1\s*класса)/u.test(normalized)) return '1';
  if (/(?:второй|2(?:-й)?\s+класс|2\s*класса)/u.test(normalized)) return '2';
  if (/(?:третий|3(?:-й)?\s+класс|3\s*класса)/u.test(normalized)) return '3';
  if (/(?:четв[её]ртый|4(?:-й)?\s+класс|4\s*класса)/u.test(normalized)) return '4';
  if (/\*/u.test(normalized)) return '*';
  return '';
}

function extractWasteNameFromClassifierEntry(entry, code) {
  const cleaned = entry.replace(/\r/g, ' ').replace(/\s+/g, ' ').trim();
  const codeRe = new RegExp('^' + escapeRegExp(code) + '\\s*', 'u');
  const withoutCode = cleaned.replace(codeRe, '').trim();
  const classMatch = withoutCode.match(/(?:^|\s)(?:первый|второй|третий|четв[её]ртый|неопасный|1(?:-й)?\s+класс|2(?:-й)?\s+класс|3(?:-й)?\s+класс|4(?:-й)?\s+класс|неопасные)(?=$|\s)/iu);
  const name = classMatch ? withoutCode.slice(0, classMatch.index).trim() : withoutCode.split(/\d{7}\s/).shift().trim();
  return name || `Отход ${code}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeWastes(existing, incoming) {
  const byCodeName = new Map();
  const existingArray = Array.isArray(existing) ? existing : [];
  const incomingArray = Array.isArray(incoming) ? incoming : [];
  console.log('[code112] mergeWastes: existing wastes:', existingArray.length, 'incoming wastes:', incomingArray.length);
  
  if (!Array.isArray(existing)) {
    console.warn('[code112] existing is not an array in mergeWastes, treating as empty array');
  }
  if (!Array.isArray(incoming)) {
    console.warn('[code112] incoming is not an array in mergeWastes, treating as empty array');
  }
  
  for (const waste of [...existingArray, ...incomingArray]) {
    byCodeName.set(`${waste.code}:${normalizeAnswer(waste.name)}`, waste);
  }
  console.log('[code112] mergeWastes: merged wastes count:', byCodeName.size);
  return [...byCodeName.values()];
}

function compareWasteCodes(a, b) {
  return String(a.code).localeCompare(String(b.code), 'ru', { numeric: true });
}

function normalizeWasteRow(row) {
  const mercuryUnit = isMercuryWaste(row.code, row.name);
  const unit = mercuryUnit ? 'шт.' : normalizeUnit(row.unit);
  const amount = row.amount || '';
  return {
    code: row.code,
    name: row.name || 'Наименование отхода не указано',
    hazardClass: normalizeHazardClass(row.hazardClass),
    amount,
    amountKg: normalizeAmountKg(amount, unit),
    unit,
    normative: row.normative || '',
    handling: row.handling || '',
    suggestedHandling: row.suggestedHandling || '',
    handlingSource: row.handlingSource || '',
    handlingConfirmed: Boolean(row.handlingConfirmed),
    source: row.source || '',
    sourceNumber: row.sourceNumber || '',
    sourceName: row.sourceName || '',
    site: row.site || '',
    quantityKg: row.quantityKg || '',
    physicalState: row.physicalState || 'не указано',
  };
}

function normalizeHazardClass(value) {
  const text = String(value).toLocaleLowerCase('ru-RU');
  if (text.includes('неопас') || text.includes('non-hazard')) return 'неопасные';
  const match = text.match(/[1-4]/);
  return match ? match[0] : 'не указан';
}

function getClassDescription(value) {
  const normalized = normalizeHazardClass(value);
  if (normalized === '1') return 'первый класс';
  if (normalized === '2') return 'второй класс';
  if (normalized === '3') return 'третий класс';
  if (normalized === '4') return 'четвертый класс';
  if (normalized === 'неопасные') return 'неопасные';
  return 'не указан';
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
  const row = [waste.code, waste.name, waste.normative || DASH, formatAmount(waste), DASH, DASH, DASH, DASH, DASH, DASH];
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
    cells: [hazardTotalLabel(group), '', totalText || DASH, totalText || DASH, DASH, DASH, DASH, DASH, DASH, DASH],
  };
}

function hazardTotalLabel(group) {
  if (group === 'неопасные') return 'Итого неопасных отходов';
  if (group === 'не указан') return 'Итого отходов с неуказанным классом опасности';
  return `Итого отходов ${group} класса опасности`;
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

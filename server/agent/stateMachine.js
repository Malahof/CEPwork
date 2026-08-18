import { randomUUID } from 'node:crypto';
import { code112FallbackMessage, generate as generateCode112, getCode112Options, getCode112Question } from './generators/code112.js';
import {
  buildMemoryLoadedMessage,
  buildMemorySystemPrompt,
  deleteInstruction,
  deleteOrganization,
  formatMemoryForChat,
  readUserMemory,
  saveInstruction,
  saveOrganization,
} from './memory.js';

const welcomeMessage = 'Цэпик ожидает ваших указаний для начала работы.';
const unsupportedDocumentationMessage = code112FallbackMessage;
const packageGeneratorCodes = new Set(['112']);

const packageDefinitions = {
  instruction: {
    code: '111',
    title: 'Инструкция',
    documents: ['Инструкция', 'Заявление'],
  },
  inventoryAct: {
    code: '112',
    title: 'Акт инвентаризации',
    documents: [
      'Титул акта',
      'Приложение к акту',
      'Источники образования',
      'Образование отходов',
      'Список мероприятий',
    ],
  },
  disposalPermit: {
    code: '113',
    title: 'Разрешение на захоронение',
    documents: [
      'Титул акта',
      'Приложение к акту',
      'Источники образования',
      'Образование отходов',
      'Список мероприятий',
      'Заявление на захоронение',
      'Расчет годового объема',
      'Сопроводительное письмо',
    ],
  },
  simpleWasteSet: {
    code: '114',
    title: 'Простой комплект',
    documents: ['Инструкция', 'Акт инвентаризации'],
  },
  fullWasteSet: {
    code: '115',
    title: 'Полный комплект',
    documents: ['Инструкция', 'Разрешение на захоронение'],
  },
  pod10: {
    code: '121',
    title: 'Книга ПОД-10',
    documents: ['ПОД-10'],
  },
  pod9Pod10: {
    code: '122',
    title: 'Книги ПОД-9 и ПОД-10',
    documents: ['ПОД-9', 'ПОД-10'],
  },
  pod123: {
    code: '21',
    title: 'ПОД-1, ПОД-2, ПОД-3',
    documents: ['ПОД-1', 'ПОД-2', 'ПОД-3'],
  },
  pod4: {
    code: '22',
    title: 'ПОД-4',
    documents: ['ПОД-4'],
  },
  emissionsSet: {
    code: '23',
    title: 'Комплект по выбросам',
    documents: ['ПОД-1', 'ПОД-2', 'ПОД-3', 'ПОД-4'],
  },
  penInstruction: {
    code: '311',
    title: 'Инструкция ПЭН',
    documents: [
      'Инструкция',
      'Учет отчетности',
      'Акт ПН',
      'План-график ПН',
      'Годовой план',
      'Образец журнала инструктажа',
      'Журнал ПН',
      'Инструктаж',
      'Образец предписания',
    ],
  },
  ecoPassport: {
    code: '312',
    title: 'Экологический паспорт',
    documents: ['Экологический паспорт'],
  },
  complexSupportAccounting: {
    code: '32',
    title: 'Сопровождение: учет отчетности',
    documents: ['Учет отчетности'],
  },
  complexSupportAct: {
    code: '32',
    title: 'Сопровождение: акт ПН',
    documents: ['Акт ПН'],
  },
  complexSupportSchedule: {
    code: '32',
    title: 'Сопровождение: план-график ПН',
    documents: ['План-график ПН'],
  },
  complexSupportAnnualPlan: {
    code: '32',
    title: 'Сопровождение: годовой план',
    documents: ['Годовой план'],
  },
};

const agentTree = {
  sphere: {
    key: 'sphere',
    question: 'Начинаем новый проект. Выберите сферу экологической документации.',
    options: [
      { key: 'waste', label: 'Отходы', nextNode: 'wasteDirection' },
      { key: 'emissions', label: 'Выбросы', nextNode: 'emissionsPackage' },
      { key: 'complex', label: 'Комплекс', nextNode: 'complexDirection' },
    ],
  },
  wasteDirection: {
    key: 'wasteDirection',
    question: 'Выбрана сфера «Отходы». Выберите направление работы.',
    options: [
      { key: 'development', label: 'Разработка', nextNode: 'wasteDevelopmentPackage' },
      { key: 'support', label: 'Сопровождение', nextNode: 'wasteSupportPackage' },
    ],
  },
  wasteDevelopmentPackage: {
    key: 'wasteDevelopmentPackage',
    question: 'Выберите пакет документации по отходам для разработки.',
    options: [
      { key: 'instruction', label: 'Инструкция', packageKey: 'instruction' },
      { key: 'inventoryAct', label: 'Акт инвентаризации', packageKey: 'inventoryAct' },
      { key: 'disposalPermit', label: 'Разрешение на захоронение', packageKey: 'disposalPermit' },
      { key: 'simpleWasteSet', label: 'Простой комплект', packageKey: 'simpleWasteSet' },
      { key: 'fullWasteSet', label: 'Полный комплект', packageKey: 'fullWasteSet' },
    ],
  },
  wasteSupportPackage: {
    key: 'wasteSupportPackage',
    question: 'Выберите пакет сопровождения по отходам.',
    options: [
      { key: 'pod9Pod10', label: 'Книги ПОД-9 и ПОД-10', packageKey: 'pod9Pod10' },
      { key: 'pod10', label: 'Книга ПОД-10', packageKey: 'pod10' },
    ],
  },
  emissionsPackage: {
    key: 'emissionsPackage',
    question: 'Выбрана сфера «Выбросы». Выберите пакет документации.',
    options: [
      { key: 'pod123', label: 'ПОД-1, ПОД-2, ПОД-3', packageKey: 'pod123' },
      { key: 'pod4', label: 'ПОД-4', packageKey: 'pod4' },
      { key: 'emissionsSet', label: 'Комплект', packageKey: 'emissionsSet' },
    ],
  },
  complexDirection: {
    key: 'complexDirection',
    question: 'Выбрана сфера «Комплекс». Выберите направление работы.',
    options: [
      { key: 'development', label: 'Разработка', nextNode: 'complexDevelopmentPackage' },
      { key: 'support', label: 'Сопровождение', nextNode: 'complexSupportPackage' },
    ],
  },
  complexDevelopmentPackage: {
    key: 'complexDevelopmentPackage',
    question: 'Выберите комплексный пакет для разработки.',
    options: [
      { key: 'penInstruction', label: 'Инструкция ПЭН', packageKey: 'penInstruction' },
      { key: 'ecoPassport', label: 'Экологический паспорт', packageKey: 'ecoPassport' },
    ],
  },
  complexSupportPackage: {
    key: 'complexSupportPackage',
    question:
      'Режим сопровождения доступен только при наличии разработанной документации. Если документация уже есть, выберите документ для сопровождения.',
    options: [
      { key: 'complexSupportAccounting', label: 'Учет отчетности', packageKey: 'complexSupportAccounting' },
      { key: 'complexSupportAct', label: 'Акт ПН', packageKey: 'complexSupportAct' },
      { key: 'complexSupportSchedule', label: 'План-граф ПН', packageKey: 'complexSupportSchedule' },
      { key: 'complexSupportAnnualPlan', label: 'Годовой план', packageKey: 'complexSupportAnnualPlan' },
    ],
  },
};

export function createAgentProject(now = Date.now(), memory = null) {
  const systemPrompt = memory ? buildMemorySystemPrompt(memory) : '';
  const project = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: 'selecting',
    currentNode: 'sphere',
    selections: {},
    systemPrompt,
    extractedData: {
      memoryContext: systemPrompt,
    },
    history: [],
  };

  addAgentMessage(project, welcomeMessage, now);
  const memoryMessage = memory ? buildMemoryLoadedMessage(memory) : '';
  if (memoryMessage) addAgentMessage(project, memoryMessage, now);
  addAgentMessage(project, agentTree.sphere.question, now);
  return project;
}

async function handleQuickLaunch(project, answer, now, context = {}) {
  console.log('[stateMachine] handleQuickLaunch called with answer:', answer);
  
  // Direct code "112" - create project and ask for organization name
  if (answer === '112') {
    console.log('[stateMachine] Quick launch with code 112');
    const packageDefinition = packageDefinitions.inventoryAct;
    project.status = 'package_selected';
    project.currentNode = null;
    project.packageCode = packageDefinition.code;
    project.packageTitle = packageDefinition.title;
    project.documents = packageDefinition.documents;
    addAgentMessage(project, buildPackageSelectedMessage(packageDefinition), now);
    return project;
  }

  // Text request with organization name: "акт инвентаризации для ООО 'Фермент'"
  const inventoryActMatch = answer.match(/акт\s+инвентаризации\s+для\s+(.+)$/iu);
  if (inventoryActMatch) {
    const organizationName = extractOrganizationNameFromText(inventoryActMatch[1]);
    console.log('[stateMachine] Quick launch with organization name:', organizationName);
    if (organizationName) {
      const packageDefinition = packageDefinitions.inventoryAct;
      project.status = 'package_selected';
      project.currentNode = null;
      project.packageCode = packageDefinition.code;
      project.packageTitle = packageDefinition.title;
      project.documents = packageDefinition.documents;
      
      // Initialize code112 state structure properly
      project.extractedData = project.extractedData || {};
      project.extractedData.code112 = project.extractedData.code112 || {};
      project.extractedData.code112.data = project.extractedData.code112.data || {};
      project.extractedData.code112.data.Название_организации = organizationName;
      
      console.log('[stateMachine] Organization name set in code112.data:', organizationName);
      console.log('[stateMachine] Calling generateCode112 to create pages');
      
      addAgentMessage(project, buildPackageSelectedMessage(packageDefinition), now);
      addAgentMessage(project, `Организация: ${organizationName}`, now);
      
      // Call generateCode112 to create pages after organization name is set
      const memory = context.memoryPath ? await readUserMemory(context.memoryPath) : null;
      return generateCode112(project, { now, outputDir: context.outputDir, docsPath: context.docsPath, memory });
    }
  }

  console.log('[stateMachine] No quick launch pattern matched');
  return null;
}

function extractOrganizationNameFromText(text) {
  // Try to extract from quotes first
  const quotedMatch = text.match(/[«"„]([^»"“]+)[»"”]/u);
  if (quotedMatch) return quotedMatch[1].trim();

  // Check if it starts with organization type
  if (/^(?:ооо|зао|оао|ао|ип|общество|компания)/iu.test(text.trim())) {
    return text.trim();
  }

  // Otherwise return the whole text as organization name
  return text.trim();
}

export async function selectAgentAnswer(project, answer, now = Date.now(), context = {}) {
  const normalizedAnswer = answer.trim();
  const memoryCommandResult = await handleMemoryCommand(project, normalizedAnswer, now, context.memoryPath);
  if (memoryCommandResult) return memoryCommandResult;

  // Quick launch for code112
  if (project.status === 'selecting' && project.currentNode === 'sphere') {
    const quickLaunchResult = await handleQuickLaunch(project, normalizedAnswer, now, context);
    if (quickLaunchResult) return quickLaunchResult;
  }

  if (project.status !== 'selecting' || !project.currentNode) {
    if (!normalizedAnswer) {
      const error = new Error('Пожалуйста, выберите вариант ответа.');
      error.statusCode = 400;
      throw error;
    }

    if (project.packageCode === '112') {
      const memory = context.memoryPath ? await readUserMemory(context.memoryPath) : null;
      return generateCode112(project, { answer: normalizedAnswer, now, outputDir: context.outputDir, docsPath: context.docsPath, memory });
    }

    addUserMessage(project, normalizedAnswer, now);
    if (isPackageCode(normalizedAnswer) && !hasPackageGenerator(normalizedAnswer)) {
      logUnsupportedPackage(project, normalizedAnswer);
      addAgentMessage(project, unsupportedDocumentationMessage, now);
      project.updatedAt = now;
      return project;
    }

    project.extractedData.messages = [
      ...(Array.isArray(project.extractedData.messages) ? project.extractedData.messages : []),
      { text: normalizedAnswer, createdAt: now },
    ];
    project.updatedAt = now;
    addAgentMessage(project, 'Сообщение принято. Цэпик сохранит его как источник для следующих этапов.', now);
    return project;
  }

  const node = agentTree[project.currentNode];
  if (!node) throw new Error(`Неизвестный шаг Цэпика: ${project.currentNode}`);

  const normalizedLabel = normalizedAnswer.toLocaleLowerCase('ru-RU');
  const option = node.options.find(
    (item) => item.key === normalizedAnswer || item.label.toLocaleLowerCase('ru-RU') === normalizedLabel
  );
  if (!option) {
    if (isPackageCode(normalizedAnswer) && !hasPackageGenerator(normalizedAnswer)) {
      addUserMessage(project, normalizedAnswer, now);
      logUnsupportedPackage(project, normalizedAnswer);
      project.updatedAt = now;
      addAgentMessage(project, unsupportedDocumentationMessage, now);
      return project;
    }

    const error = new Error('Пожалуйста, выберите один из предложенных вариантов.');
    error.statusCode = 400;
    throw error;
  }

  addUserMessage(project, option.label, now);
  project.selections[node.key] = {
    answer: option.key,
    label: option.label,
  };
  project.updatedAt = now;

  if (option.packageKey) {
    const packageDefinition = packageDefinitions[option.packageKey];
    if (!packageDefinition) throw new Error(`Неизвестный пакет документации: ${option.packageKey}`);

    if (!hasPackageGenerator(packageDefinition.code)) {
      logUnsupportedPackage(project, packageDefinition.code);
      addAgentMessage(project, unsupportedDocumentationMessage, now);
      return project;
    }

    project.status = 'package_selected';
    project.currentNode = null;
    project.packageCode = packageDefinition.code;
    project.packageTitle = packageDefinition.title;
    project.documents = packageDefinition.documents;
    addAgentMessage(project, buildPackageSelectedMessage(packageDefinition), now);
    if (packageDefinition.code === '112') {
      const memory = context.memoryPath ? await readUserMemory(context.memoryPath) : null;
      return generateCode112(project, { now, outputDir: context.outputDir, docsPath: context.docsPath, memory });
    }
    return project;
  }

  project.currentNode = option.nextNode;
  const nextNode = agentTree[project.currentNode];
  if (!nextNode) throw new Error(`Неизвестный следующий шаг Цэпика: ${project.currentNode}`);
  addAgentMessage(project, nextNode.question, now);
  return project;
}

async function handleMemoryCommand(project, answer, now, memoryPath) {
  if (!answer || !memoryPath) return null;

  const rememberInstruction = answer.match(/^запомни\s*:\s*(.+)$/iu);
  if (rememberInstruction) {
    addUserMessage(project, answer, now);
    const { instruction, created } = await saveInstruction(memoryPath, rememberInstruction[1], now);
    project.systemPrompt = buildMemorySystemPrompt(await readUserMemory(memoryPath));
    project.extractedData.memoryContext = project.systemPrompt;
    project.updatedAt = now;
    addAgentMessage(
      project,
      created ? `Запомнил инструкцию: ${instruction.text}` : `Такая инструкция уже есть в памяти: ${instruction.text}`,
      now
    );
    return project;
  }

  const rememberOrganization = answer.match(/^запомни\s+организац(?:ию|ия)\s*:\s*(.+)$/iu);
  if (rememberOrganization) {
    addUserMessage(project, answer, now);
    const { organization, created } = await saveOrganization(memoryPath, parseOrganizationCommand(rememberOrganization[1]), now);
    project.systemPrompt = buildMemorySystemPrompt(await readUserMemory(memoryPath));
    project.extractedData.memoryContext = project.systemPrompt;
    project.updatedAt = now;
    addAgentMessage(
      project,
      created
        ? `Запомнил организацию: ${organization.name}.`
        : `Обновил сохранённую организацию: ${organization.name}.`,
      now
    );
    return project;
  }

  if (/^покажи,?\s+что\s+ты\s+запомнил$/iu.test(answer)) {
    addUserMessage(project, answer, now);
    const memory = await readUserMemory(memoryPath);
    project.systemPrompt = buildMemorySystemPrompt(memory);
    project.extractedData.memoryContext = project.systemPrompt;
    project.updatedAt = now;
    addAgentMessage(project, formatMemoryForChat(memory), now);
    return project;
  }

  const forgetInstruction = answer.match(/^забудь\s+инструкцию\s+(.+)$/iu);
  if (forgetInstruction) {
    addUserMessage(project, answer, now);
    const result = await deleteInstruction(memoryPath, forgetInstruction[1]);
    const memory = await readUserMemory(memoryPath);
    project.systemPrompt = buildMemorySystemPrompt(memory);
    project.extractedData.memoryContext = project.systemPrompt;
    project.updatedAt = now;
    addAgentMessage(
      project,
      result.deleted
        ? `Забыл инструкцию: ${result.instruction.text}`
        : 'Не нашёл такую инструкцию в памяти.',
      now
    );
    return project;
  }

  const forgetOrganization = answer.match(/^забудь\s+организац(?:ию|ия)\s+(.+)$/iu);
  if (forgetOrganization) {
    addUserMessage(project, answer, now);
    const result = await deleteOrganization(memoryPath, forgetOrganization[1]);
    const memory = await readUserMemory(memoryPath);
    project.systemPrompt = buildMemorySystemPrompt(memory);
    project.extractedData.memoryContext = project.systemPrompt;
    project.updatedAt = now;
    addAgentMessage(
      project,
      result.deleted
        ? `Забыл организацию: ${result.organization.name}`
        : 'Не нашёл такую организацию в памяти.',
      now
    );
    return project;
  }

  return null;
}

function parseOrganizationCommand(text) {
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  const organization = {
    name: parts[0] ?? text.trim(),
    director: '',
    address: '',
    okved: '',
    typicalWastes: [],
  };

  for (const part of parts.slice(1)) {
    const director = part.match(/^(?:директор|руководитель)\s+(.+)$/iu);
    const address = part.match(/^адрес\s+(.+)$/iu);
    const okved = part.match(/^оквэд\s+(.+)$/iu);
    const wastes = part.match(/^типовые\s+отходы\s+(.+)$/iu);
    if (director) organization.director = director[1].trim();
    else if (address) organization.address = address[1].trim();
    else if (okved) organization.okved = okved[1].trim();
    else if (wastes) organization.typicalWastes = wastes[1].split(';').map((item) => item.trim()).filter(Boolean);
  }

  return organization;
}

function isPackageCode(answer) {
  return /^\d+$/.test(answer);
}

function hasPackageGenerator(code) {
  return packageGeneratorCodes.has(code);
}

function logUnsupportedPackage(project, code) {
  console.log('[Цэпик] Запрошена нереализованная ветка', {
    projectId: project.id,
    code,
  });
}

export function serializeAgentProject(project) {
  return {
    ...project,
    question: currentQuestion(project),
    availableOptions: currentOptions(project),
  };
}

export function listOpenProjects(projects) {
  return projects
    .filter((project) => project.status !== 'completed')
    .map((project) => serializeAgentProject(project))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function currentQuestion(project) {
  if (project.packageCode === '112') return getCode112Question(project);
  if (project.status !== 'selecting' || !project.currentNode) return null;
  return agentTree[project.currentNode]?.question ?? null;
}

function currentOptions(project) {
  if (project.packageCode === '112') return getCode112Options(project);
  if (project.status !== 'selecting' || !project.currentNode) return [];
  return (agentTree[project.currentNode]?.options ?? []).map(({ key, label }) => ({ key, label }));
}

function buildPackageSelectedMessage(packageDefinition) {
  return [
    `Выбран пакет «${packageDefinition.title}» (код ${packageDefinition.code}).`,
    `Будут разрабатываться документы: ${packageDefinition.documents.join(', ')}.`,
    'Этап А завершил выбор пакета. На следующих этапах Цэпик запросит источники, файлы и эталонные кейсы.',
  ].join('\n');
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

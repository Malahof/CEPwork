import { randomUUID } from 'node:crypto';

const welcomeMessage = 'Цэпик ожидает ваших указаний для начала работы.';

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

export function createAgentProject(now = Date.now()) {
  const project = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: 'selecting',
    currentNode: 'sphere',
    selections: {},
    extractedData: {},
    history: [],
  };

  addAgentMessage(project, welcomeMessage, now);
  addAgentMessage(project, agentTree.sphere.question, now);
  return project;
}

export function selectAgentAnswer(project, answer, now = Date.now()) {
  if (project.status !== 'selecting' || !project.currentNode) {
    const error = new Error('Project selection is already completed');
    error.statusCode = 409;
    throw error;
  }

  const node = agentTree[project.currentNode];
  if (!node) throw new Error(`Unknown agent node: ${project.currentNode}`);

  const option = node.options.find((item) => item.key === answer);
  if (!option) {
    const error = new Error('Invalid agent answer');
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
    if (!packageDefinition) throw new Error(`Unknown package key: ${option.packageKey}`);

    project.status = 'package_selected';
    project.currentNode = null;
    project.packageCode = packageDefinition.code;
    project.packageTitle = packageDefinition.title;
    project.documents = packageDefinition.documents;
    addAgentMessage(project, buildPackageSelectedMessage(packageDefinition), now);
    return project;
  }

  project.currentNode = option.nextNode;
  const nextNode = agentTree[project.currentNode];
  if (!nextNode) throw new Error(`Unknown next node: ${project.currentNode}`);
  addAgentMessage(project, nextNode.question, now);
  return project;
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
  if (project.status !== 'selecting' || !project.currentNode) return null;
  return agentTree[project.currentNode]?.question ?? null;
}

function currentOptions(project) {
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

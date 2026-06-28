import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const defaultUserMemory = {
  userPreferences: {
    dateFormat: '',
    fonts: {},
    coefficients: {},
  },
  organizations: [],
  savedInstructions: [],
};

export async function readUserMemory(memoryPath) {
  try {
    const raw = await readFile(memoryPath, 'utf8');
    return normalizeMemory(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await writeUserMemory(memoryPath, defaultUserMemory);
      return structuredClone(defaultUserMemory);
    }
    throw error;
  }
}

export async function writeUserMemory(memoryPath, memory) {
  await mkdir(path.dirname(memoryPath), { recursive: true });
  const tmpPath = `${memoryPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(normalizeMemory(memory), null, 2)}\n`);
  await rename(tmpPath, memoryPath);
}

export async function updateUserMemory(memoryPath, updater) {
  const memory = await readUserMemory(memoryPath);
  const result = await updater(memory);
  await writeUserMemory(memoryPath, memory);
  return result;
}

export async function saveInstruction(memoryPath, text, now = Date.now()) {
  const instructionText = requireNonEmptyString(text, 'text');
  return updateUserMemory(memoryPath, (memory) => {
    const existing = memory.savedInstructions.find(
      (instruction) => instruction.text.toLocaleLowerCase('ru-RU') === instructionText.toLocaleLowerCase('ru-RU')
    );
    if (existing) return { instruction: existing, memory, created: false };

    const instruction = {
      id: randomUUID(),
      text: instructionText,
      createdAt: now,
    };
    memory.savedInstructions.push(instruction);
    return { instruction, memory, created: true };
  });
}

export async function saveUserPreferences(memoryPath, preferences) {
  if (!isRecord(preferences)) throw new Error('Некорректные пользовательские настройки');
  return updateUserMemory(memoryPath, (memory) => {
    memory.userPreferences = mergeRecords(memory.userPreferences, preferences);
    return { userPreferences: memory.userPreferences, memory };
  });
}

export async function saveOrganization(memoryPath, value, now = Date.now()) {
  const organization = normalizeOrganizationInput(value, now);
  return updateUserMemory(memoryPath, (memory) => {
    const existingIndex = memory.organizations.findIndex((item) => sameName(item.name, organization.name));
    if (existingIndex >= 0) {
      memory.organizations[existingIndex] = {
        ...memory.organizations[existingIndex],
        ...organization,
        id: memory.organizations[existingIndex].id,
        createdAt: memory.organizations[existingIndex].createdAt,
        updatedAt: now,
      };
      return { organization: memory.organizations[existingIndex], memory, created: false };
    }

    memory.organizations.push(organization);
    return { organization, memory, created: true };
  });
}

export async function deleteInstruction(memoryPath, identifier) {
  const normalizedIdentifier = requireNonEmptyString(identifier, 'id');
  return updateUserMemory(memoryPath, (memory) => {
    const index = findInstructionIndex(memory.savedInstructions, normalizedIdentifier);
    if (index < 0) return { deleted: false, memory };
    const [instruction] = memory.savedInstructions.splice(index, 1);
    return { deleted: true, instruction, memory };
  });
}

export async function deleteOrganization(memoryPath, name) {
  const normalizedName = requireNonEmptyString(name, 'name');
  return updateUserMemory(memoryPath, (memory) => {
    const index = memory.organizations.findIndex((organization) => sameName(organization.name, normalizedName));
    if (index < 0) return { deleted: false, memory };
    const [organization] = memory.organizations.splice(index, 1);
    return { deleted: true, organization, memory };
  });
}

export function findOrganization(memory, text) {
  const source = typeof text === 'string' ? text : '';
  return normalizeMemory(memory).organizations.find((organization) => sourceIncludesName(source, organization.name)) ?? null;
}

export function buildMemorySystemPrompt(memory) {
  const normalized = normalizeMemory(memory);
  const lines = [];

  if (Object.keys(flattenRecord(normalized.userPreferences)).length) {
    lines.push(`Пользовательские настройки: ${JSON.stringify(normalized.userPreferences)}`);
  }

  if (normalized.savedInstructions.length) {
    lines.push('Сохранённые инструкции пользователя:');
    normalized.savedInstructions.forEach((instruction, index) => {
      lines.push(`${index + 1}. ${instruction.text}`);
    });
  }

  if (normalized.organizations.length) {
    lines.push('Сохранённые организации:');
    normalized.organizations.forEach((organization) => {
      lines.push(`- ${formatOrganizationLine(organization)}`);
    });
  }

  return lines.join('\n');
}

export function buildMemoryLoadedMessage(memory) {
  const normalized = normalizeMemory(memory);
  const fragments = [];
  if (normalized.savedInstructions.length) {
    fragments.push(`инструкции: ${normalized.savedInstructions.map((item, index) => `${index + 1}. ${item.text}`).join('; ')}`);
  }
  if (normalized.organizations.length) {
    fragments.push(`организации: ${normalized.organizations.map((item) => item.name).join(', ')}`);
  }
  if (!fragments.length) return '';
  return `Я загрузил долговременную память и буду учитывать её в проекте: ${fragments.join('; ')}.`;
}

export function formatMemoryForChat(memory) {
  const normalized = normalizeMemory(memory);
  const lines = ['Вот что я запомнил:'];

  if (normalized.savedInstructions.length) {
    lines.push('Инструкции:');
    normalized.savedInstructions.forEach((instruction, index) => {
      lines.push(`${index + 1}. ${instruction.text}`);
    });
  } else {
    lines.push('Инструкции: нет сохранённых инструкций.');
  }

  if (normalized.organizations.length) {
    lines.push('Организации:');
    normalized.organizations.forEach((organization, index) => {
      lines.push(`${index + 1}. ${formatOrganizationLine(organization)}`);
    });
  } else {
    lines.push('Организации: нет сохранённых организаций.');
  }

  return lines.join('\n');
}

export function normalizeMemory(value) {
  const source = isRecord(value) ? value : {};
  return {
    userPreferences: isRecord(source.userPreferences)
      ? {
          dateFormat: typeof source.userPreferences.dateFormat === 'string' ? source.userPreferences.dateFormat : '',
          fonts: isRecord(source.userPreferences.fonts) ? source.userPreferences.fonts : {},
          coefficients: isRecord(source.userPreferences.coefficients) ? source.userPreferences.coefficients : {},
          ...copyExtraPreferences(source.userPreferences),
        }
      : structuredClone(defaultUserMemory.userPreferences),
    organizations: Array.isArray(source.organizations)
      ? source.organizations.filter(isRecord).map((organization) => normalizeStoredOrganization(organization))
      : [],
    savedInstructions: Array.isArray(source.savedInstructions)
      ? source.savedInstructions.filter(isRecord).map((instruction) => normalizeStoredInstruction(instruction))
      : [],
  };
}

function normalizeStoredInstruction(instruction) {
  return {
    id: typeof instruction.id === 'string' && instruction.id.trim() ? instruction.id : randomUUID(),
    text: typeof instruction.text === 'string' ? instruction.text : '',
    createdAt: typeof instruction.createdAt === 'number' ? instruction.createdAt : Date.now(),
  };
}

function normalizeStoredOrganization(organization) {
  return {
    id: typeof organization.id === 'string' && organization.id.trim() ? organization.id : randomUUID(),
    name: typeof organization.name === 'string' ? organization.name : '',
    address: typeof organization.address === 'string' ? organization.address : '',
    director: typeof organization.director === 'string' ? organization.director : '',
    okved: typeof organization.okved === 'string' ? organization.okved : '',
    typicalWastes: Array.isArray(organization.typicalWastes)
      ? organization.typicalWastes.filter((item) => typeof item === 'string')
      : [],
    createdAt: typeof organization.createdAt === 'number' ? organization.createdAt : Date.now(),
    updatedAt: typeof organization.updatedAt === 'number' ? organization.updatedAt : Date.now(),
  };
}

function normalizeOrganizationInput(value, now) {
  if (!isRecord(value)) throw new Error('Некорректные данные организации');
  const name = requireNonEmptyString(value.name, 'name');
  return {
    id: randomUUID(),
    name,
    address: typeof value.address === 'string' ? value.address.trim() : '',
    director: typeof value.director === 'string' ? value.director.trim() : '',
    okved: typeof value.okved === 'string' ? value.okved.trim() : '',
    typicalWastes: Array.isArray(value.typicalWastes)
      ? value.typicalWastes.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [],
    createdAt: now,
    updatedAt: now,
  };
}

function findInstructionIndex(instructions, identifier) {
  if (/^\d+$/.test(identifier)) {
    const visibleIndex = Number(identifier) - 1;
    if (visibleIndex >= 0 && visibleIndex < instructions.length) return visibleIndex;
  }

  const normalizedIdentifier = identifier.toLocaleLowerCase('ru-RU');
  return instructions.findIndex(
    (instruction) =>
      instruction.id === identifier || instruction.text.toLocaleLowerCase('ru-RU').includes(normalizedIdentifier)
  );
}

function sourceIncludesName(source, name) {
  const normalizedSource = normalizeName(source);
  const normalizedName = normalizeName(name);
  return Boolean(normalizedName) && normalizedSource.includes(normalizedName);
}

function sameName(left, right) {
  return normalizeName(left) === normalizeName(right);
}

function normalizeName(value) {
  return value.toLocaleLowerCase('ru-RU').replace(/[«»"]/g, '').replace(/\s+/g, ' ').trim();
}

function formatOrganizationLine(organization) {
  return [
    organization.name,
    organization.director ? `директор ${organization.director}` : '',
    organization.address ? `адрес ${organization.address}` : '',
    organization.okved ? `ОКВЭД ${organization.okved}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

function mergeRecords(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(result[key])) result[key] = mergeRecords(result[key], value);
    else result[key] = value;
  }
  return result;
}

function flattenRecord(record) {
  const result = {};
  for (const [key, value] of Object.entries(record)) {
    if (isRecord(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(flattenRecord(value))) {
        result[`${key}.${nestedKey}`] = nestedValue;
      }
    } else if (value !== '' && value !== null && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function copyExtraPreferences(preferences) {
  return Object.fromEntries(
    Object.entries(preferences).filter(([key]) => !['dateFormat', 'fonts', 'coefficients'].includes(key))
  );
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Некорректное поле ${field}`);
  return value.trim();
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

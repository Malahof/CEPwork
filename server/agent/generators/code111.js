export async function generate(projectData, userSources, { generateDraft, readDocs, writeDocs, now = Date.now }) {
  const sources = buildSources(projectData, userSources);
  let content;
  try {
    content = await generateDraft({
      documentRequest:
        'Разработай Инструкцию по обращению с отходами и Заявление (код 111) на основе предоставленных данных.',
      sources,
    });
  } catch (error) {
    if (!isAiQuotaError(error)) {
      throw error;
    }
    content = buildQuotaFallbackMarkdown(projectData, error);
  }

  const snapshot = await readDocs();
  const page = createGeneratedPage(projectData, content, snapshot, now());
  const nextSnapshot = {
    ...snapshot,
    pages: [...snapshot.pages, page],
    activePageId: page.id,
  };

  await writeDocs(nextSnapshot);
  return {
    documents: [
      {
        id: page.id,
        title: page.title,
      },
    ],
    message: `Создан документ: ${page.title}`,
  };
}

function buildSources(projectData, userSources) {
  const parts = [
    `Проект: ${projectData.id}`,
    `Пакет: ${projectData.packageTitle ?? 'Инструкция'} (код ${projectData.packageCode ?? '111'})`,
  ];

  if (projectData.extractedData?.businessActivity) {
    parts.push(`ОКВЭД/описание деятельности: ${projectData.extractedData.businessActivity}`);
  }

  if (projectData.caseData || projectData.extractedData?.caseData) {
    parts.push(`Эталонный кейс:\n${JSON.stringify(projectData.caseData ?? projectData.extractedData.caseData, null, 2)}`);
  }

  const fileContents = Array.isArray(projectData.extractedData?.fileContents)
    ? projectData.extractedData.fileContents
    : [];
  if (fileContents.length > 0) {
    parts.push(
      `Извлечённые данные из файлов:\n${fileContents
        .map((file) => `### ${file.name} (${file.type})\n${file.text}`)
        .join('\n\n')}`
    );
  }

  if (userSources?.trim()) {
    parts.push(`Дополнительные источники пользователя:\n${userSources.trim()}`);
  }

  return `Вот данные:\n\n${parts.join('\n\n')}`;
}

function createGeneratedPage(projectData, content, snapshot, now) {
  const order = snapshot.pages.reduce((maxOrder, page) => Math.max(maxOrder, page.order), -1) + 1;
  const titleSuffix = projectData.extractedData?.businessActivity
    ? ` — ${String(projectData.extractedData.businessActivity).slice(0, 40)}`
    : '';

  return {
    id: `cepik-code111-${projectData.id}-${now}`,
    title: `Инструкция по обращению с отходами${titleSuffix}`,
    content,
    parentId: null,
    order,
    createdAt: now,
    updatedAt: now,
  };
}

function isAiQuotaError(error) {
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  const isQuotaMessage =
    code === 'insufficient_quota' ||
    code === 'resource_exhausted' ||
    message.includes('quota') ||
    message.includes('лимит') ||
    message.includes('превыш') ||
    message.includes('resource exhausted') ||
    message.includes('rate limit');

  return (
    isQuotaMessage &&
    (error?.statusCode === undefined || error.statusCode === 429)
  );
}

function buildQuotaFallbackMarkdown(projectData, error) {
  const activity = projectData.extractedData?.businessActivity
    ? `\n\nОКВЭД/описание деятельности: ${projectData.extractedData.businessActivity}`
    : '';
  const caseInfo =
    projectData.matchedCaseId || projectData.caseData || projectData.extractedData?.caseData
      ? `\n\nЭталонный кейс: ${projectData.matchedCaseId ?? 'применён'}`
      : '';
  const files = Array.isArray(projectData.extractedData?.fileContents)
    ? projectData.extractedData.fileContents
    : [];
  const fileInfo = files.length
    ? `\n\nФайлы-источники:\n${files.map((file) => `- ${file.name}: ${file.text.length} символов`).join('\n')}`
    : '';
  const reason = typeof error?.message === 'string' ? error.message : 'AI API вернул ошибку квоты';

  return `# Документ не сгенерирован из-за лимита API

Документ не сгенерирован из-за лимита API. Цэпик создал эту страницу-заглушку, чтобы сохранить ход проекта и проверить остальную логику: выбор пакета, загрузку файлов, подбор эталона и создание страницы в документации.

## Что произошло

AI-провайдер вернул ошибку квоты: ${reason}

## Контекст проекта

Пакет: ${projectData.packageTitle ?? 'Инструкция'} (код ${projectData.packageCode ?? '111'})${activity}${caseInfo}${fileInfo}

## Следующий шаг

После пополнения баланса или замены ключа повторите генерацию, чтобы заменить эту заглушку реальным Markdown-документом.`;
}

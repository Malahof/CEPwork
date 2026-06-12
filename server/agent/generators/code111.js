export async function generate(projectData, userSources, { generateDraft, readDocs, writeDocs, now = Date.now }) {
  const sources = buildSources(projectData, userSources);
  const content = await generateDraft({
    documentRequest:
      'Разработай Инструкцию по обращению с отходами и Заявление (код 111) на основе предоставленных данных.',
    sources,
  });

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

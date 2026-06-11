import type { DocsSnapshot, DocsVersion } from '../types';

const DOCS_ENDPOINT = '/api/docs';

export async function fetchDocs(): Promise<DocsSnapshot> {
  const response = await fetch(DOCS_ENDPOINT);
  if (!response.ok) {
    throw new Error('Не удалось загрузить документы с сервера');
  }
  return response.json() as Promise<DocsSnapshot>;
}

export async function saveDocs(snapshot: DocsSnapshot): Promise<DocsSnapshot> {
  const response = await fetch(DOCS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(snapshot),
  });

  if (!response.ok) {
    throw new Error('Не удалось сохранить документы на сервере');
  }

  return response.json() as Promise<DocsSnapshot>;
}

export async function fetchDocsVersions(): Promise<DocsVersion[]> {
  const response = await fetch(`${DOCS_ENDPOINT}/versions`);
  if (!response.ok) {
    throw new Error('Не удалось загрузить историю версий');
  }
  return response.json() as Promise<DocsVersion[]>;
}

export async function fetchDocsVersion(versionId: string): Promise<DocsSnapshot> {
  const response = await fetch(`${DOCS_ENDPOINT}/versions/${encodeURIComponent(versionId)}`);
  if (!response.ok) {
    throw new Error('Не удалось загрузить выбранную версию');
  }
  return response.json() as Promise<DocsSnapshot>;
}

export async function restoreDocsVersion(versionId: string): Promise<DocsSnapshot> {
  const response = await fetch(`${DOCS_ENDPOINT}/restore/${encodeURIComponent(versionId)}`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error('Не удалось восстановить выбранную версию');
  }

  return response.json() as Promise<DocsSnapshot>;
}

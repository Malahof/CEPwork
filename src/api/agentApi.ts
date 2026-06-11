import type { AgentProject } from '../types';

export async function startAgentProject(): Promise<AgentProject> {
  const response = await fetch('/api/agent/start', { method: 'POST' });
  return parseAgentResponse(response, 'Не удалось начать проект Цэпика');
}

export async function selectAgentAnswer(projectId: string, answer: string): Promise<AgentProject> {
  const response = await fetch('/api/agent/select', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ projectId, answer }),
  });
  return parseAgentResponse(response, 'Не удалось обработать ответ Цэпика');
}

export async function fetchAgentProjects(): Promise<AgentProject[]> {
  const response = await fetch('/api/agent/projects');
  if (!response.ok) {
    throw new Error('Не удалось загрузить проекты Цэпика');
  }
  return response.json() as Promise<AgentProject[]>;
}

export async function fetchAgentProjectState(projectId: string): Promise<AgentProject> {
  const response = await fetch(`/api/agent/state/${encodeURIComponent(projectId)}`);
  return parseAgentResponse(response, 'Не удалось загрузить состояние проекта');
}

async function parseAgentResponse(response: Response, fallbackMessage: string): Promise<AgentProject> {
  const body = (await response.json()) as Partial<AgentProject> & { error?: string };
  if (!response.ok || !body.id) {
    throw new Error(body.error ?? fallbackMessage);
  }
  return body as AgentProject;
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readAgentProjects(projectsPath) {
  try {
    const raw = await readFile(projectsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) {
      throw new Error('Invalid eco projects storage');
    }
    return parsed.projects;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await writeAgentProjects(projectsPath, []);
      return [];
    }
    throw error;
  }
}

export async function writeAgentProjects(projectsPath, projects) {
  await mkdir(path.dirname(projectsPath), { recursive: true });
  const tmpPath = `${projectsPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify({ projects }, null, 2)}\n`);
  await rename(tmpPath, projectsPath);
}

export async function updateAgentProjects(projectsPath, updater) {
  const projects = await readAgentProjects(projectsPath);
  const result = await updater(projects);
  await writeAgentProjects(projectsPath, projects);
  return result;
}

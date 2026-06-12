import { Router } from 'express';
import {
  addExtractedFile,
  confirmCaseMatch,
  createAgentProject,
  listOpenProjects,
  selectAgentAnswer,
  serializeAgentProject,
  submitCaseQuery,
} from '../agent/stateMachine.js';
import {
  readAgentProjects,
  updateAgentProjects,
} from '../agent/storage.js';
import { findBestCase, getCaseById } from '../agent/cases.js';
import { createUploadMiddleware, parseUploadedFile } from '../agent/upload.js';

export function createAgentRouter({ agentProjectsPath, casesDir, uploadsDir, isRecord, requireString }) {
  const router = Router();
  const upload = createUploadMiddleware(uploadsDir);

  router.post('/start', async (_req, res, next) => {
    try {
      const project = createAgentProject();
      await updateAgentProjects(agentProjectsPath, (projects) => {
        projects.push(project);
        return project;
      });
      res.json(serializeAgentProject(project));
    } catch (error) {
      next(error);
    }
  });

  router.post('/select', async (req, res, next) => {
    try {
      const body = req.body;
      if (!isRecord(body)) throw new Error('Invalid agent selection');

      const projectId = requireString(body.projectId, 'projectId');
      const answer = requireString(body.answer, 'answer');

      const project = await updateAgentProjects(agentProjectsPath, async (projects) => {
        const found = projects.find((item) => item.id === projectId);
        if (!found) {
          const error = new Error('Agent project not found');
          error.statusCode = 404;
          throw error;
        }

        if (found.status === 'awaiting_case_query') {
          return submitCaseQuery(found, answer, await findBestCase(answer, casesDir));
        }

        if (found.status === 'awaiting_case_confirmation') {
          const matchedCase = answer === 'yes' ? await getCaseById(found.pendingCaseId, casesDir) : null;
          return confirmCaseMatch(found, answer, matchedCase);
        }

        return selectAgentAnswer(found, answer);
      });

      res.json(serializeAgentProject(project));
    } catch (error) {
      res.status(error.statusCode ?? 400);
      next(error);
    }
  });

  router.post('/upload', async (req, res, next) => {
    try {
      await runUpload(upload, req, res);

      if (!req.file) throw new Error('Файл не передан');
      const projectId = requireString(req.body?.projectId, 'projectId');
      const fileContent = await parseUploadedFile(req.file);

      const project = await updateAgentProjects(agentProjectsPath, (projects) => {
        const found = projects.find((item) => item.id === projectId);
        if (!found) {
          const error = new Error('Agent project not found');
          error.statusCode = 404;
          throw error;
        }
        return addExtractedFile(found, fileContent);
      });

      res.json({
        ...serializeAgentProject(project),
        upload: {
          message: `Файл обработан, извлечено ${fileContent.text.length} символов`,
          charCount: fileContent.text.length,
        },
      });
    } catch (error) {
      res.status(error.statusCode ?? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400));
      next(error);
    }
  });

  router.get('/projects', async (_req, res, next) => {
    try {
      res.json(listOpenProjects(await readAgentProjects(agentProjectsPath)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/state/:projectId', async (req, res, next) => {
    try {
      const projects = await readAgentProjects(agentProjectsPath);
      const project = projects.find((item) => item.id === req.params.projectId);
      if (!project) {
        res.status(404);
        throw new Error('Agent project not found');
      }
      res.json(serializeAgentProject(project));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function runUpload(upload, req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

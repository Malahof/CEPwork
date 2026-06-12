import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CheckCircle2, FolderClock, Play, RefreshCw, Sparkles, UploadCloud } from 'lucide-react';
import {
  fetchAgentProjectState,
  fetchAgentProjects,
  selectAgentAnswer,
  startAgentProject,
  uploadAgentFile,
} from '../api/agentApi';
import type { AgentProject } from '../types';

export function ChatWizard() {
  const [project, setProject] = useState<AgentProject | null>(null);
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const messages = useMemo(
    () =>
      project?.history ?? [
        {
          id: 'cepik-welcome',
          role: 'agent' as const,
          text: 'Цэпик ожидает ваших указаний для начала работы.',
          createdAt: 0,
        },
      ],
    [project]
  );
  const extractedFileCount = project?.extractedData.fileContents?.length ?? 0;

  useEffect(() => {
    let isMounted = true;

    async function loadProjects() {
      try {
        const loaded = await fetchAgentProjects();
        if (isMounted) setProjects(loaded);
      } catch (error) {
        if (isMounted) {
          setError(error instanceof Error ? error.message : 'Не удалось загрузить проекты Цэпика');
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    void loadProjects();

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleStartProject() {
    setIsLoading(true);
    setError(null);
    try {
      const started = await startAgentProject();
      setProject(started);
      setProjects((current) => [started, ...current.filter((item) => item.id !== started.id)]);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось начать проект Цэпика');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleResumeProject(projectId: string) {
    setIsLoading(true);
    setError(null);
    try {
      setProject(await fetchAgentProjectState(projectId));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось открыть проект Цэпика');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSelect(answer: string) {
    if (!project || isSelecting) return;

    setIsSelecting(true);
    setError(null);
    try {
      const updated = await selectAgentAnswer(project.id, answer);
      setProject(updated);
      setProjects((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Цэпик не смог обработать ответ');
    } finally {
      setIsSelecting(false);
    }
  }

  async function handleUpload(file: File) {
    if (!project || isUploading) return;

    setIsUploading(true);
    setError(null);
    try {
      const updated = await uploadAgentFile(project.id, file);
      setProject(updated);
      setProjects((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось загрузить файл');
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <aside className="eco-agent chat-wizard">
      <header className="eco-agent-header">
        <Bot size={22} />
        <div>
          <div className="eco-agent-eyebrow">ИИ-агент</div>
          <h2>Цэпик</h2>
        </div>
      </header>

      <div className="eco-agent-role">
        <Sparkles size={16} />
        <span>
          Многошаговый помощник по разработке экологической документации. Этап Б:
          выбор пакета и загрузка исходных файлов для парсинга.
        </span>
      </div>

      <div className="chat-project-toolbar">
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={isLoading}
          onClick={handleStartProject}
        >
          <Play size={14} />
          <span>Новый проект</span>
        </button>
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          disabled={isLoading}
          onClick={() => {
            setProject(null);
            void fetchAgentProjects().then(setProjects).catch((error) => {
              setError(error instanceof Error ? error.message : 'Не удалось обновить проекты');
            });
          }}
        >
          <RefreshCw size={14} />
          <span>Проекты</span>
        </button>
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          disabled={!project || isLoading || isUploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadCloud size={14} />
          <span>{isUploading ? 'Загрузка…' : 'Загрузить файл'}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".docx,.xlsx,.xls,.pdf,.jpg,.jpeg,.png,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/jpeg,image/png"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void handleUpload(file);
          }}
        />
      </div>

      {project && (
        <div className="chat-upload-status">
          Файлы-источники: {extractedFileCount}
        </div>
      )}

      {!project && projects.length > 0 && (
        <section className="chat-projects">
          <div className="chat-section-title">
            <FolderClock size={14} />
            <span>Продолжить работу</span>
          </div>
          {projects.slice(0, 4).map((item) => (
            <button
              className="chat-project-card"
              key={item.id}
              type="button"
              onClick={() => void handleResumeProject(item.id)}
            >
              <strong>{item.packageTitle ?? item.question ?? 'Новый проект'}</strong>
              <span>
                {item.packageCode ? `Код ${item.packageCode}` : 'Выбор пакета не завершён'} ·{' '}
                {new Date(item.updatedAt).toLocaleString('ru-RU')}
              </span>
            </button>
          ))}
        </section>
      )}

      <div className="eco-agent-messages">
        {messages.map((message) => (
          <div className={`eco-agent-message ${message.role}`} key={message.id}>
            {message.text}
          </div>
        ))}
        {project?.status === 'package_selected' && (
          <div className="chat-package-summary">
            <CheckCircle2 size={16} />
            <div>
              <strong>Код {project.packageCode}</strong>
              <span>{project.documents?.join(', ')}</span>
            </div>
          </div>
        )}
      </div>

      {error && <div className="editor-error">{error}</div>}

      <div className="eco-agent-input chat-options-panel">
        {project?.availableOptions.length ? (
          <>
            <div className="chat-section-title">Выберите вариант ответа</div>
            <div className="chat-option-grid">
              {project.availableOptions.map((option) => (
                <button
                  className="btn btn-secondary btn-sm chat-option"
                  key={option.key}
                  type="button"
                  disabled={isSelecting}
                  onClick={() => void handleSelect(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </>
        ) : project?.status === 'package_selected' ? (
          <div className="chat-finished">
            Пакет выбран. Можно загрузить DOCX, XLSX, PDF или изображение как источник.
          </div>
        ) : (
          <div className="chat-finished">Нажмите «Новый проект», чтобы начать диалог.</div>
        )}
      </div>
    </aside>
  );
}

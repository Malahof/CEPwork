import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CheckCircle2, FolderClock, Paperclip, Play, RefreshCw, Send, Sparkles } from 'lucide-react';
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
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isFileUploading, setIsFileUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  function updateProjectList(updated: AgentProject) {
    setProject(updated);
    setProjects((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
  }

  async function handleStartProject() {
    setIsLoading(true);
    setError(null);
    try {
      updateProjectList(await startAgentProject());
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
      updateProjectList(await selectAgentAnswer(project.id, answer));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Цэпик не смог обработать ответ');
    } finally {
      setIsSelecting(false);
    }
  }

  async function handleSend() {
    const answer = inputText.trim();
    if (!answer || !project || isSelecting || isFileUploading) return;

    setInputText('');
    await handleSelect(answer);
  }

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !project) return;

    setIsFileUploading(true);
    setError(null);
    try {
      const result = await uploadAgentFile(project.id, file);
      updateProjectList(result.project);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось обработать файл');
    } finally {
      setIsFileUploading(false);
      event.target.value = '';
    }
  }

  const isInputDisabled = !project || isLoading || isSelecting || isFileUploading;

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
          Многошаговый помощник по разработке экологической документации. Этап А:
          выбор сферы, направления и пакета по строгому дереву.
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
      </div>

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
        {isSelecting && <div className="chat-status">Цэпик печатает...</div>}
        {isFileUploading && <div className="chat-status">Загрузка файла...</div>}
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
                  disabled={isSelecting || isFileUploading}
                  onClick={() => void handleSelect(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </>
        ) : project?.status === 'package_selected' ? (
          <div className="chat-finished">
            Пакет выбран. Прикрепите файл или отправьте источники сообщением.
          </div>
        ) : (
          <div className="chat-finished">Нажмите «Новый проект», чтобы начать диалог.</div>
        )}

        <div className="chat-input-row">
          <input
            ref={fileInputRef}
            className="chat-file-input"
            type="file"
            onChange={(event) => void handleFileUpload(event)}
            accept=".docx,.xlsx,.pdf,.jpg,.jpeg,.png,.txt,.csv,.md"
          />
          <button
            className="btn btn-secondary btn-sm chat-file-button"
            type="button"
            disabled={isInputDisabled}
            onClick={() => fileInputRef.current?.click()}
            title="Прикрепить файл"
          >
            <Paperclip size={16} />
          </button>
          <input
            className="chat-text-input"
            type="text"
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleSend();
            }}
            placeholder={project ? 'Введите сообщение или вариант ответа...' : 'Создайте или откройте проект'}
            disabled={isInputDisabled}
          />
          <button
            className="btn btn-primary btn-sm chat-send-button"
            type="button"
            disabled={isInputDisabled || !inputText.trim()}
            onClick={() => void handleSend()}
          >
            <Send size={16} />
            <span>Отправить</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

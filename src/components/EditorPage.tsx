import { useState } from 'react';
import { useDocStore } from '../store/useDocStore';
import { ChatWizard } from './ChatWizard';
import { MarkdownEditor } from './MarkdownEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { TemplateCreateDialog } from './TemplateCreateDialog';
import { PanelLeft, FileText, FilePlus, Maximize2, Minus } from 'lucide-react';

function readStoredPanelState(key: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback;
  return window.localStorage.getItem(key) === null
    ? fallback
    : window.localStorage.getItem(key) === 'true';
}

function useStoredPanelState(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => readStoredPanelState(key, fallback));

  function updateValue(nextValue: boolean) {
    setValue(nextValue);
    window.localStorage.setItem(key, String(nextValue));
  }

  return [value, updateValue] as const;
}

export function EditorPage() {
  const {
    pages,
    folders,
    activePageId,
    updatePage,
    createPageFromTemplate,
    sidebarOpen,
    toggleSidebar,
    isLoading,
    isSaving,
    error,
  } = useDocStore();
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [editorCollapsed, setEditorCollapsed] = useStoredPanelState('cepwork.editorCollapsed', false);
  const [previewCollapsed, setPreviewCollapsed] = useStoredPanelState('cepwork.previewCollapsed', false);

  const activePage = pages.find((p) => p.id === activePageId);

  function toggleEditor() {
    const nextValue = !editorCollapsed;
    if (nextValue && previewCollapsed) setPreviewCollapsed(false);
    setEditorCollapsed(nextValue);
  }

  function togglePreview() {
    const nextValue = !previewCollapsed;
    if (nextValue) setEditorCollapsed(false);
    setPreviewCollapsed(nextValue);
  }

  function collapseEditorForGeneration() {
    if (previewCollapsed) setPreviewCollapsed(false);
    setEditorCollapsed(true);
  }

  function handleCreateFromTemplate(values: Record<string, string>) {
    if (!activePage) return;
    const page = createPageFromTemplate(activePage.id, values);
    if (page) {
      setTemplateDialogOpen(false);
    }
  }

  return (
    <main className="editor-main">
      <div className="editor-topbar">
        {!sidebarOpen && (
          <button
            className="icon-btn"
            title="Показать панель"
            onClick={toggleSidebar}
          >
            <PanelLeft size={18} />
          </button>
        )}
        {activePage && (
          <div className="editor-breadcrumb">
            <FileText size={16} />
            <span>{activePage.title}</span>
            <span className="editor-date">
              Обновлено: {new Date(activePage.updatedAt).toLocaleString('ru-RU')}
            </span>
            {isSaving && <span className="editor-status">Сохранение...</span>}
            {activePage.isTemplate && (
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={() => setTemplateDialogOpen(true)}
              >
                <FilePlus size={14} />
                <span>Создать из шаблона</span>
              </button>
            )}
          </div>
        )}
      </div>

      {error && <div className="editor-error">{error}</div>}

      <div className="editor-split">
        <div className="document-workspace">
          {editorCollapsed ? (
            <button className="collapsed-pane-tab" type="button" onClick={toggleEditor}>
              <Maximize2 size={15} />
              <span>Редактор</span>
            </button>
          ) : (
            <section className="document-pane editor-document-pane">
              <div className="document-pane-header editor-pane-header">
                <span>Редактор</span>
                <button className="icon-btn" type="button" title="Свернуть редактор" onClick={toggleEditor}>
                  <Minus size={16} />
                </button>
              </div>
              <div className="document-pane-body">
                {isLoading ? (
                  <LoadingState title="Загрузка документов" description="Получаем данные с сервера..." />
                ) : activePage ? (
                  <MarkdownEditor
                    value={activePage.content}
                    onChange={(content) => updatePage(activePage.id, { content })}
                    readOnly={activePage.isTemplate}
                  />
                ) : (
                  <LoadingState
                    title="Выберите страницу"
                    description="Выберите существующую страницу из боковой панели или создайте новую"
                  />
                )}
              </div>
            </section>
          )}

          {previewCollapsed ? (
            <button className="collapsed-pane-tab" type="button" onClick={togglePreview}>
              <Maximize2 size={15} />
              <span>Предпросмотр</span>
            </button>
          ) : (
            <section className="document-pane preview-document-pane">
              {activePage ? (
                <MarkdownPreview
                  content={activePage.content}
                  title={activePage.title}
                  pages={pages}
                  folders={folders}
                  headerStart={
                    <button className="icon-btn" type="button" title="Свернуть предпросмотр" onClick={togglePreview}>
                      <Minus size={16} />
                    </button>
                  }
                />
              ) : (
                <>
                  <div className="preview-header">
                    <button className="icon-btn" type="button" title="Свернуть предпросмотр" onClick={togglePreview}>
                      <Minus size={16} />
                    </button>
                    <span className="preview-label">Предпросмотр</span>
                  </div>
                  <LoadingState title="Предпросмотр" description="Выберите документ, чтобы увидеть его содержимое" />
                </>
              )}
            </section>
          )}
        </div>

        <ChatWizard onGenerationStart={collapseEditorForGeneration} />
        {templateDialogOpen && activePage?.isTemplate && (
          <TemplateCreateDialog
            template={activePage}
            onClose={() => setTemplateDialogOpen(false)}
            onCreate={handleCreateFromTemplate}
          />
        )}
      </div>
    </main>
  );
}

function LoadingState({ title, description }: { title: string; description: string }) {
  return (
    <div className="editor-empty">
      <div className="empty-state">
        <FileText size={64} strokeWidth={1} />
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

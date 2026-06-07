import { useDocStore } from '../store/useDocStore';
import { EcoAgentPanel } from './EcoAgentPanel';
import { MarkdownEditor } from './MarkdownEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { PanelLeft, FileText } from 'lucide-react';

export function EditorPage() {
  const {
    pages,
    folders,
    activePageId,
    updatePage,
    sidebarOpen,
    toggleSidebar,
    isLoading,
    isSaving,
    error,
  } = useDocStore();

  const activePage = pages.find((p) => p.id === activePageId);

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
          </div>
        )}
      </div>

      {error && <div className="editor-error">{error}</div>}

      {isLoading ? (
        <div className="editor-empty">
          <div className="empty-state">
            <FileText size={64} strokeWidth={1} />
            <h2>Загрузка документов</h2>
            <p>Получаем данные с сервера...</p>
          </div>
        </div>
      ) : activePage ? (
        <div className="editor-split">
          <MarkdownEditor
            value={activePage.content}
            onChange={(content) => updatePage(activePage.id, { content })}
          />
          <MarkdownPreview
            content={activePage.content}
            title={activePage.title}
            pages={pages}
            folders={folders}
          />
          <EcoAgentPanel
            onApplyDraft={(content) => updatePage(activePage.id, { content })}
          />
        </div>
      ) : (
        <div className="editor-empty">
          <div className="empty-state">
            <FileText size={64} strokeWidth={1} />
            <h2>Выберите страницу</h2>
            <p>
              Выберите существующую страницу из боковой панели или создайте новую
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

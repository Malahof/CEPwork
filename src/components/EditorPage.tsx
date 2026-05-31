import { useDocStore } from '../store/useDocStore';
import { MarkdownEditor } from './MarkdownEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { PanelLeft, FileText } from 'lucide-react';

export function EditorPage() {
  const { pages, activePageId, updatePage, sidebarOpen, toggleSidebar } =
    useDocStore();

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
          </div>
        )}
      </div>

      {activePage ? (
        <div className="editor-split">
          <MarkdownEditor
            value={activePage.content}
            onChange={(content) => updatePage(activePage.id, { content })}
          />
          <MarkdownPreview
            content={activePage.content}
            title={activePage.title}
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

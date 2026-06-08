import { useState } from 'react';
import {
  FileText,
  FolderOpen,
  FolderClosed,
  Plus,
  Trash2,
  ChevronRight,
  ChevronDown,
  FolderPlus,
  Search,
  X,
  PanelLeftClose,
  Edit3,
  Check,
} from 'lucide-react';
import { useDocStore } from '../store/useDocStore';
import type { DocFolder } from '../types';

export function Sidebar() {
  const {
    pages,
    folders,
    activePageId,
    sidebarOpen,
    searchQuery,
    setActivePage,
    addPage,
    addFolder,
    deletePage,
    deleteFolder,
    toggleFolder,
    toggleSidebar,
    setSearchQuery,
    updatePage,
    updateFolder,
  } = useDocStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  if (!sidebarOpen) {
    return null;
  }

  const filteredPages = searchQuery
    ? pages.filter(
        (p) =>
          p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.content.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : pages;

  function startEditing(id: string, currentTitle: string) {
    setEditingId(id);
    setEditingTitle(currentTitle);
  }

  function commitEdit(type: 'page' | 'folder') {
    const title = normalizeEditableTitle(editingTitle);
    if (!editingId || !title) return;
    if (type === 'page') {
      updatePage(editingId, { title });
    } else {
      updateFolder(editingId, { title });
    }
    setEditingId(null);
    setEditingTitle('');
  }

  function renderFolder(folder: DocFolder) {
    const childPages = filteredPages
      .filter((p) => p.parentId === folder.id)
      .sort((a, b) => a.order - b.order);
    const childFolders = folders
      .filter((f) => f.parentId === folder.id)
      .sort((a, b) => a.order - b.order);

    const isEditing = editingId === folder.id;

    return (
      <div key={folder.id} className="sidebar-folder">
        <div
          className="sidebar-item folder-item"
          onClick={() => toggleFolder(folder.id)}
        >
          <span className="item-icon">
            {folder.isExpanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
          </span>
          <span className="item-icon">
            {folder.isExpanded ? (
              <FolderOpen size={16} />
            ) : (
              <FolderClosed size={16} />
            )}
          </span>
          {isEditing ? (
            <input
              className="inline-edit"
              type="text"
              inputMode="text"
              autoComplete="off"
              dir="auto"
              spellCheck={false}
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEdit('folder');
                if (e.key === 'Escape') setEditingId(null);
              }}
              onBlur={() => commitEdit('folder')}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="item-title">{folder.title}</span>
          )}
          <span className="item-actions">
            {!isEditing && (
              <button
                className="icon-btn"
                title="Переименовать"
                onClick={(e) => {
                  e.stopPropagation();
                  startEditing(folder.id, folder.title);
                }}
              >
                <Edit3 size={13} />
              </button>
            )}
            {isEditing && (
              <button
                className="icon-btn"
                title="Сохранить"
                onClick={(e) => {
                  e.stopPropagation();
                  commitEdit('folder');
                }}
              >
                <Check size={13} />
              </button>
            )}
            <button
              className="icon-btn"
              title="Добавить страницу"
              onClick={(e) => {
                e.stopPropagation();
                addPage('Новая страница', folder.id);
              }}
            >
              <Plus size={13} />
            </button>
            <button
              className="icon-btn danger"
              title="Удалить папку"
              onClick={(e) => {
                e.stopPropagation();
                deleteFolder(folder.id);
              }}
            >
              <Trash2 size={13} />
            </button>
          </span>
        </div>
        {folder.isExpanded && (
          <div className="folder-children">
            {childFolders.map((cf) => renderFolder(cf))}
            {childPages.map((page) => renderPageItem(page.id, page.title))}
          </div>
        )}
      </div>
    );
  }

  function renderPageItem(id: string, title: string) {
    const isActive = activePageId === id;
    const isEditing = editingId === id;

    return (
      <div
        key={id}
        className={`sidebar-item page-item ${isActive ? 'active' : ''}`}
        onClick={() => setActivePage(id)}
      >
        <span className="item-icon">
          <FileText size={16} />
        </span>
        {isEditing ? (
          <input
            className="inline-edit"
            type="text"
            inputMode="text"
            autoComplete="off"
            dir="auto"
            spellCheck={false}
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit('page');
              if (e.key === 'Escape') setEditingId(null);
            }}
            onBlur={() => commitEdit('page')}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span className="item-title">{title}</span>
        )}
        <span className="item-actions">
          {!isEditing && (
            <button
              className="icon-btn"
              title="Переименовать"
              onClick={(e) => {
                e.stopPropagation();
                startEditing(id, title);
              }}
            >
              <Edit3 size={13} />
            </button>
          )}
          {isEditing && (
            <button
              className="icon-btn"
              title="Сохранить"
              onClick={(e) => {
                e.stopPropagation();
                commitEdit('page');
              }}
            >
              <Check size={13} />
            </button>
          )}
          <button
            className="icon-btn danger"
            title="Удалить"
            onClick={(e) => {
              e.stopPropagation();
              deletePage(id);
            }}
          >
            <Trash2 size={13} />
          </button>
        </span>
      </div>
    );
  }

  const rootPages = filteredPages
    .filter((p) => p.parentId === null)
    .sort((a, b) => a.order - b.order);
  const rootFolders = folders
    .filter((f) => f.parentId === null)
    .sort((a, b) => a.order - b.order);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2 className="sidebar-logo">DocBuilder</h2>
        <button
          className="icon-btn"
          title="Скрыть панель"
          onClick={toggleSidebar}
        >
          <PanelLeftClose size={18} />
        </button>
      </div>

      <div className="sidebar-search">
        <Search size={16} className="search-icon" />
        <input
          type="text"
          placeholder="Поиск..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className="icon-btn" onClick={() => setSearchQuery('')}>
            <X size={14} />
          </button>
        )}
      </div>

      <div className="sidebar-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={() => addPage('Новая страница', null)}
        >
          <Plus size={14} />
          <span>Страница</span>
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => addFolder('Новая папка', null)}
        >
          <FolderPlus size={14} />
          <span>Папка</span>
        </button>
      </div>

      <nav className="sidebar-nav">
        {rootFolders.map((folder) => renderFolder(folder))}
        {rootPages.map((page) => renderPageItem(page.id, page.title))}
        {filteredPages.length === 0 && searchQuery && (
          <div className="sidebar-empty">Ничего не найдено</div>
        )}
      </nav>
    </aside>
  );
}

function normalizeEditableTitle(title: string) {
  return [...title.normalize('NFC')]
    .filter((char) => {
      const code = char.codePointAt(0);
      return code !== undefined && (code > 31 || code === 9) && code !== 127;
    })
    .join('')
    .trim();
}

import { create } from 'zustand';
import { fetchDocs, saveDocs } from '../api/docsApi';
import { defaultDocsSnapshot } from '../data/defaultDocs';
import type { DocsSnapshot, DocPage, DocFolder } from '../types';

interface DocState {
  pages: DocPage[];
  folders: DocFolder[];
  activePageId: string | null;
  sidebarOpen: boolean;
  searchQuery: string;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;

  loadDocs: () => Promise<void>;
  saveCurrentDocs: () => Promise<void>;
  addPage: (title: string, parentId: string | null) => DocPage;
  createPageFromTemplate: (templateId: string, values: Record<string, string>) => DocPage | null;
  updatePage: (id: string, updates: Partial<Pick<DocPage, 'title' | 'content'>>) => void;
  deletePage: (id: string) => void;
  setActivePage: (id: string | null) => void;

  addFolder: (title: string, parentId: string | null) => DocFolder;
  updateFolder: (id: string, updates: Partial<Pick<DocFolder, 'title'>>) => void;
  deleteFolder: (id: string) => void;
  toggleFolder: (id: string) => void;

  toggleSidebar: () => void;
  setSearchQuery: (query: string) => void;
  reorderPage: (id: string, newOrder: number) => void;
}

type DocsUpdater = (state: DocState) => DocsSnapshot;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function docsSnapshotFromState(state: DocState): DocsSnapshot {
  return {
    pages: state.pages,
    folders: state.folders,
    activePageId: state.activePageId,
  };
}

function snapshotWithDefaultTemplates(snapshot: DocsSnapshot): DocsSnapshot {
  const defaultTemplates = defaultDocsSnapshot.pages.filter((page) => page.isTemplate);
  const templateIds = new Set(defaultTemplates.map((page) => page.id));
  const defaultTemplateById = new Map(defaultTemplates.map((page) => [page.id, page]));
  const pages = snapshot.pages.map((page) => {
    const defaultTemplate = defaultTemplateById.get(page.id);
    if (!defaultTemplate) return page;

    return {
      ...defaultTemplate,
      title: page.title,
      parentId: page.parentId,
      order: page.order,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    };
  });
  const existingPageIds = new Set(pages.map((page) => page.id));
  const missingTemplates = defaultTemplates.filter((page) => !existingPageIds.has(page.id));
  const templateFolder = defaultDocsSnapshot.folders.find((folder) => folder.id === 'templates');
  const hasTemplateFolder = snapshot.folders.some((folder) => folder.id === 'templates');

  return {
    pages: [...pages, ...missingTemplates],
    folders: hasTemplateFolder || !templateFolder ? snapshot.folders : [...snapshot.folders, templateFolder],
    activePageId: templateIds.has(snapshot.activePageId ?? '') ? snapshot.activePageId : snapshot.activePageId,
  };
}

function renderTemplate(content: string, values: Record<string, string>): string {
  return content.replace(/{{\s*([\w-]+)\s*}}/g, (_match, key: string) => values[key]?.trim() ?? '');
}

function titleFromContent(content: string, fallback: string): string {
  const heading = content.match(/^#(?!#)\s+(.+)$/m);
  return heading?.[1]?.trim() || fallback;
}

export const useDocStore = create<DocState>()((set, get) => {
  async function saveSnapshot(snapshot: DocsSnapshot) {
    set({ isSaving: true, error: null });
    try {
      const saved = snapshotWithDefaultTemplates(await saveDocs(snapshot));
      set({
        pages: saved.pages,
        folders: saved.folders,
        activePageId: saved.activePageId,
        isSaving: false,
      });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Не удалось сохранить документы',
      });
    }
  }

  function updateDocs(updater: DocsUpdater) {
    const snapshot = updater(get());
    set({
      pages: snapshot.pages,
      folders: snapshot.folders,
      activePageId: snapshot.activePageId,
      error: null,
    });
    void saveSnapshot(snapshot);
  }

  return {
    pages: defaultDocsSnapshot.pages,
    folders: defaultDocsSnapshot.folders,
    activePageId: defaultDocsSnapshot.activePageId,
    sidebarOpen: true,
    searchQuery: '',
    isLoading: false,
    isSaving: false,
    error: null,

    loadDocs: async () => {
      set({ isLoading: true, error: null });
      try {
        const snapshot = snapshotWithDefaultTemplates(await fetchDocs());
        set({
          pages: snapshot.pages,
          folders: snapshot.folders,
          activePageId: snapshot.activePageId,
          isLoading: false,
        });
      } catch (error) {
        set({
          isLoading: false,
          error: error instanceof Error ? error.message : 'Не удалось загрузить документы',
        });
      }
    },

    saveCurrentDocs: async () => {
      await saveSnapshot(docsSnapshotFromState(get()));
    },

    addPage: (title, parentId) => {
      const pages = get().pages;
      const siblings = pages.filter((p) => p.parentId === parentId);
      const newPage: DocPage = {
        id: generateId(),
        title,
        content: `# ${title}\n\nНачните писать здесь...`,
        parentId,
        order: siblings.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      updateDocs((state) => ({
        pages: [...state.pages, newPage],
        folders: state.folders,
        activePageId: newPage.id,
      }));
      return newPage;
    },

    createPageFromTemplate: (templateId, values) => {
      const template = get().pages.find((page) => page.id === templateId && page.isTemplate);
      if (!template) return null;

      const content = renderTemplate(template.content, values);
      const parentId = null;
      const siblings = get().pages.filter((page) => page.parentId === parentId && !page.isTemplate);
      const newPage: DocPage = {
        id: generateId(),
        title: titleFromContent(content, template.title),
        content,
        parentId,
        order: siblings.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      updateDocs((state) => ({
        pages: [...state.pages, newPage],
        folders: state.folders,
        activePageId: newPage.id,
      }));
      return newPage;
    },

    updatePage: (id, updates) => {
      updateDocs((state) => ({
        pages: state.pages.map((p) =>
          p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
        ),
        folders: state.folders,
        activePageId: state.activePageId,
      }));
    },

    deletePage: (id) => {
      updateDocs((state) => ({
        pages: state.pages.filter((p) => p.id !== id),
        folders: state.folders,
        activePageId: state.activePageId === id ? null : state.activePageId,
      }));
    },

    setActivePage: (id) => {
      updateDocs((state) => ({
        pages: state.pages,
        folders: state.folders,
        activePageId: id,
      }));
    },

    addFolder: (title, parentId) => {
      const folders = get().folders;
      const siblings = folders.filter((f) => f.parentId === parentId);
      const newFolder: DocFolder = {
        id: generateId(),
        title,
        parentId,
        order: siblings.length,
        isExpanded: true,
      };
      updateDocs((state) => ({
        pages: state.pages,
        folders: [...state.folders, newFolder],
        activePageId: state.activePageId,
      }));
      return newFolder;
    },

    updateFolder: (id, updates) => {
      updateDocs((state) => ({
        pages: state.pages,
        folders: state.folders.map((f) =>
          f.id === id ? { ...f, ...updates } : f
        ),
        activePageId: state.activePageId,
      }));
    },

    deleteFolder: (id) => {
      const state = get();
      const childPageIds = state.pages
        .filter((p) => p.parentId === id)
        .map((p) => p.id);
      const childFolderIds = state.folders
        .filter((f) => f.parentId === id)
        .map((f) => f.id);

      updateDocs((current) => ({
        folders: current.folders.filter(
          (f) => f.id !== id && !childFolderIds.includes(f.id)
        ),
        pages: current.pages.filter(
          (p) => !childPageIds.includes(p.id) && p.parentId !== id
        ),
        activePageId:
          current.activePageId && childPageIds.includes(current.activePageId)
            ? null
            : current.activePageId,
      }));
    },

    toggleFolder: (id) => {
      updateDocs((state) => ({
        pages: state.pages,
        folders: state.folders.map((f) =>
          f.id === id ? { ...f, isExpanded: !f.isExpanded } : f
        ),
        activePageId: state.activePageId,
      }));
    },

    toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
    setSearchQuery: (query) => set({ searchQuery: query }),

    reorderPage: (id, newOrder) => {
      updateDocs((state) => ({
        pages: state.pages.map((p) =>
          p.id === id ? { ...p, order: newOrder } : p
        ),
        folders: state.folders,
        activePageId: state.activePageId,
      }));
    },
  };
});

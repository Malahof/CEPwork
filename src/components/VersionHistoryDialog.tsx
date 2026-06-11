import { useEffect, useMemo, useState } from 'react';
import { History, RotateCcw, X } from 'lucide-react';
import { fetchDocsVersion, fetchDocsVersions } from '../api/docsApi';
import type { DocsSnapshot, DocsVersion } from '../types';

interface VersionHistoryDialogProps {
  currentSnapshot: DocsSnapshot;
  onClose: () => void;
  onRestore: (versionId: string) => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function snapshotSummary(snapshot: DocsSnapshot): string {
  const titles = snapshot.pages
    .slice()
    .sort((a, b) => a.order - b.order)
    .slice(0, 5)
    .map((page) => page.title)
    .join(', ');

  return [
    `Страниц: ${snapshot.pages.length}`,
    `Папок: ${snapshot.folders.length}`,
    `Активная: ${snapshot.activePageId ?? 'не выбрана'}`,
    titles ? `Первые страницы: ${titles}` : 'Страниц нет',
  ].join(' · ');
}

export function VersionHistoryDialog({
  currentSnapshot,
  onClose,
  onRestore,
}: VersionHistoryDialogProps) {
  const [versions, setVersions] = useState<DocsVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<DocsSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isVersionLoading, setIsVersionLoading] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.versionId === selectedVersionId) ?? null,
    [selectedVersionId, versions]
  );

  useEffect(() => {
    let isMounted = true;

    async function loadVersions() {
      setIsLoading(true);
      setError(null);
      try {
        const loaded = await fetchDocsVersions();
        if (isMounted) {
          setVersions(loaded);
          setSelectedVersionId(loaded[0]?.versionId ?? null);
        }
      } catch (error) {
        if (isMounted) {
          setError(error instanceof Error ? error.message : 'Не удалось загрузить историю');
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    void loadVersions();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadSelectedVersion(versionId: string) {
      setIsVersionLoading(true);
      setError(null);
      try {
        const snapshot = await fetchDocsVersion(versionId);
        if (isMounted) setSelectedSnapshot(snapshot);
      } catch (error) {
        if (isMounted) {
          setError(error instanceof Error ? error.message : 'Не удалось загрузить версию');
          setSelectedSnapshot(null);
        }
      } finally {
        if (isMounted) setIsVersionLoading(false);
      }
    }

    if (selectedVersionId) {
      void loadSelectedVersion(selectedVersionId);
    }

    return () => {
      isMounted = false;
    };
  }, [selectedVersionId]);

  async function handleRestore() {
    if (!selectedVersionId) return;
    const confirmed = window.confirm(
      'Восстановление версии перезапишет весь проект. Текущее состояние будет сохранено как новая версия. Продолжить?'
    );
    if (!confirmed) return;

    setIsRestoring(true);
    setError(null);
    try {
      await onRestore(selectedVersionId);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось восстановить версию');
    } finally {
      setIsRestoring(false);
    }
  }

  return (
    <div className="template-dialog-backdrop">
      <section className="template-dialog history-dialog" aria-label="История версий">
        <header className="template-dialog-header">
          <div>
            <div className="template-dialog-eyebrow">История проекта</div>
            <h2>История версий</h2>
            <p>Восстановление версии перезапишет все страницы, папки и активный документ.</p>
          </div>
          <button className="icon-btn" type="button" aria-label="Закрыть" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="history-dialog-body">
          <aside className="history-version-list">
            {isLoading ? (
              <p className="template-empty">Загрузка истории...</p>
            ) : versions.length === 0 ? (
              <p className="template-empty">Версий пока нет. Сохраните проект, чтобы появилась история.</p>
            ) : (
              versions.map((version) => (
                <button
                  className={`history-version-item ${
                    version.versionId === selectedVersionId ? 'active' : ''
                  }`}
                  key={version.versionId}
                  type="button"
                  onClick={() => setSelectedVersionId(version.versionId)}
                >
                  <History size={15} />
                  <span>
                    <strong>{new Date(version.timestamp).toLocaleString('ru-RU')}</strong>
                    <small>{formatBytes(version.fileSize)}</small>
                  </span>
                </button>
              ))
            )}
          </aside>

          <section className="history-version-details">
            {error && <div className="editor-error">{error}</div>}
            <div className="history-warning">
              Восстановление применяется ко всему JSON-снапшоту проекта, а не только к текущей странице.
            </div>
            <div className="history-summary-grid">
              <div>
                <h3>Текущее состояние</h3>
                <p>{snapshotSummary(currentSnapshot)}</p>
              </div>
              <div>
                <h3>Выбранная версия</h3>
                {isVersionLoading ? (
                  <p>Загрузка версии...</p>
                ) : selectedSnapshot ? (
                  <p>{snapshotSummary(selectedSnapshot)}</p>
                ) : (
                  <p>Выберите версию из списка.</p>
                )}
              </div>
            </div>
            {selectedVersion && (
              <p className="history-version-id">
                ID версии: <code>{selectedVersion.versionId}</code>
              </p>
            )}
          </section>
        </div>

        <footer className="history-dialog-actions">
          <button className="btn btn-secondary btn-sm" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={!selectedVersionId || isRestoring}
            onClick={handleRestore}
          >
            <RotateCcw size={14} />
            <span>{isRestoring ? 'Восстановление...' : 'Восстановить эту версию'}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}

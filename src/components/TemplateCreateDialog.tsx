import { useMemo } from 'react';
import type { FormEvent } from 'react';
import { FilePlus, X } from 'lucide-react';
import type { DocPage } from '../types';

interface TemplateCreateDialogProps {
  template: DocPage;
  onClose: () => void;
  onCreate: (values: Record<string, string>) => void;
}

export function TemplateCreateDialog({ template, onClose, onCreate }: TemplateCreateDialogProps) {
  const variables = useMemo(() => template.templateVariables ?? [], [template.templateVariables]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const values = Object.fromEntries(
      variables.map((variable) => [variable.key, String(formData.get(variable.key) ?? '')])
    );
    onCreate(values);
  }

  return (
    <div className="template-dialog-backdrop" role="presentation">
      <div className="template-dialog" role="dialog" aria-modal="true" aria-labelledby="template-dialog-title">
        <div className="template-dialog-header">
          <div>
            <span className="template-dialog-eyebrow">Шаблон</span>
            <h2 id="template-dialog-title">Создать из шаблона</h2>
            <p>{template.title}</p>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>

        <form className="template-dialog-form" onSubmit={handleSubmit}>
          {variables.map((variable) => (
            <label key={variable.key} className="template-field">
              <span>{variable.label}</span>
              <textarea
                name={variable.key}
                defaultValue={variable.defaultValue ?? ''}
                placeholder={variable.placeholder}
              />
            </label>
          ))}

          {variables.length === 0 && (
            <p className="template-empty">У этого шаблона нет переменных. Будет создана копия страницы.</p>
          )}

          <div className="template-dialog-actions">
            <button className="btn btn-secondary btn-sm" type="button" onClick={onClose}>
              Отмена
            </button>
            <button className="btn btn-primary btn-sm" type="submit">
              <FilePlus size={14} />
              <span>Создать документ</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

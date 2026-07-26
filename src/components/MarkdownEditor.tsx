import { useCallback, useRef } from 'react';
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Code,
  Quote,
  Link,
  Image,
  Table,
  Minus,
} from 'lucide-react';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}

interface ToolbarAction {
  icon: React.ReactNode;
  title: string;
  action: (textarea: HTMLTextAreaElement) => { text: string; cursorOffset: number };
}

const toolbarActions: ToolbarAction[] = [
  {
    icon: <Bold size={16} />,
    title: 'Жирный (Ctrl+B)',
    action: (ta) => wrapSelection(ta, '**', '**'),
  },
  {
    icon: <Italic size={16} />,
    title: 'Курсив (Ctrl+I)',
    action: (ta) => wrapSelection(ta, '*', '*'),
  },
  {
    icon: <Heading1 size={16} />,
    title: 'Заголовок 1',
    action: (ta) => prefixLine(ta, '# '),
  },
  {
    icon: <Heading2 size={16} />,
    title: 'Заголовок 2',
    action: (ta) => prefixLine(ta, '## '),
  },
  {
    icon: <Heading3 size={16} />,
    title: 'Заголовок 3',
    action: (ta) => prefixLine(ta, '### '),
  },
  {
    icon: <List size={16} />,
    title: 'Маркированный список',
    action: (ta) => prefixLine(ta, '- '),
  },
  {
    icon: <ListOrdered size={16} />,
    title: 'Нумерованный список',
    action: (ta) => prefixLine(ta, '1. '),
  },
  {
    icon: <Code size={16} />,
    title: 'Код',
    action: (ta) => {
      const sel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
      if (sel.includes('\n')) {
        return wrapSelection(ta, '```\n', '\n```');
      }
      return wrapSelection(ta, '`', '`');
    },
  },
  {
    icon: <Quote size={16} />,
    title: 'Цитата',
    action: (ta) => prefixLine(ta, '> '),
  },
  {
    icon: <Link size={16} />,
    title: 'Ссылка',
    action: (ta) => insertAtCursor(ta, '[текст](url)'),
  },
  {
    icon: <Image size={16} />,
    title: 'Изображение',
    action: (ta) => insertAtCursor(ta, '![alt](url)'),
  },
  {
    icon: <Table size={16} />,
    title: 'Таблица',
    action: (ta) =>
      insertAtCursor(
        ta,
        '\n| Заголовок 1 | Заголовок 2 |\n|-------------|-------------|\n| Ячейка 1    | Ячейка 2    |\n'
      ),
  },
  {
    icon: <Minus size={16} />,
    title: 'Горизонтальная линия',
    action: (ta) => insertAtCursor(ta, '\n---\n'),
  },
];

function wrapSelection(
  ta: HTMLTextAreaElement,
  before: string,
  after: string
): { text: string; cursorOffset: number } {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.substring(start, end);
  const replacement = before + (selected || 'текст') + after;
  const text = ta.value.substring(0, start) + replacement + ta.value.substring(end);
  const cursorOffset = selected
    ? start + replacement.length
    : start + before.length;
  return { text, cursorOffset };
}

function prefixLine(
  ta: HTMLTextAreaElement,
  prefix: string
): { text: string; cursorOffset: number } {
  const start = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
  const text =
    ta.value.substring(0, lineStart) + prefix + ta.value.substring(lineStart);
  return { text, cursorOffset: start + prefix.length };
}

function insertAtCursor(
  ta: HTMLTextAreaElement,
  insert: string
): { text: string; cursorOffset: number } {
  const start = ta.selectionStart;
  const text =
    ta.value.substring(0, start) + insert + ta.value.substring(ta.selectionEnd);
  return { text, cursorOffset: start + insert.length };
}

export function MarkdownEditor({ value, onChange, readOnly = false }: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleToolbarClick = useCallback(
    (action: ToolbarAction) => {
      if (readOnly) return;
      const ta = textareaRef.current;
      if (!ta) return;
      const { text, cursorOffset } = action.action(ta);
      onChange(text);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(cursorOffset, cursorOffset);
      });
    },
    [onChange, readOnly]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (readOnly) return;
      const ta = textareaRef.current;
      if (!ta) return;

      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        const { text, cursorOffset } = wrapSelection(ta, '**', '**');
        onChange(text);
        requestAnimationFrame(() => {
          ta.setSelectionRange(cursorOffset, cursorOffset);
        });
      }
      if (e.ctrlKey && e.key === 'i') {
        e.preventDefault();
        const { text, cursorOffset } = wrapSelection(ta, '*', '*');
        onChange(text);
        requestAnimationFrame(() => {
          ta.setSelectionRange(cursorOffset, cursorOffset);
        });
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = ta.selectionStart;
        const newText =
          ta.value.substring(0, start) + '  ' + ta.value.substring(ta.selectionEnd);
        onChange(newText);
        requestAnimationFrame(() => {
          ta.setSelectionRange(start + 2, start + 2);
        });
      }
    },
    [onChange, readOnly]
  );

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        {toolbarActions.map((action, i) => (
          <button
            key={i}
            className="toolbar-btn"
            title={action.title}
            disabled={readOnly}
            onClick={() => handleToolbarClick(action)}
          >
            {action.icon}
          </button>
        ))}
      </div>
      {readOnly && <div className="editor-readonly-banner">Шаблон доступен только для чтения. Метки можно копировать.</div>}
      <textarea
        ref={textareaRef}
        className="editor-textarea"
        value={value}
        onChange={(e) => {
          if (!readOnly) onChange(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Начните писать в Markdown..."
        readOnly={readOnly}
        spellCheck={false}
      />
    </div>
  );
}

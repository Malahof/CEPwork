import { useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import { Download } from 'lucide-react';
import { exportToHtml } from '../utils/exportUtils';

interface MarkdownPreviewProps {
  content: string;
  title: string;
}

export function MarkdownPreview({ content, title }: MarkdownPreviewProps) {
  const previewRef = useRef<HTMLDivElement>(null);

  function handleExport() {
    if (!previewRef.current) return;
    exportToHtml(title, previewRef.current.innerHTML);
  }

  return (
    <div className="preview-pane">
      <div className="preview-header">
        <span className="preview-label">Предпросмотр</span>
        <button className="btn btn-secondary btn-sm" onClick={handleExport}>
          <Download size={14} />
          <span>Экспорт HTML</span>
        </button>
      </div>
      <div className="preview-content" ref={previewRef}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

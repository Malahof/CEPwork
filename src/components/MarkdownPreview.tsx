import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import { Download, FileText } from 'lucide-react';
import { exportToHtml } from '../utils/exportUtils';
import { exportToDocx } from '../utils/docxExport';

interface MarkdownPreviewProps {
  content: string;
  title: string;
}

export function MarkdownPreview({ content, title }: MarkdownPreviewProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [docxLoading, setDocxLoading] = useState(false);

  function handleExportHtml() {
    if (!previewRef.current) return;
    exportToHtml(title, previewRef.current.innerHTML);
  }

  async function handleExportDocx() {
    setDocxLoading(true);
    try {
      await exportToDocx(title, content);
    } finally {
      setDocxLoading(false);
    }
  }

  return (
    <div className="preview-pane">
      <div className="preview-header">
        <span className="preview-label">Предпросмотр</span>
        <div className="preview-actions">
          <button className="btn btn-secondary btn-sm" onClick={handleExportHtml}>
            <Download size={14} />
            <span>HTML</span>
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleExportDocx}
            disabled={docxLoading}
          >
            <FileText size={14} />
            <span>{docxLoading ? 'Экспорт...' : 'DOCX'}</span>
          </button>
        </div>
      </div>
      <div className="preview-content" ref={previewRef}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

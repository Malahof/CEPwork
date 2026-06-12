export interface TemplateVariable {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
}

export interface DocPage {
  id: string;
  title: string;
  content: string;
  parentId: string | null;
  order: number;
  createdAt: number;
  updatedAt: number;
  isTemplate?: boolean;
  templateVariables?: TemplateVariable[];
}

export interface DocFolder {
  id: string;
  title: string;
  parentId: string | null;
  order: number;
  isExpanded: boolean;
}

export interface DocsSnapshot {
  pages: DocPage[];
  folders: DocFolder[];
  activePageId: string | null;
}

export type TreeItem = DocPage | DocFolder;

export interface AgentOption {
  key: string;
  label: string;
}

export interface AgentMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
  createdAt: number;
}

export interface AgentExtractedFile {
  name: string;
  type: string;
  text: string;
  mimeType?: string;
  size?: number;
  uploadedAt?: number;
}

export interface AgentGeneratedDocument {
  id: string;
  title: string;
}

export interface AgentProject {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: 'selecting' | 'awaiting_case_query' | 'awaiting_case_confirmation' | 'package_selected' | 'completed';
  currentNode: string | null;
  selections: Record<string, { answer: string; label: string }>;
  extractedData: {
    fileContents?: AgentExtractedFile[];
    [key: string]: unknown;
  };
  history: AgentMessage[];
  question: string | null;
  availableOptions: AgentOption[];
  packageCode?: string;
  packageTitle?: string;
  documents?: string[];
  matchedCaseId?: string | null;
  caseData?: Record<string, unknown> | null;
  pendingCaseId?: string | null;
  pendingCaseTitle?: string | null;
  generation?: {
    status: 'completed' | 'failed';
    documents?: AgentGeneratedDocument[];
    error?: string;
    updatedAt?: number;
  };
}

export function isDocPage(item: TreeItem): item is DocPage {
  return 'content' in item;
}

export function isDocFolder(item: TreeItem): item is DocFolder {
  return 'isExpanded' in item;
}

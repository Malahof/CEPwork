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

export interface AgentProject {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: 'selecting' | 'package_selected' | 'completed';
  currentNode: string | null;
  selections: Record<string, { answer: string; label: string }>;
  extractedData: Record<string, unknown>;
  history: AgentMessage[];
  question: string | null;
  availableOptions: AgentOption[];
  packageCode?: string;
  packageTitle?: string;
  documents?: string[];
}

export function isDocPage(item: TreeItem): item is DocPage {
  return 'content' in item;
}

export function isDocFolder(item: TreeItem): item is DocFolder {
  return 'isExpanded' in item;
}

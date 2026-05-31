import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent, PhrasingContent, TableCell as MdTableCell } from 'mdast';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ExternalHyperlink,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  ShadingType,
  LevelFormat,
} from 'docx';

const NUMBERING_REF = 'doc-ordered-list';
const MONO_FONT = 'Courier New';
const CODE_SHADING = 'F0F0F5';
const HEADER_SHADING = 'F5F6FA';

type InlineStyle = {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
};

const headingLevels = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

type InlineChild = TextRun | ExternalHyperlink;

function parseMarkdown(markdown: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
}

function processInline(
  nodes: PhrasingContent[],
  style: InlineStyle
): InlineChild[] {
  const runs: InlineChild[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        runs.push(new TextRun({ text: node.value, ...style }));
        break;
      case 'strong':
        runs.push(...processInline(node.children, { ...style, bold: true }));
        break;
      case 'emphasis':
        runs.push(...processInline(node.children, { ...style, italics: true }));
        break;
      case 'delete':
        runs.push(...processInline(node.children, { ...style, strike: true }));
        break;
      case 'inlineCode':
        runs.push(
          new TextRun({
            text: node.value,
            font: MONO_FONT,
            shading: { type: ShadingType.CLEAR, fill: CODE_SHADING },
            ...style,
          })
        );
        break;
      case 'break':
        runs.push(new TextRun({ break: 1 }));
        break;
      case 'link': {
        const label = mdToPlainText(node.children) || node.url;
        runs.push(
          new ExternalHyperlink({
            link: node.url,
            children: [new TextRun({ text: label, style: 'Hyperlink', ...style })],
          })
        );
        break;
      }
      case 'image':
        runs.push(new TextRun({ text: node.alt || node.url, italics: true }));
        break;
      default:
        if ('children' in node && Array.isArray(node.children)) {
          runs.push(
            ...processInline(node.children as PhrasingContent[], style)
          );
        }
        break;
    }
  }

  return runs;
}

function mdToPlainText(nodes: PhrasingContent[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text' || n.type === 'inlineCode') return n.value;
      if ('children' in n && Array.isArray(n.children)) {
        return mdToPlainText(n.children as PhrasingContent[]);
      }
      return '';
    })
    .join('');
}

function processListItems(
  items: RootContent[],
  ordered: boolean,
  level: number
): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  for (const item of items) {
    if (item.type !== 'listItem') continue;

    for (const child of item.children) {
      if (child.type === 'paragraph') {
        paragraphs.push(
          new Paragraph({
            children: processInline(child.children, {}),
            ...(ordered
              ? { numbering: { reference: NUMBERING_REF, level } }
              : { bullet: { level } }),
            spacing: { after: 60 },
          })
        );
      } else if (child.type === 'list') {
        paragraphs.push(
          ...processListItems(child.children, !!child.ordered, level + 1)
        );
      }
    }
  }

  return paragraphs;
}

function processTableCell(cell: MdTableCell): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: processInline(cell.children, {}) })],
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
  });
}

function processTable(rows: RootContent[]): Table {
  const tableRows: TableRow[] = [];

  rows.forEach((row, rowIndex) => {
    if (row.type !== 'tableRow') return;
    const isHeader = rowIndex === 0;
    const cells = row.children.map((cell) => {
      const tc = processTableCell(cell);
      if (isHeader) {
        return new TableCell({
          children: [
            new Paragraph({
              children: processInline(cell.children, { bold: true }),
            }),
          ],
          shading: { type: ShadingType.CLEAR, fill: HEADER_SHADING },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
        });
      }
      return tc;
    });
    tableRows.push(new TableRow({ children: cells, tableHeader: isHeader }));
  });

  return new Table({
    rows: tableRows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

function processBlock(node: RootContent): (Paragraph | Table)[] {
  switch (node.type) {
    case 'heading':
      return [
        new Paragraph({
          children: processInline(node.children, {}),
          heading: headingLevels[node.depth - 1] || HeadingLevel.HEADING_6,
          spacing: { before: 240, after: 120 },
        }),
      ];
    case 'paragraph':
      return [
        new Paragraph({
          children: processInline(node.children, {}),
          spacing: { after: 120 },
        }),
      ];
    case 'list':
      return processListItems(node.children, !!node.ordered, 0);
    case 'code': {
      const lines = node.value.split('\n');
      return lines.map(
        (line, i) =>
          new Paragraph({
            children: [new TextRun({ text: line || ' ', font: MONO_FONT, size: 18 })],
            shading: { type: ShadingType.CLEAR, fill: CODE_SHADING },
            spacing: {
              before: i === 0 ? 120 : 0,
              after: i === lines.length - 1 ? 120 : 0,
            },
          })
      );
    }
    case 'blockquote': {
      const result: (Paragraph | Table)[] = [];
      for (const child of node.children) {
        if (child.type === 'paragraph') {
          result.push(
            new Paragraph({
              children: processInline(child.children, { italics: true }),
              indent: { left: 360 },
              border: {
                left: { style: BorderStyle.SINGLE, size: 18, color: '667EEA', space: 12 },
              },
              spacing: { after: 120 },
            })
          );
        } else {
          result.push(...processBlock(child));
        }
      }
      return result;
    }
    case 'thematicBreak':
      return [
        new Paragraph({
          text: '',
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 1 },
          },
          spacing: { before: 120, after: 120 },
        }),
      ];
    case 'table':
      return [processTable(node.children)];
    default:
      return [];
  }
}

export async function exportToDocx(title: string, markdown: string): Promise<void> {
  const tree = parseMarkdown(markdown);

  const content: (Paragraph | Table)[] = [];
  for (const node of tree.children) {
    content.push(...processBlock(node));
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: NUMBERING_REF,
          levels: [0, 1, 2, 3].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
          })),
        },
      ],
    },
    sections: [
      {
        children: content.length
          ? content
          : [new Paragraph({ children: [new TextRun('')] })],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_')}.docx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

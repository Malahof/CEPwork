import multer from 'multer';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseDocx } from './parsers/docxParser.js';
import { parseImage } from './parsers/imageOcr.js';
import { parsePdf } from './parsers/pdfParser.js';
import { parseXlsx } from './parsers/xlsxParser.js';

const maxUploadBytes = 10 * 1024 * 1024;

const supportedTypes = [
  {
    type: 'docx',
    extensions: ['.docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    parse: parseDocx,
  },
  {
    type: 'xlsx',
    extensions: ['.xlsx', '.xls'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ],
    parse: parseXlsx,
  },
  {
    type: 'pdf',
    extensions: ['.pdf'],
    mimeTypes: ['application/pdf'],
    parse: parsePdf,
  },
  {
    type: 'image',
    extensions: ['.jpg', '.jpeg', '.png'],
    mimeTypes: ['image/jpeg', 'image/png'],
    parse: parseImage,
  },
];

export function createUploadMiddleware(uploadsDir) {
  const storage = multer.diskStorage({
    destination: async (_req, _file, callback) => {
      try {
        await mkdir(uploadsDir, { recursive: true });
        callback(null, uploadsDir);
      } catch (error) {
        callback(error);
      }
    },
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${Date.now()}-${randomUUID()}${extension}`);
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: maxUploadBytes,
    },
  });
}

export async function parseUploadedFile(file) {
  const typeDefinition = detectUploadType(file);
  if (!typeDefinition) {
    const error = new Error('Неподдерживаемый тип файла');
    error.statusCode = 415;
    throw error;
  }

  const text = await typeDefinition.parse(file.path);
  return {
    name: file.originalname,
    type: typeDefinition.type,
    mimeType: file.mimetype,
    size: file.size,
    uploadedAt: Date.now(),
    text,
  };
}

function detectUploadType(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  return supportedTypes.find(
    (item) => item.mimeTypes.includes(file.mimetype) || item.extensions.includes(extension)
  );
}

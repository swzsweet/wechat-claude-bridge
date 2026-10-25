import { extname } from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { marked } from 'marked';

const MAX_TEXT = 30000;

function bounded(text) {
  const clean = String(text || '').replace(/\u0000/g, '').trim();
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}\n[文档内容已截断]` : clean;
}

export async function extractDocumentText(name, bytes) {
  const ext = extname(name).toLowerCase();
  if (ext === '.doc' || ext === '.xls')
    throw new Error('旧版 .doc/.xls 暂不能读取，请转换为 .docx/.xlsx 后发送');
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return bounded(result.value);
  }
  if (ext === '.pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true,
      disableFontFace: true });
    const document = await loadingTask.promise;
    try {
      const pages = [];
      for (let i = 1; i <= Math.min(document.numPages, 30); i++) {
        const page = await document.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map((item) => item.str || '').join(' ').trim();
        if (text) pages.push(`第 ${i} 页\n${text}`);
        if (pages.join('\n\n').length >= MAX_TEXT) break;
      }
      return bounded(pages.join('\n\n'));
    } finally { await loadingTask.destroy(); }
  }
  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const sheets = [];
    for (const sheet of workbook.worksheets.slice(0, 10)) {
      const rows = [`工作表：${sheet.name}`];
      sheet.eachRow((row, number) => {
        if (number > 200 || rows.join('\n').length >= MAX_TEXT) return;
        rows.push(`${number}: ${row.values.slice(1, 21).map((cell) =>
          typeof cell === 'object' && cell !== null ? cell.result ?? cell.text ?? '' : cell ?? '').join(' | ')}`);
      });
      sheets.push(rows.join('\n'));
      if (sheets.join('\n\n').length >= MAX_TEXT) break;
    }
    return bounded(sheets.join('\n\n'));
  }
  if (['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.yaml', '.yml'].includes(ext)) {
    if (bytes.includes(0)) throw new Error('文件不是可读取的文本');
    return bounded(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  }
  return null;
}

function inlineRuns(tokens, style = {}) {
  return (tokens || []).flatMap((token) => {
    if (token.type === 'br') return new TextRun({ text: '\n', ...style });
    const next = token.type === 'strong' ? { ...style, bold: true }
      : token.type === 'em' ? { ...style, italics: true }
        : token.type === 'codespan' ? { ...style, font: 'Consolas' } : style;
    if (token.tokens?.length) return inlineRuns(token.tokens, next);
    return new TextRun({ text: token.text || '', ...next });
  });
}

function wordParagraphs(markdown) {
  const paragraphs = [];
  for (const token of marked.lexer(markdown)) {
    if (token.type === 'space') continue;
    if (token.type === 'heading') {
      const heading = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][Math.min(token.depth, 4) - 1];
      paragraphs.push(new Paragraph({ heading, children: inlineRuns(token.tokens) }));
    } else if (token.type === 'paragraph') {
      paragraphs.push(new Paragraph({ children: inlineRuns(token.tokens), spacing: { after: 160 } }));
    } else if (token.type === 'list') {
      token.items.forEach((item, index) => paragraphs.push(new Paragraph({
        children: [new TextRun(token.ordered ? `${(token.start || 1) + index}. ` : '• '),
          ...inlineRuns(marked.Lexer.lexInline(item.text))],
        indent: { left: 360 }, spacing: { after: 80 }
      })));
    } else if (token.type === 'code') {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: token.text, font: 'Consolas' })],
        spacing: { before: 100, after: 160 } }));
    } else if (token.type === 'blockquote') {
      paragraphs.push(new Paragraph({ children: inlineRuns(marked.Lexer.lexInline(token.text)),
        indent: { left: 360 }, spacing: { after: 160 } }));
    } else if (token.type === 'table') {
      paragraphs.push(new Paragraph({ children: [new TextRun({
        text: token.header.map((cell) => cell.text).join(' | '), bold: true })] }));
      token.rows.forEach((row) => paragraphs.push(new Paragraph({
        text: row.map((cell) => cell.text).join(' | ') })));
    } else if (token.type === 'hr') paragraphs.push(new Paragraph({ text: '────────' }));
    else if (token.text) paragraphs.push(new Paragraph({ text: token.text }));
  }
  return paragraphs.length ? paragraphs : [new Paragraph({ text: markdown })];
}

export async function createWordDocument(markdown) {
  const document = new Document({ sections: [{ children: wordParagraphs(markdown) }] });
  return Packer.toBuffer(document);
}

function inlineText(tokens) {
  return (tokens || []).map((token) => token.tokens?.length ? inlineText(token.tokens)
    : token.type === 'br' ? '\n' : token.text || '').join('');
}

export function plainDocumentText(markdown) {
  return marked.lexer(markdown).map((token) => {
    if (token.type === 'list') return token.items.map((item, index) =>
      `${token.ordered ? `${(token.start || 1) + index}.` : '-'} ${inlineText(marked.Lexer.lexInline(item.text))}`).join('\n');
    if (token.type === 'table') return [token.header, ...token.rows].map((row) =>
      row.map((cell) => inlineText(cell.tokens)).join(' | ')).join('\n');
    return token.tokens?.length ? inlineText(token.tokens) : token.text || '';
  }).filter(Boolean).join('\n\n');
}

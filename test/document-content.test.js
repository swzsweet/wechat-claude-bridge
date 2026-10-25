import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseCommand } from '../src/common.js';
import { createWordDocument, extractDocumentText, plainDocumentText } from '../src/document-content.js';

function simplePdf(stream = 'BT /F1 14 Tf 72 720 Td (Hello PDF) Tj ET') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('Word export preserves headings and emphasis and can be read back', async () => {
  const bytes = await createWordDocument('# 检查计划\n\n- **核对库存**\n- 复查测试');
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  const text = await extractDocumentText('plan.docx', bytes);
  assert.match(text, /检查计划/);
  assert.match(text, /核对库存/);
  assert.match(text, /复查测试/);
  assert.equal(plainDocumentText('# 标题\n\n**重点** 内容'), '标题\n\n重点 内容');
});

test('PDF and Excel attachments yield bounded readable text', async () => {
  assert.match(await extractDocumentText('report.pdf', simplePdf()), /Hello PDF/);
  assert.equal(await extractDocumentText('scan.pdf', simplePdf('')), '');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('库存');
  sheet.addRow(['商品', '数量']);
  sheet.addRow(['纸箱', 42]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  assert.match(await extractDocumentText('stock.xlsx', bytes), /库存[\s\S]*纸箱 \| 42/);
  assert.equal(await extractDocumentText('notes.txt', Buffer.from('说明')), '说明');
});

test('legacy Office formats are reported honestly', async () => {
  await assert.rejects(() => extractDocumentText('old.doc', Buffer.from('x')), /转换为 .docx/);
  await assert.rejects(() => extractDocumentText('old.xls', Buffer.from('x')), /转换为 .docx/);
  assert.equal(await extractDocumentText('archive.zip', Buffer.from('x')), null);
});

test('export command accepts Word, Markdown, and plain text formats', () => {
  assert.deepEqual(parseCommand('/export A1B2C3D4'),
    { type: 'export', id: 'A1B2C3D4', format: 'docx' });
  assert.deepEqual(parseCommand('/export a1b2c3d4 txt'),
    { type: 'export', id: 'A1B2C3D4', format: 'txt' });
  assert.equal(parseCommand('/export A1B2C3D4 pdf').type, 'usage');
});

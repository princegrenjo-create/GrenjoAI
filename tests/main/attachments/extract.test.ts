/**
 * Classification and text extraction against real generated files.
 *
 * Every fixture is written under the run sink (`scratchDir`) and removed in the
 * same test run; nothing binary is checked into the repository. The PDF and DOCX
 * are real containers because the point of these tests is that `unpdf` and
 * `mammoth` actually read the bytes this application hands them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '@shared/attachments';
import { classifyFile, extractText, extractTextFromBytes } from '@main/attachments/extract';
import { buildDocx, buildPdf } from './fixtures';
import { scratchDir, type ScratchDir } from '../../helpers/tmp';

let scratch: ScratchDir | null = null;

afterEach(() => {
  scratch?.cleanup();
  scratch = null;
});

function ensureScratch(): ScratchDir {
  if (scratch === null) scratch = scratchDir('attachments-extract');
  return scratch;
}

function writeFixture(name: string, data: Buffer | string): string {
  const filePath = path.join(ensureScratch().path, name);
  fs.writeFileSync(filePath, data);
  return filePath;
}

describe('classifyFile', () => {
  it('classifies every supported text-like extension as text', () => {
    const extensions = [
      'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'css',
      'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'h',
      'cs', 'php', 'sh', 'ps1', 'sql', 'ini', 'toml', 'conf', 'log',
    ];
    for (const extension of extensions) {
      const classification = classifyFile({
        name: `sample.${extension}`,
        mimeType: 'application/octet-stream',
        sizeBytes: 10,
      });
      expect(classification.kind, extension).toBe('text');
      expect(classification.mimeType.length, extension).toBeGreaterThan(0);
    }
  });

  it('classifies PDF and DOCX as text documents', () => {
    expect(classifyFile({ name: 'report.PDF', mimeType: '', sizeBytes: 10 })).toEqual({
      kind: 'text',
      mimeType: 'application/pdf',
    });
    expect(classifyFile({ name: 'notes.docx', mimeType: '', sizeBytes: 10 }).kind).toBe('text');
  });

  it('classifies images and audio by extension', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
      expect(classifyFile({ name: `x.${extension}`, mimeType: '', sizeBytes: 10 }).kind).toBe('image');
    }
    for (const extension of ['webm', 'ogg', 'wav', 'mp3', 'm4a']) {
      expect(classifyFile({ name: `x.${extension}`, mimeType: '', sizeBytes: 10 }).kind).toBe('audio');
    }
  });

  it('falls back to a declared text MIME type when the extension says nothing', () => {
    expect(classifyFile({ name: 'README', mimeType: 'text/plain', sizeBytes: 4 })).toEqual({
      kind: 'text',
      mimeType: 'text/plain',
    });
  });

  it('marks everything else unsupported', () => {
    expect(classifyFile({ name: 'setup.exe', mimeType: '', sizeBytes: 10 }).kind).toBe('unsupported');
    expect(classifyFile({ name: 'archive.zip', mimeType: '', sizeBytes: 10 }).kind).toBe('unsupported');
    expect(
      classifyFile({ name: 'blob', mimeType: 'application/octet-stream', sizeBytes: 10 }).kind,
    ).toBe('unsupported');
  });
});

describe('extractText', () => {
  it('extracts plain text and strips the UTF-8 BOM', async () => {
    const filePath = writeFixture(
      'notes.txt',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Hello, plain text.\n', 'utf8')]),
    );
    const result = await extractText({
      filePath,
      name: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: fs.statSync(filePath).size,
    });
    expect(result.contentStatus).toBe('extracted');
    expect(result.note).toBeNull();
    expect(result.text).toBe('Hello, plain text.\n');
  });

  it('extracts code and markdown files', async () => {
    const codePath = writeFixture('sample.ts', 'export const answer = 42;\n');
    const code = await extractText({
      filePath: codePath,
      name: 'sample.ts',
      mimeType: 'text/plain',
      sizeBytes: 27,
    });
    expect(code.contentStatus).toBe('extracted');
    expect(code.text).toContain('export const answer = 42;');

    const markdownPath = writeFixture('readme.md', '# Title\n\nBody.\n');
    const markdown = await extractText({
      filePath: markdownPath,
      name: 'readme.md',
      mimeType: 'text/markdown',
      sizeBytes: 15,
    });
    expect(markdown.text).toContain('# Title');
  });

  it('truncates oversized text with a visible marker', async () => {
    const body = 'a'.repeat(ATTACHMENT_LIMITS.maxExtractedChars + 500);
    const filePath = writeFixture('long.txt', body);
    const result = await extractText({
      filePath,
      name: 'long.txt',
      mimeType: 'text/plain',
      sizeBytes: body.length,
    });

    expect(result.contentStatus).toBe('extracted');
    expect(result.text?.endsWith('\n\n[truncated]')).toBe(true);
    expect(result.text?.length).toBe(ATTACHMENT_LIMITS.maxExtractedChars + '\n\n[truncated]'.length);
    expect(result.text?.startsWith('a'.repeat(100))).toBe(true);
  });

  it('refuses a binary file renamed to .txt', async () => {
    const binary = Buffer.alloc(4096);
    for (let index = 0; index < binary.length; index += 1) binary[index] = index % 3 === 0 ? 0 : 0x41;
    const filePath = writeFixture('not-really-text.txt', binary);
    const result = await extractText({
      filePath,
      name: 'not-really-text.txt',
      mimeType: 'text/plain',
      sizeBytes: binary.length,
    });

    expect(result.text).toBeNull();
    expect(result.contentStatus).toBe('failed');
    expect(result.note).toMatch(/binary/i);
  });

  it('refuses an empty file instead of returning empty text', async () => {
    const filePath = writeFixture('empty.txt', Buffer.alloc(0));
    const result = await extractText({
      filePath,
      name: 'empty.txt',
      mimeType: 'text/plain',
      sizeBytes: 0,
    });
    expect(result.text).toBeNull();
    expect(result.contentStatus).toBe('failed');
    expect(result.note).toMatch(/empty/i);
  });

  it('extracts text from a real generated PDF', async () => {
    const bytes = buildPdf('Hello from a real PDF');
    const filePath = writeFixture('real.pdf', bytes);
    const result = await extractText({
      filePath,
      name: 'real.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
    });

    expect(result.contentStatus).toBe('extracted');
    expect(result.text).toBe('Hello from a real PDF');
  });

  it('reports a password-protected PDF as encrypted, never as empty text', async () => {
    const bytes = buildPdf('secret', { encrypted: true });
    const filePath = writeFixture('protected.pdf', bytes);
    const result = await extractText({
      filePath,
      name: 'protected.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
    });

    expect(result.text).toBeNull();
    expect(result.contentStatus).toBe('failed');
    expect(result.note).toMatch(/password|encrypt/i);
  });

  it('fails a corrupt PDF with a readable sentence', async () => {
    const bytes = Buffer.from('%PDF-1.4\nthis is not a pdf body');
    const filePath = writeFixture('corrupt.pdf', bytes);
    const result = await extractText({
      filePath,
      name: 'corrupt.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
    });

    expect(result.text).toBeNull();
    expect(result.contentStatus).toBe('failed');
    expect(result.note).toMatch(/could not be read/i);
  });

  it('extracts text from a real generated DOCX', async () => {
    const bytes = buildDocx('Hello from a real DOCX');
    const filePath = writeFixture('real.docx', bytes);
    const result = await extractText({
      filePath,
      name: 'real.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: bytes.length,
    });

    expect(result.contentStatus).toBe('extracted');
    expect(result.text).toBe('Hello from a real DOCX');
  });

  it('fails a corrupt DOCX with a readable sentence', async () => {
    const bytes = Buffer.from('this is not a zip container at all');
    const filePath = writeFixture('corrupt.docx', bytes);
    const result = await extractText({
      filePath,
      name: 'corrupt.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: bytes.length,
    });

    expect(result.text).toBeNull();
    expect(result.contentStatus).toBe('failed');
    expect(result.note).toMatch(/could not be read/i);
  });

  it('refuses an unsupported file type', async () => {
    const filePath = writeFixture('setup.exe', Buffer.from('MZ binary'));
    expect(classifyFile({ name: 'setup.exe', mimeType: '', sizeBytes: 9 }).kind).toBe('unsupported');

    const result = await extractText({
      filePath,
      name: 'setup.exe',
      mimeType: 'application/octet-stream',
      sizeBytes: 9,
    });
    expect(result.contentStatus).toBe('failed');
    expect(result.note).toMatch(/not supported/i);
  });

  it('reports an unreadable path instead of throwing', async () => {
    const result = await extractText({
      filePath: path.join(ensureScratch().path, 'does-not-exist.txt'),
      name: 'does-not-exist.txt',
      mimeType: 'text/plain',
      sizeBytes: 0,
    });
    expect(result.contentStatus).toBe('failed');
    expect(result.note).toMatch(/could not be read/i);
  });

  it('refuses a file over the size limit', async () => {
    const filePath = path.join(ensureScratch().path, 'huge.txt');
    fs.writeFileSync(filePath, Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1, 0x61));
    const result = await extractText({
      filePath,
      name: 'huge.txt',
      mimeType: 'text/plain',
      sizeBytes: ATTACHMENT_LIMITS.maxFileBytes + 1,
    });
    expect(result.contentStatus).toBe('failed');
    expect(result.note).toMatch(/larger than/i);
  });

  it('extracts from bytes directly, for drag-and-drop ingestion', async () => {
    const text = await extractTextFromBytes({
      bytes: Buffer.from('dropped text', 'utf8'),
      name: 'dropped.txt',
      mimeType: 'text/plain',
    });
    expect(text.contentStatus).toBe('extracted');
    expect(text.text).toBe('dropped text');

    const pdf = await extractTextFromBytes({
      bytes: buildPdf('Dropped PDF text'),
      name: 'dropped.pdf',
      mimeType: 'application/pdf',
    });
    expect(pdf.contentStatus).toBe('extracted');
    expect(pdf.text).toContain('Dropped PDF text');

    const docx = await extractTextFromBytes({
      bytes: buildDocx('Dropped DOCX text'),
      name: 'dropped.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(docx.contentStatus).toBe('extracted');
    expect(docx.text).toContain('Dropped DOCX text');
  });

  it('marks an image as metadata-only when asked for text', async () => {
    const filePath = writeFixture('photo.png', Buffer.from('not needed'));
    const result = await extractText({
      filePath,
      name: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    });
    expect(result.text).toBeNull();
    expect(result.contentStatus).toBe('metadata-only');
  });
});

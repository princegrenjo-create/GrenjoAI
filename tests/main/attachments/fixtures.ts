/**
 * Fixture builders for the attachment tests.
 *
 * The PDF and the DOCX are generated for real inside the test run — a correct
 * xref table and a real ZIP container — because a mocked parser would prove
 * nothing about whether `unpdf` and `mammoth` can actually read the file. Nothing
 * binary is checked into the repository: the bytes are produced here and written
 * under the run sink by the test that needs them.
 */
import { crc32 } from 'node:zlib';

/* -------------------------------------------------------------------- PDF -- */

function escapePdfLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function latin1Length(value: string): number {
  return Buffer.byteLength(value, 'latin1');
}

/**
 * A single-page PDF with one text object and a real xref table.
 *
 * `encrypted` adds a Standard security-handler dictionary and an `/Encrypt`
 * entry in the trailer, which is what a password-protected file looks like to a
 * reader that will not open it.
 */
export function buildPdf(text: string, options: { encrypted?: boolean } = {}): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${escapePdfLiteral(text)}) Tj ET`;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${latin1Length(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  if (options.encrypted === true) {
    objects.push('<< /Filter /Standard /V 1 /R 2 /O <00000000000000000000000000000000> /U <00000000000000000000000000000000> /P -4 >>');
  }

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(latin1Length(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = latin1Length(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  const encryptEntry = options.encrypted === true ? ` /Encrypt ${objects.length} 0 R` : '';
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptEntry} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/* ------------------------------------------------------------------- ZIP --- */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Minimal ZIP writer: stored (uncompressed) entries and a correct central
 * directory. Enough for the OOXML container mammoth expects, with no dependency.
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const now = new Date();
  // DOS time/date. Fixed to keep fixtures deterministic (1980-01-01 00:00).
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A real DOCX container: content types, package rels and one paragraph. */
export function buildDocx(text: string): Buffer {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const packageRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p></w:body>
</w:document>`;

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(packageRels, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

/* ----------------------------------------------------------------- images -- */

/** PNG signature + IHDR chunk. Enough for a header probe. */
export function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(8 + 8 + 13);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8; // bit depth
  buffer[25] = 6; // colour type: RGBA
  return buffer;
}

/** SOI + JFIF APP0 + SOF0 + EOI, with the given frame size. */
export function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, // 'JFIF\0'
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2); // segment length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9); // components
  sof.writeUInt8(1, 10);
  sof.writeUInt8(0x11, 11);
  sof.writeUInt8(0, 12);
  sof.writeUInt8(2, 13);
  sof.writeUInt8(0x11, 14);
  sof.writeUInt8(1, 15);
  sof.writeUInt8(3, 16);
  sof.writeUInt8(0x11, 17);
  sof.writeUInt8(1, 18);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function riffWebp(chunk: string, payload: Buffer): Buffer {
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write(chunk, 0, 'ascii');
  chunkHeader.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunkHeader, payload]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** VP8X (extended format): 24-bit little-endian canvas size minus one. */
export function webpVp8xBytes(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = 0x04; // alpha flag only; size bits are not part of the probe
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return riffWebp('VP8X', payload);
}

/** VP8L (lossless): 0x2F signature, then 14-bit width-1 and height-1. */
export function webpVp8lBytes(width: number, height: number): Buffer {
  // 10 payload bytes so the whole RIFF container is 30 bytes, the minimum the
  // header probe requires before it reads a WebP chunk.
  const payload = Buffer.alloc(10);
  payload[0] = 0x2f;
  const packed = (height - 1) * 16384 + (width - 1);
  payload.writeUInt32LE(packed >>> 0, 1);
  return riffWebp('VP8L', payload);
}

/** VP8 (lossy): frame tag, 9D 01 2A start code, then two 14-bit sizes. */
export function webpVp8Bytes(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return riffWebp('VP8 ', payload);
}

/** GIF89a header with the logical screen size. */
export function gifBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

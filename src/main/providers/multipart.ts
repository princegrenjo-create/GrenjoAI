/**
 * Multipart/form-data body builder for audio transcription.
 *
 * Written by hand rather than pulling in `form-data`: the body is one file part
 * plus two short text parts, and the boundary has to be something the caller can
 * also put in the `Content-Type` header. Bytes are concatenated once, so the
 * audio is never copied more than necessary.
 */
export interface MultipartFilePart {
  field: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface MultipartTextPart {
  field: string;
  value: string;
}

export interface MultipartBody {
  contentType: string;
  bytes: Uint8Array;
  boundary: string;
}

const encoder = new TextEncoder();

function randomBoundary(): string {
  // Not cryptographic: the boundary only has to be unlikely to appear in the
  // audio bytes, and a random suffix per request is enough for that.
  const suffix = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `----grenjo${suffix}`;
}

export function buildMultipartBody(
  file: MultipartFilePart,
  textParts: MultipartTextPart[],
  boundary: string = randomBoundary(),
): MultipartBody {
  const chunks: Uint8Array[] = [];
  const push = (text: string): void => {
    chunks.push(encoder.encode(text));
  };

  for (const part of textParts) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${part.field}"\r\n\r\n`);
    push(`${part.value}\r\n`);
  }

  push(`--${boundary}\r\n`);
  push(
    `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename.replace(/["\r\n]/g, '_')}"\r\n`,
  );
  push(`Content-Type: ${file.contentType}\r\n\r\n`);
  chunks.push(file.data);
  push(`\r\n--${boundary}--\r\n`);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, bytes, boundary };
}

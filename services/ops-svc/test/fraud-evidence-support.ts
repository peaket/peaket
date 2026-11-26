// F-04-14 시험 공용 도우미(동결 로컬, LCH-290·LCH-300).
// 제품 함수를 부르지 않는 순수 시험 도구만 둔다: PNG 만들기·읽기, multipart 본문, 작은 PDF.
// sharp는 제품 의존이라 시험은 직접 가져오지 않는다. 보기용 사본은 제품 함수가 만든 PNG를 이 도구로 읽는다.
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const NOW = Date.parse('2026-11-26T00:00:00.000Z');
export const SHOW = Date.parse('2026-12-03T10:00:00.000Z');
export const SALE_ENDS = SHOW - 24 * HOUR;
export const CANCEL = SHOW - 26 * HOUR;
export const ENTRY = SHOW;
export const SOURCE_EXPIRES = SHOW + 30 * DAY;

export const id = (n: number) => `0194b240-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const iso = (ms: number) => new Date(ms).toISOString();
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const newId = () => randomUUID();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

export interface MakePngOptions {
  readonly width: number;
  readonly height: number;
  /** 0~255 */
  readonly rgb?: readonly [number, number, number];
  /** 메타데이터가 지워지는지 보려고 넣는 tEXt 청크 */
  readonly text?: string;
}

/** 인터레이스 없음·8비트 RGBA PNG. 테스트가 직접 만든 작은 그림이다. */
export function makePng(o: MakePngOptions): Buffer {
  const [r, g, b] = o.rgb ?? [200, 30, 30];
  const raw = Buffer.alloc((o.width * 4 + 1) * o.height);
  for (let y = 0; y < o.height; y += 1) {
    const row = y * (o.width * 4 + 1);
    raw[row] = 0; // filter none
    for (let x = 0; x < o.width; x += 1) {
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0);
  ihdr.writeUInt32BE(o.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (o.text) parts.push(chunk('tEXt', Buffer.from(`Comment\0${o.text}`, 'latin1')));
  parts.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

export interface PngImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 행마다 알파까지 4바이트 */
  readonly rgba: Buffer;
  readonly chunks: readonly string[];
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 테스트가 만든 PNG(필터 0~4)를 읽는다. 제품 보기용 사본 검증에만 쓴다. */
export function readPng(bytes: Uint8Array): PngImage {
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('PNG 서명이 아니다');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  const idat: Buffer[] = [];
  const chunks: string[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push(type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      color = data[9]!;
    }
    if (type === 'IDAT') idat.push(Buffer.from(data));
    off += 12 + len;
  }
  if (depth !== 8 || (color !== 6 && color !== 2)) throw new Error(`시험 PNG 형식이 아니다(depth ${depth}, color ${color})`);
  const bpp = color === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? line[i - bpp]! : 0;
      const up = prev[i]!;
      const upLeft = i >= bpp ? prev[i - bpp]! : 0;
      if (filter === 1) line[i] = (line[i]! + left) & 0xff;
      else if (filter === 2) line[i] = (line[i]! + up) & 0xff;
      else if (filter === 3) line[i] = (line[i]! + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) line[i] = (line[i]! + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`모르는 PNG 필터 ${filter}`);
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * bpp;
      const dst = (y * width + x) * 4;
      out[dst] = line[src]!;
      out[dst + 1] = line[src + 1]!;
      out[dst + 2] = line[src + 2]!;
      out[dst + 3] = bpp === 4 ? line[src + 3]! : 255;
    }
    prev = line;
  }
  return { width, height, rgba: out, chunks };
}

export function pixelAt(img: PngImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!, img.rgba[i + 3]!];
}

/** 확장자·매직 바이트 검사만 보는 작은 PDF */
export function makePdf(): Buffer {
  return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
}

export interface MultipartFile {
  readonly field: string;
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

export interface MultipartOptions {
  readonly fields?: Readonly<Record<string, string>>;
  readonly files?: readonly MultipartFile[];
}

/** multipart/form-data 본문 하나. fastify inject에 그대로 넣는다 */
export function multipart(o: MultipartOptions): { body: Buffer; contentType: string } {
  const boundary = `----peaket-f0414-${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(o.fields ?? {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  for (const f of o.files ?? []) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`,
        'utf8',
      ),
      Buffer.from(f.bytes),
      Buffer.from('\r\n', 'utf8'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** `=`·`+`·`-`·`@`·탭으로 시작하는 CSV 칸이 수식이 되지 않게 작은따옴표가 붙었는지 본다 */
export function csvCell(value: string): string {
  if (/^[=+\-@\t]/.test(value)) return `'${value}`;
  return value;
}

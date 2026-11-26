// F-10-2 image-worker 통합 시험(계획 docs/review/plans/F-10-2.md §3·§5·§7, D-T35 ①·④,
// docs/security/asvs/catalog-review.md 5.1.1·5.2.1·5.2.2·5.2.6·5.3.1·5.3.2·5.4.3·14.2.8·15.2.5·16.5.3,
// docs/api/proto/peaket/image/v1/image.proto, ADR-0130·0148·0257).
// 운영 실행 명령(node dist/image-worker/main.js) 그대로 자식 프로세스를 띄우고, AWS 흉내 서버 moto 5.2.5의 실제 S3와
// tools/local/mock-malware-scanner.mjs를 함께 쓴다. core-svc의 이미지 저장소는 쓰지 않는다(image-worker 경계만 본다).
// 시험 먼저: 구현 전에는 dist/image-worker/main.js가 없어 이 파일이 실패한다(ADR-0372).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { imageV1Image } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildDist, freePort, logLines, SERVICE_DIR } from './media-support.js';

const REPO = join(SERVICE_DIR, '..', '..');
const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const BUCKET = 'peaket-it-image-worker';
const REGION = 'ap-northeast-2';
const TAG_KEY = 'GuardDutyMalwareScanStatus';
const SCANNER = join(REPO, 'tools', 'local', 'mock-malware-scanner.mjs');
const AUTH = 'AWS4-HMAC-SHA256 Credential=test/20260101/ap-northeast-1/s3/aws4_request, SignedHeaders=host, Signature=abc';
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const SECRET = 'PEAKET-GPS-SECRET';
const WIDTHS = [320, 640, 960, 1280];
const namesFor = (width: number) => WIDTHS.filter((w) => w <= width).flatMap((w) => [`${w}.avif`, `${w}.webp`]);
const FIXTURES = new URL('../test/fixtures/f10-2/', import.meta.url);
const fixture64 = (name: string) => Buffer.from(readFileSync(new URL(name, FIXTURES)).toString('utf8').trim(), 'base64');

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
/** PNG 한 장(선택: eXIf 청크). 회색조 RGB 8비트. */
function png(width: number, height: number, exif?: Buffer): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      raw[at] = (x * 7 + y * 13) & 255;
      raw[at + 1] = (x * 3 + y * 5) & 255;
      raw[at + 2] = (x + y) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...(exif ? [chunk('eXIf', exif)] : []), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** 폭·높이만 있는 PNG 머리(화소 데이터 없음). 화소 상한을 디코딩 전에 보는지 시험한다. */
function pngHeaderOnly(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}
/** 깨진 PNG: 서명·IHDR은 맞고 IDAT가 쓰레기다. */
function corruptPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1200, 0);
  ihdr.writeUInt32BE(1600, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([9, 9, 9])), chunk('IEND', Buffer.alloc(0))]);
}
/** PNG eXIf 청크에 넣는 최소 TIFF(ImageDescription = 비밀 문자열) */
function exifWithSecret(): Buffer {
  const text = Buffer.from(`${SECRET}\0`, 'ascii');
  const tiff = Buffer.alloc(26 + text.length);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x010e, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(text.length, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  text.copy(tiff, 26);
  return tiff;
}

type ImageClient = grpc.Client & {
  ProcessImage: (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
};
let container = '';
let endpoint = '';
let worker: ChildProcess | undefined;
let workerOutput = '';
let client: ImageClient | undefined;
/** 구현 전에는 dist/image-worker/main.js가 없다. beforeAll을 실패로 끝내 모두 건너뛰지 않고, 시험마다 까닭을 남긴다. */
let startFailure: string | undefined;
const ready = () => {
  if (startFailure) throw new Error(startFailure);
  if (!client) throw new Error('image-worker gRPC 클라이언트가 없다');
};

const url = (key: string) => `${endpoint}/${BUCKET}/${key}`;
async function until(pred: () => boolean | Promise<boolean>, what: string | (() => string), ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`기다리다 시간이 지났다: ${typeof what === 'function' ? what() : what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function put(key: string, bytes: Buffer | string, tag?: string): Promise<void> {
  const r = await fetch(url(key), { method: 'PUT', body: bytes, headers: { authorization: AUTH, ...(tag ? { 'x-amz-tagging': `${TAG_KEY}=${tag}` } : {}) } });
  expect(r.status, `S3 PUT ${key}`).toBeLessThan(300);
}
async function list(prefix: string): Promise<string[]> {
  const r = await fetch(`${endpoint}/${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}`, { headers: { authorization: AUTH } });
  expect(r.status).toBe(200);
  const xml = await r.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!).sort();
}
async function get(key: string): Promise<Buffer> {
  const r = await fetch(url(key), { headers: { authorization: AUTH } });
  expect(r.status, `S3 GET ${key}`).toBe(200);
  return Buffer.from(await r.arrayBuffer());
}
async function head(key: string): Promise<Headers> {
  const r = await fetch(url(key), { method: 'HEAD', headers: { authorization: AUTH } });
  expect(r.status, `S3 HEAD ${key}`).toBe(200);
  return r.headers;
}
function scan(): void {
  execFileSync(process.execPath, [SCANNER, '--endpoint', endpoint, '--bucket', BUCKET, '--once'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function processImage(sourceKey: string, kind = 'IMAGE_KIND_PRODUCTION'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    client!.ProcessImage({ source_key: sourceKey, kind }, new grpc.Metadata(), { deadline: Date.now() + 20_000 }, (e, v) => (e ? reject(new Error(`${grpc.status[e.code]}: ${e.details}`)) : resolve(v ?? {})));
  });
}
function spawnImageWorker(port: number, extra: Record<string, string> = {}): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const base: Record<string, string> = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k]) base[k] = process.env[k]!;
  const child = spawn(process.execPath, ['dist/image-worker/main.js'], {
    cwd: SERVICE_DIR,
    env: {
      ...base,
      PEAKET_ENV: 'local',
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_GRPC_PORT: String(port),
      PEAKET_IMAGE_S3_ENDPOINT: endpoint,
      PEAKET_IMAGE_S3_REGION: REGION,
      PEAKET_IMAGE_BUCKET: BUCKET,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout!.on('data', (d) => (text += String(d)));
  child.stderr!.on('data', (d) => (text += String(d)));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output: () => text, exited };
}

beforeAll(async () => {
  try {
    buildDist();
    container = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
    const mapped = docker(['port', container, '5000/tcp']).split('\n')[0]!.trim();
    endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
    await until(async () => {
      try {
        return (await fetch(endpoint)).status < 500;
      } catch {
        return false;
      }
    }, 'moto 시작');
    expect((await fetch(`${endpoint}/${BUCKET}`, { method: 'PUT' })).status).toBeLessThan(300);
    const port = await freePort();
    const w = spawnImageWorker(port);
    worker = w.child;
    workerOutput = '';
    w.child.stdout!.on('data', (d) => (workerOutput += String(d)));
    w.child.stderr!.on('data', (d) => (workerOutput += String(d)));
    await until(() => w.output().includes('image_worker_started') || w.child.exitCode !== null, () => `image-worker 시작 실패:\n${w.output().slice(-4000)}`, 30_000);
    if (w.child.exitCode !== null) throw new Error(`image-worker가 뜨지 않았다(끝 코드 ${w.child.exitCode}):\n${w.output().slice(-4000)}`);
    const def = protoLoader.fromJSON(imageV1Image as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { image: { v1: { ImageService: grpc.ServiceClientConstructor } } } }).peaket.image.v1;
    client = new pkg.ImageService(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as unknown as ImageClient;
  } catch (e) {
    startFailure = e instanceof Error ? e.message : String(e);
  }
}, 180_000);

afterAll(async () => {
  client?.close();
  if (worker && worker.exitCode === null) {
    worker.kill();
    await new Promise((r) => worker!.once('exit', r));
  }
  if (container) {
    try {
      docker(['rm', '-f', '-v', container]);
    } catch {
      // 이미 지워졌다
    }
  }
});

describe('F-10-2 image-worker', () => {
  test('D-T35 ④ image-worker가 CLEAN 태그 뒤에만 파생본을 만들고 원본 폭 이하의 AVIF·WebP를 쓴다 [ASVS v5.0.0-5.2.2] [ASVS v5.0.0-5.1.1]', async () => {
    ready();
    const id = randomUUID();
    const key = `quarantine/production/${id}`;
    await put(key, png(1200, 1600));
    scan();
    const out = await processImage(key);
    expect(out.status).toBe('IMAGE_STATUS_ACCEPTED');
    expect([out.width, out.height]).toEqual([1200, 1600]);
    const expected = namesFor(1200).map((n) => `staging/production/${id}/${n}`);
    expect([...(out.derivative_keys as string[])].sort()).toEqual(expected);
    expect(await list(`staging/production/${id}/`)).toEqual(expected);
    for (const n of namesFor(1200)) {
      const h = await head(`staging/production/${id}/${n}`);
      expect(h.get('content-type')).toBe(n.endsWith('.avif') ? 'image/avif' : 'image/webp');
      expect(h.get('cache-control')).toBe('private, no-store');
    }
    expect(await list('public/')).toEqual([]);
    // 로컬 버킷 정책도 공개 접두사만 연다(격리 원본을 열지 않는다, IR-10)
    const policy = await (await fetch(`${endpoint}/${BUCKET}?policy`, { headers: { authorization: AUTH } })).text();
    for (const kind of ['production', 'banner', 'review']) expect(policy, `공개 접두사 ${kind}`).toContain(`arn:aws:s3:::${BUCKET}/${kind}/*`);
    expect(policy).not.toContain('quarantine');
    expect(policy).not.toContain('staging');
    expect(policy).not.toMatch(new RegExp(`arn:aws:s3:::${BUCKET}/\\*`));
    // 같은 원본 키로 다시 맡기면 같은 결과이고 객체를 더 쓰지 않는다
    const again = await processImage(key);
    expect(again).toMatchObject({ status: 'IMAGE_STATUS_ACCEPTED', width: 1200, height: 1600 });
    expect([...(again.derivative_keys as string[])].sort()).toEqual(expected);
    expect(await list(`staging/production/${id}/`)).toEqual(expected);
  });

  test('D-T35 ④ JPEG·WebP 원본을 디코딩하고 홈 배너는 공연 이미지와 같은 폭·형식 규격을 쓴다 [ASVS v5.0.0-5.1.1] [ASVS v5.0.0-5.2.2]', async () => {
    ready();
    for (const [name, bytes] of [
      ['JPEG', fixture64('poster-800x1000.jpg.b64')],
      ['WebP', fixture64('poster-800x1000.webp.b64')],
    ] as const) {
      const id = randomUUID();
      const key = `quarantine/production/${id}`;
      await put(key, bytes, 'NO_THREATS_FOUND');
      const out = await processImage(key);
      expect(out.status, name).toBe('IMAGE_STATUS_ACCEPTED');
      expect([out.width, out.height], name).toEqual([800, 1000]);
      expect([...(out.derivative_keys as string[])].sort(), name).toEqual(namesFor(800).map((n) => `staging/production/${id}/${n}`));
    }
    const id = randomUUID();
    await put(`quarantine/banner/${id}`, png(1240, 400), 'NO_THREATS_FOUND');
    const banner = await processImage(`quarantine/banner/${id}`, 'IMAGE_KIND_HOME_BANNER');
    expect(banner.status).toBe('IMAGE_STATUS_ACCEPTED');
    expect([...(banner.derivative_keys as string[])].sort()).toEqual(namesFor(1240).map((n) => `staging/banner/${id}/${n}`));
    expect((banner.derivative_keys as string[]).some((k) => k.includes('/1280.'))).toBe(false);
  });

  test('D-T35 ④ EXIF orientation 6은 화소를 돌린 뒤 폭·높이를 보고한다 [ASVS v5.0.0-5.1.1]', async () => {
    ready();
    const id = randomUUID();
    await put(`quarantine/production/${id}`, fixture64('poster-rot6-1200x1600.jpg.b64'), 'NO_THREATS_FOUND');
    const out = await processImage(`quarantine/production/${id}`);
    expect(out.status).toBe('IMAGE_STATUS_ACCEPTED');
    expect([out.width, out.height]).toEqual([1600, 1200]);
    expect([...(out.derivative_keys as string[])].sort()).toEqual(namesFor(1600).map((n) => `staging/production/${id}/${n}`).sort());
  });

  test('D-T35 ④ EICAR를 THREATS_FOUND로 표시하면 MALWARE로 거절하고 파생본을 쓰지 않는다 [ASVS v5.0.0-5.4.3]', async () => {
    ready();
    const id = randomUUID();
    const key = `quarantine/production/${id}`;
    await put(key, EICAR);
    scan();
    const out = await processImage(key);
    expect(out).toMatchObject({ status: 'IMAGE_STATUS_REJECTED', reject_reason: 'IMAGE_REJECT_REASON_MALWARE' });
    expect(await list(`staging/production/${id}/`)).toEqual([]);
  });

  test('D-T35 ④ 4,000만 화소·긴 변 20,000 경계는 넘지 않고 하나 넘으면 디코딩 전 2초 안에 TOO_LARGE로 거절한다 [ASVS v5.0.0-5.2.1] [ASVS v5.0.0-5.2.6]', async () => {
    ready();
    // 경계값: 화소 40,000,000과 긴 변 20,000은 TOO_LARGE가 아니다(화소 데이터가 없어 그다음 디코딩에서 거절된다)
    for (const [w, h] of [[8000, 5000], [20_000, 2000]] as const) {
      const id = randomUUID();
      await put(`quarantine/production/${id}`, pngHeaderOnly(w, h), 'NO_THREATS_FOUND');
      const out = await processImage(`quarantine/production/${id}`);
      expect(out.status).toBe('IMAGE_STATUS_REJECTED');
      expect(out.reject_reason, `${w}×${h}는 화소 상한 안이다`).not.toBe('IMAGE_REJECT_REASON_TOO_LARGE');
    }
    for (const [w, h] of [[8000, 5001], [20_001, 1000]] as const) {
      const id = randomUUID();
      await put(`quarantine/production/${id}`, pngHeaderOnly(w, h), 'NO_THREATS_FOUND');
      const started = Date.now();
      const out = await processImage(`quarantine/production/${id}`);
      expect(out).toMatchObject({ status: 'IMAGE_STATUS_REJECTED', reject_reason: 'IMAGE_REJECT_REASON_TOO_LARGE' });
      expect(Date.now() - started, `${w}×${h}가 2초를 넘었다`).toBeLessThan(2_000);
      expect(await list(`staging/production/${id}/`)).toEqual([]);
    }
  });

  test('D-T35 ④ 검사 태그가 없거나 UNSUPPORTED·ACCESS_DENIED·FAILED면 디코딩 전에 SCAN_PENDING으로 답한다 [ASVS v5.0.0-5.4.3] [ASVS v5.0.0-16.5.3]', async () => {
    ready();
    // 깨진 PNG를 쓴다: 태그 확인 전에 디코딩하면 UNSUPPORTED_TYPE이 나므로 SCAN_PENDING이면 순서가 맞다.
    for (const tag of [undefined, 'UNSUPPORTED', 'ACCESS_DENIED', 'FAILED'] as const) {
      const id = randomUUID();
      const key = `quarantine/production/${id}`;
      await put(key, corruptPng(), tag);
      const out = await processImage(key);
      expect(out.status, `태그 ${tag ?? '없음'}`).toBe('IMAGE_STATUS_SCAN_PENDING');
      expect(await list(`staging/production/${id}/`)).toEqual([]);
      // 원본은 남는다(작업 워커가 60초 뒤 다시 맡긴다)
      expect((await fetch(url(key), { method: 'HEAD', headers: { authorization: AUTH } })).status).toBe(200);
    }
  });

  test('D-T35 ④ 메타데이터(EXIF GPS)를 AVIF·WebP 모든 폭에서 지운다 [ASVS v5.0.0-14.2.8]', async () => {
    ready();
    // PNG eXIf와 JPEG APP1 EXIF를 모두 쓴다. JPEG는 800×1000이라 320·640 파생본이 나온다.
    for (const [name, bytes, width] of [
      ['png-exif', png(1200, 1600, exifWithSecret()), 1200],
      ['jpeg-exif', fixture64('poster-exif-800x1000.jpg.b64'), 800],
    ] as const) {
      const id = randomUUID();
      const key = `quarantine/production/${id}`;
      await put(key, bytes, 'NO_THREATS_FOUND');
      const out = await processImage(key);
      expect(out.status, name).toBe('IMAGE_STATUS_ACCEPTED');
      const names = namesFor(width);
      expect(names.length, `${name} 파생본`).toBeGreaterThan(0);
      for (const n of names) {
        const b = await get(`staging/production/${id}/${n}`);
        expect(b.toString('latin1'), `${name} ${n}`).not.toContain(SECRET);
        expect(b.toString('latin1'), `${name} ${n}`).not.toMatch(/exif|gps/i);
      }
    }
  });

  test('D-T35 ④ 후기 사진은 240px·긴 변 1,280px WebP만 만들고 JPEG는 만들지 않는다 [ASVS v5.0.0-5.1.1]', async () => {
    ready();
    const id = randomUUID();
    const key = `quarantine/review/${id}`;
    await put(key, png(1600, 1200), 'NO_THREATS_FOUND');
    const out = await processImage(key, 'IMAGE_KIND_REVIEW_PHOTO');
    expect(out.status).toBe('IMAGE_STATUS_ACCEPTED');
    expect([...(out.derivative_keys as string[])].sort()).toEqual([`staging/review/${id}/1280.webp`, `staging/review/${id}/240.webp`]);
    expect(await list(`staging/review/${id}/`)).toEqual([`staging/review/${id}/1280.webp`, `staging/review/${id}/240.webp`]);
    expect((await list(`staging/review/${id}/`)).filter((k) => /\.(jpg|jpeg|avif)$/.test(k))).toEqual([]);
  });

  test('D-T35 ④ 후기 사진 원본 긴 변이 1,280보다 작으면 1,280 파생본을 만들지 않는다 [ASVS v5.0.0-5.1.1]', async () => {
    ready();
    const id = randomUUID();
    await put(`quarantine/review/${id}`, png(1279, 800), 'NO_THREATS_FOUND');
    const out = await processImage(`quarantine/review/${id}`, 'IMAGE_KIND_REVIEW_PHOTO');
    expect(out.status).toBe('IMAGE_STATUS_ACCEPTED');
    expect([...(out.derivative_keys as string[])]).toEqual([`staging/review/${id}/240.webp`]);
    expect(await list(`staging/review/${id}/`)).toEqual([`staging/review/${id}/240.webp`]);
  });

  test('D-T35 ④ 형식이 아닌 파일(SVG·깨진 PNG)은 UNSUPPORTED_TYPE으로 거절한다 [ASVS v5.0.0-5.2.2]', async () => {
    ready();
    const svg = randomUUID();
    await put(`quarantine/production/${svg}`, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'NO_THREATS_FOUND');
    expect((await processImage(`quarantine/production/${svg}`)).reject_reason).toBe('IMAGE_REJECT_REASON_UNSUPPORTED_TYPE');
    const broken = randomUUID();
    await put(`quarantine/production/${broken}`, corruptPng(), 'NO_THREATS_FOUND');
    expect((await processImage(`quarantine/production/${broken}`)).reject_reason).toBe('IMAGE_REJECT_REASON_UNSUPPORTED_TYPE');
    expect(await list(`staging/production/${svg}/`)).toEqual([]);
    expect(await list(`staging/production/${broken}/`)).toEqual([]);
  });

  test('D-T35 ④ source_key는 정한 격리 접두사·UUID 꼴만 받고 그 밖은 INVALID_ARGUMENT로 거절한다 [ASVS v5.0.0-5.3.2]', async () => {
    ready();
    for (const key of [
      `quarantine/other/${randomUUID()}`,
      `quarantine/production/not-a-uuid`,
      `quarantine/production/${randomUUID()}/../x`,
      `production/${randomUUID()}`,
      `arn:aws:s3:::peaket-image/quarantine/production/${randomUUID()}`,
      `https://example.test/quarantine/production/${randomUUID()}`,
    ]) {
      await expect(processImage(key), key).rejects.toThrow(/INVALID_ARGUMENT/i);
    }
    // 격리 접두사와 kind가 어긋나면 받지 않는다.
    await expect(processImage(`quarantine/banner/${randomUUID()}`, 'IMAGE_KIND_PRODUCTION')).rejects.toThrow(/INVALID_ARGUMENT/i);
    await expect(processImage(`quarantine/review/${randomUUID()}`, 'IMAGE_KIND_HOME_BANNER')).rejects.toThrow(/INVALID_ARGUMENT/i);
    expect((await list('staging/')).filter((k) => k.includes('not-a-uuid') || k.includes('..'))).toEqual([]);
  });

  test('D-T35 ④ image-worker는 10MB를 넘는 격리 객체를 읽지 않고 TOO_LARGE로 거절한다 [ASVS v5.0.0-5.2.1]', async () => {
    ready();
    const id = randomUUID();
    const key = `quarantine/production/${id}`;
    await put(key, Buffer.alloc(10 * 1024 * 1024 + 1, 0x41), 'NO_THREATS_FOUND');
    const out = await processImage(key);
    expect(out).toMatchObject({ status: 'IMAGE_STATUS_REJECTED', reject_reason: 'IMAGE_REJECT_REASON_TOO_LARGE' });
    expect(await list(`staging/production/${id}/`)).toEqual([]);
  });

  test('D-T35 ① image-worker는 DB·Kafka·Redis 자격 증명이 있으면 뜨지 않고 AWS S3 자격 증명은 받는다 [ASVS v5.0.0-15.2.5]', async () => {
    ready();
    const forbidden: [string, string][] = [
      ['PEAKET_DATABASE_URL', 'postgres://u:p@127.0.0.1:1/db'],
      ['PEAKET_PARTNER_DATABASE_URL', 'postgres://u:p@127.0.0.1:1/db'],
      ['PEAKET_OPS_DATABASE_URL', 'postgres://u:p@127.0.0.1:1/db'],
      ['PEAKET_SEARCH_DATABASE_URL', 'postgres://u:p@127.0.0.1:1/db'],
      ['PEAKET_MAINTENANCE_DATABASE_URL', 'postgres://u:p@127.0.0.1:1/db'],
      ['DATABASE_URL', 'postgres://u:p@127.0.0.1:1/db'],
      ['PEAKET_KAFKA_BROKERS', '127.0.0.1:9092'],
      ['KAFKA_BROKERS', '127.0.0.1:9092'],
      ['KAFKA_BOOTSTRAP_SERVERS', '127.0.0.1:9092'],
      ['PEAKET_REDIS_URL', 'redis://127.0.0.1:6379'],
      ['REDIS_URL', 'redis://127.0.0.1:6379'],
      ['PEAKET_REDIS_SEAT_URL', 'redis://127.0.0.1:6379'],
      // 빈 값도 이름이 있으면 거절한다
      ['PEAKET_DATABASE_URL', ''],
      ['KAFKA_BROKERS', ''],
      ['REDIS_URL', ''],
    ];
    for (const [name, value] of forbidden) {
      const port = await freePort();
      const w = spawnImageWorker(port, { [name]: value });
      const code = await Promise.race([w.exited, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
      if (code === null) w.child.kill();
      expect(code, `${name}(${value === '' ? '빈 값' : '값'})를 넣었는데 떴다`).not.toBe(0);
      expect(w.output(), `${name}를 넣었는데 이름을 알리지 않는다`).toContain(name);
    }
    // 동시 처리 1이 아니면 뜨지 않는다
    for (const value of ['0', '2']) {
      const port = await freePort();
      const w = spawnImageWorker(port, { PEAKET_IMAGE_CONCURRENCY: value });
      const code = await Promise.race([w.exited, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
      if (code === null) w.child.kill();
      expect(code, `동시 처리 ${value}로 떴다`).not.toBe(0);
      expect(w.output()).toContain('PEAKET_IMAGE_CONCURRENCY');
    }
    // AWS 이름을 받은 본 시험의 image-worker는 이미 떠 있다(beforeAll)
    expect(workerOutput).toContain('image_worker_started');
  });
});

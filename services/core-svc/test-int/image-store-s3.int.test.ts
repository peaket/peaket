// F-10-2 S3 이미지 저장소 어댑터(계획 docs/review/plans/F-10-2.md §3·§5·§7, docs/data.md §1, ADR-0257 결정 1).
// AWS 흉내 서버 moto 5.2.5의 실제 S3 REST로 객체 머리·키 꼴·읽기·지우기를 본다. 값은 계획·정본에서 가져온다.
// 시험 먼저: 구현 전에는 모듈이 없어 이 파일이 실패한다(ADR-0372).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const REGION = 'ap-northeast-2';
const BUCKET = 'peaket-it-images';
const ID = randomUUID();
/** 첫 시험이 덮어쓰기 거절로 쓰는 키와 겹치지 않게, 접두사 왕복 시험은 다른 ID를 쓴다. */
const PREFIX_ID = randomUUID();

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

let S3ImageObjectStore: new (o: { bucket: string; region: string; endpoint?: string }) => unknown;
let startFailure: string | undefined;
const ready = () => {
  if (startFailure) throw new Error(startFailure);
};
let container = '';
let endpoint = '';
let store: {
  putQuarantine(key: string, bytes: Uint8Array): Promise<void>;
  deleteQuarantine(key: string): Promise<void>;
  readStaging(key: string): Promise<Uint8Array | undefined>;
  stagingSize(key: string): Promise<number | undefined>;
  deleteStaging(key: string): Promise<void>;
  putPublic(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  deletePublic(key: string): Promise<void>;
};

async function until(pred: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error('기다리다 시간이 지났다');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const url = (key: string) => `${endpoint}/${BUCKET}/${key}`;
const putRaw = (key: string, bytes: Uint8Array, headers: Record<string, string> = {}) => fetch(url(key), { method: 'PUT', body: bytes, headers });
const head = (key: string) => fetch(url(key), { method: 'HEAD' });

beforeAll(async () => {
  try {
    // @ts-ignore 구현 전에는 이 모듈이 없다(시험 먼저, ADR-0372)
    const mod = (await import('../src/modules/catalog/adapters/image-store-s3.js')) as { S3ImageObjectStore: typeof S3ImageObjectStore };
    S3ImageObjectStore = mod.S3ImageObjectStore;
    container = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
    const mapped = docker(['port', container, '5000/tcp']).split('\n')[0]!.trim();
    const port = mapped.slice(mapped.lastIndexOf(':') + 1);
    endpoint = `http://127.0.0.1:${port}`;
    await until(async () => {
      try {
        return (await fetch(endpoint)).status < 500;
      } catch {
        return false;
      }
    });
    expect((await fetch(`${endpoint}/${BUCKET}`, { method: 'PUT' })).status).toBeLessThan(300);
    store = new S3ImageObjectStore({ bucket: BUCKET, region: REGION, endpoint }) as typeof store;
  } catch (e) {
    startFailure = e instanceof Error ? e.message : String(e);
  }
}, 120_000);

afterAll(() => {
  if (container) {
    try {
      docker(['rm', '-f', '-v', container]);
    } catch {
      // 이미 지워졌다
    }
  }
});

describe('F-10-2 S3 이미지 저장소', () => {
  test('D-T35 ④ 공개 파생본은 AVIF·WebP 모두 맞는 Content-Type, immutable 캐시, inline 파일 이름으로 올리고 덮어쓰지 않는다 [ASVS v5.0.0-3.2.1] [ASVS v5.0.0-4.1.1] [ASVS v5.0.0-5.4.1]', async () => {
    ready();
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
    const avif = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    for (const [name, bytes, type] of [
      ['320.webp', webp, 'image/webp'],
      ['320.avif', avif, 'image/avif'],
    ] as const) {
      await store.putPublic(`production/${ID}/${name}`, bytes, type);
      const h = await head(`production/${ID}/${name}`);
      expect(h.status).toBe(200);
      expect(h.headers.get('content-type')).toBe(type);
      expect(h.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(h.headers.get('content-disposition')).toBe(`inline; filename="${ID}.${name.endsWith('webp') ? 'webp' : 'avif'}"`);
    }
    // 확장자와 Content-Type이 맞지 않으면 쓰지 않는다
    await expect(store.putPublic(`production/${ID}/640.avif`, avif, 'image/webp')).rejects.toThrow();
    // 공개 파생본은 immutable이라 같은 키를 덮어쓰지 않는다
    await expect(store.putPublic(`production/${ID}/320.webp`, new Uint8Array([9, 9, 9]), 'image/webp')).rejects.toThrow();
    expect(Buffer.from(await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/${BUCKET}/production/${ID}/320.webp`)).arrayBuffer())).toEqual(Buffer.from(webp));
    // 격리 원본은 비공개·no-store다
    await store.putQuarantine(`quarantine/production/${ID}`, webp);
    const q = await head(`quarantine/production/${ID}`);
    expect(q.status).toBe(200);
    expect(q.headers.get('cache-control')).toBe('private, no-store');
  });

  test('F-10-2 저장소는 서버가 만든 키 꼴 밖을 거절하고 없는 준비 객체는 undefined다 [ASVS v5.0.0-5.3.1] [ASVS v5.0.0-5.3.2]', async () => {
    ready();
    const bytes = new Uint8Array([1, 2, 3]);
    for (const key of [
      `production/not-a-uuid/320.webp`,
      `production/${ID}/2560.webp`,
      `production/${ID}/320.jpg`,
      `production/${ID}/../320.webp`,
      `quarantine/production/../../etc/passwd`,
      `staging/production/${ID}/320.avif/extra`,
    ]) {
      await expect(store.putPublic(key, bytes, 'image/webp'), key).rejects.toThrow();
    }
    // 원본은 공개 위치로 올리지 못한다(접두사가 다르다)
    await expect(store.putPublic(`quarantine/production/${ID}`, bytes, 'image/webp')).rejects.toThrow();
    // 공연·배너·후기 사진 접두사는 격리·준비·공개 위치 모두 받는다(F-10-1이 같은 규칙을 쓴다)
    for (const [kind, name] of [
      ['production', '320.webp'],
      ['banner', '640.avif'],
      ['review', '240.webp'],
    ] as const) {
      await store.putQuarantine(`quarantine/${kind}/${PREFIX_ID}`, bytes);
      expect((await head(`quarantine/${kind}/${PREFIX_ID}`)).status, `quarantine/${kind}`).toBe(200);
      expect((await putRaw(`staging/${kind}/${PREFIX_ID}/${name}`, bytes)).status, `staging/${kind}`).toBe(200);
      expect(await store.stagingSize(`staging/${kind}/${PREFIX_ID}/${name}`), `staging/${kind}`).toBe(3);
      await store.putPublic(`${kind}/${PREFIX_ID}/${name}`, bytes, name.endsWith('avif') ? 'image/avif' : 'image/webp');
      expect((await head(`${kind}/${PREFIX_ID}/${name}`)).status, `${kind} 공개`).toBe(200);
    }
    await expect(store.putQuarantine(`quarantine/other/${ID}`, bytes)).rejects.toThrow();
    expect(await store.stagingSize(`staging/production/${ID}/320.webp`)).toBeUndefined();
    expect(await store.readStaging(`staging/production/${ID}/320.webp`)).toBeUndefined();
  });

  test('F-10-2 준비 위치 객체를 읽고 크기를 보고 지운다 [ASVS v5.0.0-5.3.1]', async () => {
    ready();
    const key = `staging/production/${ID}/320.avif`;
    expect((await putRaw(key, new Uint8Array([9, 8, 7, 6]))).status).toBe(200);
    expect(await store.stagingSize(key)).toBe(4);
    expect(Array.from((await store.readStaging(key))!)).toEqual([9, 8, 7, 6]);
    await store.deleteStaging(key);
    expect(await store.stagingSize(key)).toBeUndefined();
    // 공개 객체도 지운다
    await store.putPublic(`production/${ID}/640.avif`, new Uint8Array([1]), 'image/avif');
    await store.deletePublic(`production/${ID}/640.avif`);
    expect((await head(`production/${ID}/640.avif`)).status).toBe(404);
  });
});

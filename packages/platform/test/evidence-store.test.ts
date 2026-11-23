// 진단 증거 저장소(S3)가 가는 주소(ADR-0303 결정 3, ADR-0070 결정 1, BAT-075 보안 다시 보기 SR-02).
// 주소를 코드로 주지 않은 S3 클라이언트는 AWS_ENDPOINT_URL_S3·AWS_ENDPOINT_URL 환경 값과 공유 설정 파일(AWS_CONFIG_FILE)의 endpoint_url을 따른다.
// 그러면 P1 증거가 전용 버킷 밖으로 갈 수 있으므로, 증거 저장소는 그런 설정 주소를 무시해야 한다(흉내 서버 주소는 코드로 주는 local·ci만).
// 실제로 보내지 않는다: 진짜 S3Client에 서명 뒤 단계에서 요청을 가로채 끝내는 층을 끼워, 고른 주소만 적는다(밖으로 나가는 연결 없음).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EVIDENCE_RETENTION_TAG, s3EvidenceStore } from '../src/index.js';

/** 서명 뒤 가로챈 요청(D-T52 ②가 머리·본문·주소를 본다) */
interface SentRequest {
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  body: unknown;
}
const sent = vi.hoisted(() => ({ urls: [] as string[], requests: [] as SentRequest[] }));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  class S3Client extends real.S3Client {
    constructor(...args: ConstructorParameters<typeof real.S3Client>) {
      super(...args);
      // 서명까지 마친 요청의 주소를 적고 보내지 않고 끝낸다
      this.middlewareStack.add(
        () => async (a: { request: unknown }) => {
          const r = a.request as {
            protocol: string;
            hostname: string;
            port?: number;
            path: string;
            query?: Record<string, unknown>;
            headers?: Record<string, string>;
            body?: { destroy?: () => void };
          };
          sent.requests.push({ path: r.path, query: { ...(r.query ?? {}) }, headers: { ...(r.headers ?? {}) }, body: r.body });
          // 보내지 않으므로 파일 본문 흐름을 닫는다(시험 폴더를 지운 뒤 늦게 열려 ENOENT가 나지 않게)
          r.body?.destroy?.();
          sent.urls.push(`${r.protocol}//${r.hostname}${r.port ? `:${r.port}` : ''}${r.path}`);
          return { output: { $metadata: { httpStatusCode: 200 } }, response: { statusCode: 200, headers: {} } } as never;
        },
        { step: 'finalizeRequest', priority: 'low', name: 'testCaptureEndpoint' },
      );
    }
  }
  return { ...real, S3Client };
});

const SET = ['AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL', 'AWS_CONFIG_FILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE'] as const;
let saved: Record<string, string | undefined> = {};
let dir = '';
beforeEach(() => {
  saved = Object.fromEntries(SET.map((k) => [k, process.env[k]]));
  // 가짜 자격 증명(서명만 하고 보내지 않는다)
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  delete process.env.AWS_PROFILE;
  dir = mkdtempSync(join(tmpdir(), 'peaket-evidence-'));
  sent.urls.length = 0;
  sent.requests.length = 0;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  dirs.push(dir);
});
// 가로챈 요청의 파일 흐름은 SDK 안에서 늦게 열릴 수 있어, 폴더는 모든 시험이 끝난 뒤 지운다
const dirs: string[] = [];
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 100));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function file() {
  const f = join(dir, 'report.json');
  writeFileSync(f, '{"header":{}}');
  return f;
}

describe('SR-02 증거 S3 주소는 설정 주소를 따르지 않는다', () => {
  test('D-T18 ①_AWS_ENDPOINT_URL_S3·AWS_ENDPOINT_URL을줘도_주소를코드로주지않은증거저장소는_그주소로보내지않는다(SR-02)', async () => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://127.0.0.1:9/evil-s3';
    process.env.AWS_ENDPOINT_URL = 'http://127.0.0.1:9/evil-any';
    await s3EvidenceStore({ bucket: 'peaket-diag', region: 'ap-northeast-2' }).put('example-svc/p-1/2026-11-19T01:02:03Z/report.json', file());
    expect(sent.urls).toHaveLength(1);
    expect(sent.urls[0]).not.toContain('127.0.0.1');
    expect(new URL(sent.urls[0]!).hostname).toMatch(/\.amazonaws\.com$/);
    expect(new URL(sent.urls[0]!).protocol).toBe('https:');
  });

  test('D-T18 ①_공유설정파일AWS_CONFIG_FILE의endpoint_url도_따르지않는다(SR-02)', async () => {
    const cfg = join(dir, 'config');
    writeFileSync(cfg, '[default]\nendpoint_url = http://127.0.0.1:9/evil-config\nservices = evil\n\n[services evil]\ns3 =\n  endpoint_url = http://127.0.0.1:9/evil-config-s3\n');
    process.env.AWS_CONFIG_FILE = cfg;
    await s3EvidenceStore({ bucket: 'peaket-diag', region: 'ap-northeast-2' }).put('example-svc/p-1/2026-11-19T01:02:03Z/report.json', file());
    expect(sent.urls).toHaveLength(1);
    expect(sent.urls[0]).not.toContain('127.0.0.1');
  });

  test('D-T18 ①_코드로준흉내서버주소(local·ci)는_그대로쓴다(대조)', async () => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://127.0.0.1:9/evil-s3';
    await s3EvidenceStore({ bucket: 'peaket-diag', region: 'ap-northeast-2', endpoint: 'http://aws.peaket-local.svc.cluster.local:5000' }).put('k/report.json', file());
    expect(sent.urls).toHaveLength(1);
    expect(sent.urls[0]).toMatch(/^http:\/\/aws\.peaket-local\.svc\.cluster\.local:5000\/peaket-diag\//);
  });
});

// 보존 태그의 정본은 docs/observability.md §9 '진단 증거' 행이다(시험 값은 그 행의 글귀에서 읽는다. 코드 상수를 가져오지 않는다)
function retentionTagsFromDoc(): { key: string; standard: string; hold: string } {
  const doc = readFileSync(new URL('../../../docs/observability.md', import.meta.url), 'utf8');
  const row = doc.split(/\r?\n/).find((l) => l.startsWith('| 진단 증거(진단 보고서'));
  if (!row) throw new Error('observability.md §9에 진단 증거 행이 없다');
  // 행 안의 `키=값` 글귀: 앞의 것이 올릴 때 다는 태그(standard), 뒤의 것이 연장(hold)이다
  const tags = [...row.matchAll(/`([a-z][a-z0-9-]*)=([a-z]+)`/g)].map((m) => ({ key: m[1]!, value: m[2]! }));
  if (tags.length !== 2 || tags[0]!.key !== tags[1]!.key) throw new Error(`§9 행의 보존 태그 글귀가 둘이 아니다: ${JSON.stringify(tags)}`);
  return { key: tags[0]!.key, standard: tags[0]!.value, hold: tags[1]!.value };
}

describe('D-T52 ② 증거 저장소의 보존 태그', () => {
  test('D-T52 ② [ASVS v5.0.0-14.2.4] 증거 저장소는 파일·바이트 올리기 모두 보존 태그를 싣는다', async () => {
    const doc = retentionTagsFromDoc();
    // 정본 글귀 자체를 한 번 확인한다(행을 읽는 시험 도우미가 엉뚱한 글귀를 집으면 아래 단언이 함께 틀린다)
    expect(doc).toEqual({ key: 'peaket-retention', standard: 'standard', hold: 'hold' });
    expect({ ...EVIDENCE_RETENTION_TAG }).toEqual(doc);

    const endpoint = 'http://aws.peaket-local.svc.cluster.local:5000';
    const store = s3EvidenceStore({ bucket: 'peaket-diag', region: 'ap-northeast-2', endpoint });
    const fileKey = 'example-svc/p-1/2026-11-23T02:00:00.000Z/report.json';
    const bytesKey = 'evidence-collector/orders-db/2026-11-23T02:00:00.000Z/pg-activity.json';
    // 바이트 값은 글자 경계가 아닌 값까지 섞는다(본문이 문자열로 바뀌어 깨지면 잡힌다)
    const bytes = Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0x00, 0xff, 0x80, 0x0a]);

    await store.put(fileKey, file());
    await store.putBytes(bytesKey, bytes, 'application/json');

    expect(sent.requests).toHaveLength(2);
    const [fileReq, bytesReq] = sent.requests as [SentRequest, SentRequest];
    const tagging = `${doc.key}=${doc.standard}`;
    expect(fileReq.headers['x-amz-tagging']).toBe(tagging);
    expect(bytesReq.headers['x-amz-tagging']).toBe(tagging);

    // 경로 꼴 주소(흉내 서버 주소를 준 경우)는 /<버킷>/<객체 이름>뿐이다(SDK가 ':'를 %3A로 적으므로 풀어서 견준다)
    expect(decodeURIComponent(fileReq.path)).toBe(`/peaket-diag/${fileKey}`);
    expect(decodeURIComponent(bytesReq.path)).toBe(`/peaket-diag/${bytesKey}`);
    // 쿼리에는 SDK가 다는 명령 이름(x-id) 밖의 값이 없다. 보존 태그·객체 내용이 쿼리로 새지 않는다
    for (const r of [fileReq, bytesReq]) {
      expect(Object.keys(r.query).filter((k) => k !== 'x-id')).toEqual([]);
      expect(Object.values(r.query).filter((v) => v !== 'PutObject')).toEqual([]);
    }

    // 바이트 요청의 본문은 넘긴 바이트 그대로다
    expect(bytesReq.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytesReq.body as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
    expect(bytesReq.headers['content-type']).toBe('application/json');
  });
});

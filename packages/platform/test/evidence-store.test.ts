// 진단 증거 저장소(S3)가 가는 주소(ADR-0303 결정 3, ADR-0070 결정 1, BAT-075 보안 다시 보기 SR-02).
// 주소를 코드로 주지 않은 S3 클라이언트는 AWS_ENDPOINT_URL_S3·AWS_ENDPOINT_URL 환경 값과 공유 설정 파일(AWS_CONFIG_FILE)의 endpoint_url을 따른다.
// 그러면 P1 증거가 전용 버킷 밖으로 갈 수 있으므로, 증거 저장소는 그런 설정 주소를 무시해야 한다(흉내 서버 주소는 코드로 주는 local·ci만).
// 실제로 보내지 않는다: 진짜 S3Client에 서명 뒤 단계에서 요청을 가로채 끝내는 층을 끼워, 고른 주소만 적는다(밖으로 나가는 연결 없음).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { s3EvidenceStore } from '../src/index.js';

const sent = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  class S3Client extends real.S3Client {
    constructor(...args: ConstructorParameters<typeof real.S3Client>) {
      super(...args);
      // 서명까지 마친 요청의 주소를 적고 보내지 않고 끝낸다
      this.middlewareStack.add(
        () => async (a: { request: unknown }) => {
          const r = a.request as { protocol: string; hostname: string; port?: number; path: string; body?: { destroy?: () => void } };
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

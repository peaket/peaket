// api-client 생성물 시험(docs/frontend.md §2.2 '생성물'·§4.1, BUILD_ORDER BAS-041). 실행: pnpm --filter @peaket/api-client test
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';
import { OPERATIONS } from '../src/gen/operations';
import { PROBLEM_TYPES } from '../src/gen/problem-types';
import { T0_TEXT_PLAIN_OPERATIONS } from '../src/client';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const spec = parse(readFileSync(join(ROOT, 'docs/api/openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, { operationId: string; parameters?: { $ref?: string }[] }>>;
  'x-peaket-problem-types': { types: Record<string, { status: number; title: string }> };
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const ops = Object.values(OPERATIONS);

describe('작업 서술 표(src/gen/operations.ts)', () => {
  test('계약의 모든 작업이 작업 이름·메서드·경로로 한 번씩 있다', () => {
    const fromSpec = Object.entries(spec.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((m) => `${item[m]!.operationId} ${m.toUpperCase()} ${path}`));
    expect(ops.map((o) => `${o.operationId} ${o.method} ${o.path}`).sort()).toEqual(fromSpec.sort());
    expect(fromSpec.length).toBeGreaterThan(270);
  });

  test('호스트는 x-peaket-gateways 규칙과 경로 servers로 정한다(§4.1 호스트)', () => {
    expect(OPERATIONS.createEventHold.host).toBe('api');
    expect(OPERATIONS.createQueueEntry.host).toBe('queue');
    expect(OPERATIONS.getQueueSegmentState.host).toBe('queue-files');
    expect(OPERATIONS.listOpsAdminAccounts.host).toBe('ops-api');
    expect(OPERATIONS.createPartnerAuthSession.host).toBe('partner-api');
    expect(OPERATIONS.createScannerScan.host).toBe('scanner-api');
    // 계정 연결 제안은 identity 태그지만 소비자 웹 앱 서버(www)가 받는다(태그로 호스트를 고르지 않는다)
    expect(OPERATIONS.getIdentityLinkProposal.host).toBe('www');
  });

  test('작업 종류(시간 초과)는 롱 폴링·대기 상태 파일·올리기·읽기·쓰기로 나뉜다(§4.1 시간 초과)', () => {
    expect(OPERATIONS.getOrderPaymentStatus.kind).toBe('longpoll');
    expect(OPERATIONS.getQueueSegmentState.kind).toBe('queue-file');
    expect(OPERATIONS.getQueueSegmentState).toMatchObject({ cache: 'no-store' });
    expect(OPERATIONS.createReviewImage.kind).toBe('upload');
    expect(OPERATIONS.getHome.kind).toBe('read');
    expect(OPERATIONS.createOrder.kind).toBe('write');
  });

  test('T=0 text/plain 두 호출은 계약(requestBody text/plain)에서 읽고, 손으로 적은 목록과 같다(FE-T3)', () => {
    expect(ops.filter((o) => 't0' in o && o.t0).map((o) => `${o.method} ${o.path}`).sort()).toEqual([...T0_TEXT_PLAIN_OPERATIONS].sort());
  });

  test('멱등 키·If-Match·쿠키는 계약의 매개변수와 security에서 읽는다', () => {
    const withParam = (name: string) =>
      Object.entries(spec.paths).flatMap(([, item]) => METHODS.filter((m) => item[m]?.parameters?.some((p) => p.$ref?.endsWith(`/${name}`))).map((m) => item[m]!.operationId)).sort();
    expect(ops.filter((o) => 'idempotent' in o && o.idempotent).map((o) => o.operationId).sort()).toEqual(withParam('IdempotencyKey'));
    expect(ops.filter((o) => 'ifMatch' in o && o.ifMatch).map((o) => o.operationId).sort()).toEqual(withParam('IfMatch'));
    expect(OPERATIONS.getHome.cookie).toBe(false); // security: []
    expect(OPERATIONS.listTickets.cookie).toBe(true); // 전역 fanCookie
    expect(OPERATIONS.createScannerScan.cookie).toBe(false); // DPoP 머리
    expect(OPERATIONS.getIdentityLinkProposal.cookie).toBe(true); // linkCookie
  });
});

test('생성기는 확장 칸 값이 틀리거나 같은 주소에 맞는 작업 틀이 둘이면 실패한다(새 맥락 리뷰, BAS-041)', async () => {
  const { operationsOf } = await import('../scripts/generate.mjs');
  const base = { 'x-peaket-gateways': { rules: [{ prefix: '/v1/', server: 'https://api.peaket.example' }] }, security: [] };
  expect(() => operationsOf({ ...base, paths: { '/v1/a': { get: { operationId: 'getA', 'x-peaket-timeout': 'longpol', responses: {} } } } })).toThrow(/x-peaket-timeout/);
  expect(() => operationsOf({ ...base, paths: { '/v1/a': { get: { operationId: 'getA', 'x-peaket-fetch-cache': 'nostore', responses: {} } } } })).toThrow(/x-peaket-fetch-cache/);
  expect(() => operationsOf({ ...base, paths: { '/v1/a/{x}': { get: { operationId: 'getAX', responses: {} } }, '/v1/a/{y}': { get: { operationId: 'getAY', responses: {} } } } })).toThrow(/겹/);
});

test('오류 목록 표(src/gen/problem-types.ts)는 계약의 x-peaket-problem-types와 같다', () => {
  expect(PROBLEM_TYPES).toEqual(spec['x-peaket-problem-types'].types);
});

function files(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, base, out);
    else out.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out.sort();
}

test('커밋한 생성물이 지금 계약에서 다시 만든 것과 같다(CI 생성 코드 차이)', { timeout: 300_000 }, async () => {
  const { generateAll } = await import('../scripts/generate.mjs');
  const work = mkdtempSync(join(tmpdir(), 'api-client-gen-test-'));
  try {
    mkdirSync(join(work, 'src'), { recursive: true });
    cpSync(fileURLToPath(new URL('../src/orval-fetch.ts', import.meta.url)), join(work, 'src', 'orval-fetch.ts'));
    await generateAll(work);
    const fresh = join(work, 'src', 'gen');
    const committed = fileURLToPath(new URL('../src/gen', import.meta.url));
    expect(files(fresh)).toEqual(files(committed));
    const differ = files(fresh).filter((f) => readFileSync(join(fresh, f), 'utf8') !== readFileSync(join(committed, f), 'utf8'));
    expect(differ).toEqual([]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

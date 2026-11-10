// 받는 층: 판매 자격 명단 목록·올리기·지우기(openapi listPartnerSaleEligibilityLists·createPartnerSaleEligibilityList·deletePartnerSaleEligibilityList,
// ADR-0261 결정 6~9, BUILD_ORDER HOT-250). 메모리 저장소와 회원 코드 변환 대역으로 본문 상한·파일 검사·줄 해석·결과 모양·판정 차례를 본다.
// 실제 DB·잠금 경계·파기 정비·실제 gRPC는 test-int/sale-eligibility.int.test.ts가 본다. 단언 값은 정본의 글로 적는다(8MiB·50만 줄·행 번호 1,000개·공연당 10개 [가정]).
import 'reflect-metadata';
import { CreatePartnerSaleEligibilityListResponse, ListPartnerSaleEligibilityListsResponse } from '@peaket/contracts/openapi/partner';
import { type Clock, createService } from '@peaket/platform';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { type MemberCodeDirectory, MemberCodeLookupFailed, MemoryCatalogRepository, MemorySaleEligibilityCopy } from '../src/modules/catalog/index.js';
import { multipart } from '../test-int/media-support.js';
import { FakeIdentity, logSinkUnit, NOW_MS } from './support.js';

/** 회원 코드 변환 대역: 정한 코드만 계정으로 바꾼다. 부른 횟수와 코드 수를 센다 */
class FakeDirectory implements MemberCodeDirectory {
  readonly accounts = new Map<string, string>();
  calls: number[] = [];
  signals: (AbortSignal | undefined)[] = [];
  failing = false;
  onResolve: (() => void) | undefined;
  async resolve(codes: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<Map<string, string>> {
    this.calls.push(codes.length);
    this.signals.push(opts.signal);
    this.onResolve?.();
    if (this.failing) throw new MemberCodeLookupFailed('UNAVAILABLE');
    return new Map(codes.flatMap((c) => (this.accounts.has(c) ? [[c, this.accounts.get(c)!] as [string, string]] : [])));
  }
}

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const directory = new FakeDirectory();
const copy = new MemorySaleEligibilityCopy();
const logs = logSinkUnit();
let now = NOW_MS;
let monoShift = 0;
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() + monoShift };
const TENANT = randomUUID();
const OTHER = randomUUID();
const P = 'https://peaket.example/problems/';
const MiB = 1024 * 1024;
const KNOWN = ['PK7-42Q9', 'AB1-CD2E', 'ZZ9-0001'];

beforeAll(async () => {
  repo.sellerNames.set(TENANT, '(주)피켓공연');
  repo.sellerNames.set(OTHER, '(주)다른공연');
  KNOWN.forEach((c) => directory.accounts.set(c, randomUUID()));
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, catalog: repo, media: { memberCodes: directory, eligibilityCopy: copy } }), env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' }, clock, logDestination: logs.stream, adminAuthz: identity });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  directory.calls = [];
  directory.signals = [];
  directory.onResolve = undefined;
  directory.failing = false;
  copy.failing = false;
  now = NOW_MS;
});

function seed(tenant = TENANT): { productionId: string; eventId: string } {
  const productionId = randomUUID();
  repo.productions.set(productionId, { id: productionId, promoterId: tenant, placeId: randomUUID(), title: '겨울 콘서트', genre: '콘서트', saleReview: 'DRAFT', saleApprovedAt: null });
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId, venueId: null, openAt: new Date('2026-11-20T11:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), status: 'SCHEDULED' });
  return { productionId, eventId };
}

const admin = () => identity.partner(TENANT, 'partner_admin');
const url = (id: string) => `/v1/partner/productions/${id}/sale-eligibility-lists`;
async function upload(id: string, file: Uint8Array | string, o: { key?: string; name?: string; headers?: Record<string, string>; xrw?: boolean } = {}) {
  const bytes = typeof file === 'string' ? new TextEncoder().encode(file) : file;
  const { payload, contentType } = await multipart({ key: o.key ?? 'lumen-fanclub-2026', name: o.name ?? 'LUMEN 팬클럽 2026' }, [{ name: 'list.csv', type: 'text/csv', bytes }]);
  return svc.http.inject({ method: 'POST', url: url(id), headers: { ...(o.headers ?? admin()), 'content-type': contentType, ...(o.xrw === false ? {} : { 'x-requested-with': 'peaket-partner' }) }, payload });
}
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; detail?: string };

describe('판매 자격 명단 올리기(메모리)', () => {
  test('명단 본문 8MiB 넘음은 읽기 전 413, gzip·zip 머리·잘못된 UTF-8은 422, BOM 하나는 버린다 [ASVS v5.0.0-5.1.1] [ASVS v5.0.0-5.2.1] [ASVS v5.0.0-5.2.2]', async () => {
    const { productionId } = seed();
    // 본문 전체가 상한(8MiB + 봉투 64KB)을 넘으면 읽기 전에 413(변환을 부르지 않는다)
    const huge = await upload(productionId, new Uint8Array(8 * MiB + 64 * 1024 + 1).fill(0x41));
    expect([huge.statusCode, problem(huge).type, huge.headers['cache-control']]).toEqual([413, `${P}sale-eligibility-upload-too-large`, 'no-store']);
    // 파일 8MiB + 1바이트는 413, 8MiB는 크기로 막지 않는다(줄 수가 넘어 422)
    expect(problem(await upload(productionId, new Uint8Array(8 * MiB + 1).fill(0x41))).type).toBe(`${P}sale-eligibility-upload-too-large`);
    const exact = await upload(productionId, 'A\n'.repeat(4 * MiB));
    expect([exact.statusCode, problem(exact).detail]).toEqual([422, '50만 줄을 넘었다']);
    // 압축 파일 머리(gzip 1F 8B, zip 50 4B 03 04·05 06·07 08)는 422
    for (const head of [[0x1f, 0x8b, 0x08], [0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]]) {
      const r = await upload(productionId, new Uint8Array([...head, 0x41, 0x42]));
      expect([r.statusCode, problem(r).type, problem(r).detail]).toEqual([422, `${P}sale-eligibility-upload-rejected`, '압축 파일은 받지 않는다']);
    }
    // 잘못된 UTF-8은 422
    const bad = await upload(productionId, new Uint8Array([0x50, 0x4b, 0x37, 0x2d, 0xff, 0xfe]));
    expect([bad.statusCode, problem(bad).detail]).toEqual([422, 'UTF-8 글자가 아니다']);
    expect(directory.calls).toEqual([]);
    // 맨 앞 BOM 하나는 버리고 첫 줄을 읽는다. 둘째 BOM은 글자로 남아 형식 오류다
    const bom = await upload(productionId, '﻿PK7-42Q9\n﻿AB1-CD2E\n');
    expect(JSON.parse(bom.payload)).toMatchObject({ applied: 1, invalidLineCount: 1, invalidLines: [2] });
  });

  test('Q-T36 ⑥ 결과는 반영 수·형식 오류 줄·없는 코드 줄의 행 번호와 SHA-256뿐이고 계정 ID를 싣지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const { productionId, eventId } = seed();
    // 줄 규칙: CR·앞뒤 공백·겹따옴표 한 쌍을 버리고 대문자로, 빈 줄은 건너뛰되 행 번호는 센다, 같은 코드는 한 번
    const text = 'PK7-42Q9\r\n  "ab1-cd2e" \n\nnot-a-code\nNNP-E999\npk7-42q9\nPKO-42Q9\nNNP-E999\n';
    const r = await upload(productionId, text);
    expect([r.statusCode, r.headers['cache-control']]).toEqual([200, 'no-store']);
    const out = CreatePartnerSaleEligibilityListResponse.parse(JSON.parse(r.payload));
    expect(out).toEqual({
      listKey: 'lumen-fanclub-2026',
      version: 1,
      applied: 2,
      invalidLineCount: 2,
      invalidLines: [4, 7],
      unknownLineCount: 2,
      unknownLines: [5, 8],
      fileSha256: createHash('sha256').update(text).digest('hex'),
    });
    expect(Object.keys(JSON.parse(r.payload)).sort()).toEqual(['applied', 'fileSha256', 'invalidLineCount', 'invalidLines', 'listKey', 'unknownLineCount', 'unknownLines', 'version']);
    // 변환은 고유 코드만 보낸다(PK7-42Q9·AB1-CD2E·NNP-E999)
    expect(directory.calls).toEqual([3]);
    // 사본에는 계정 ID·판·수명(파기 시각 = 마지막 판매 종료 + 1일)을 넘긴다
    const stored0 = [...repo.saleLists.values()].find((l) => l.productionId === productionId)!;
    // 사본 판은 명단 판이 아니라 전역 순번(copy_seq)이다(리뷰 H1)
    expect(copy.puts.at(-1)).toEqual({ productionId, eventIds: [], listKey: 'lumen-fanclub-2026', version: stored0.copySeq, accountIds: [directory.accounts.get('PK7-42Q9'), directory.accounts.get('AB1-CD2E')], expiresAt: new Date('2026-12-24T10:00:00Z') });
    void eventId;
    // 목록은 정보만(구성원 없음)
    const got = await svc.http.inject({ method: 'GET', url: url(productionId), headers: identity.partner(TENANT, 'partner_member') });
    expect(got.headers['cache-control']).toBe('no-store');
    const list = ListPartnerSaleEligibilityListsResponse.parse(JSON.parse(got.payload));
    expect(list.items).toEqual([{ key: 'lumen-fanclub-2026', name: 'LUMEN 팬클럽 2026', memberCount: 2, lockedAt: null, destroyDueAt: '2026-12-24T10:00:00.000Z', uploadedAt: new Date(NOW_MS).toISOString(), version: 1 }]);
    // 같은 키로 다시 올리면 구성원을 바꿔 넣고 판이 오른다(옛 구성원이 남지 않는다)
    const again = JSON.parse((await upload(productionId, 'ZZ9-0001\n')).payload);
    expect([again.version, again.applied]).toEqual([2, 1]);
    const stored = [...repo.saleLists.values()].find((l) => l.productionId === productionId)!;
    expect([...stored.members]).toEqual([directory.accounts.get('ZZ9-0001')]);
  });

  test('행 번호는 형식 오류·없는 코드 각각 1,000개까지 싣고 수는 전부 센다', async () => {
    const { productionId } = seed();
    const lines = (n: number, line: string) => Array.from({ length: n }, () => line).join('\n');
    const thousand = JSON.parse((await upload(productionId, `${lines(1000, 'x')}\n${lines(1000, 'QQQ-0000')}`)).payload);
    expect([thousand.invalidLineCount, thousand.invalidLines.length, thousand.invalidLines.at(-1), thousand.unknownLineCount, thousand.unknownLines.length, thousand.unknownLines[0]]).toEqual([1000, 1000, 1000, 1000, 1000, 1001]);
    const more = JSON.parse((await upload(productionId, `${lines(1001, 'x')}\n${lines(1001, 'QQQ-0000')}`)).payload);
    expect([more.invalidLineCount, more.invalidLines.length, more.invalidLines.at(-1), more.unknownLineCount, more.unknownLines.length, more.unknownLines.at(-1)]).toEqual([1001, 1000, 1000, 1001, 1000, 2001]);
  });

  test('명단 50만 줄은 받고 50만 1줄은 422다 [ASVS v5.0.0-2.1.1] [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-2.3.2]', async () => {
    const { productionId } = seed();
    const over = await upload(productionId, 'x\n'.repeat(500_001));
    expect([over.statusCode, problem(over).detail]).toEqual([422, '50만 줄을 넘었다']);
    const at = await upload(productionId, 'x\n'.repeat(500_000));
    expect([at.statusCode, JSON.parse(at.payload).invalidLineCount]).toEqual([200, 500_000]);
  }, 60_000);

  test('실무자의 명단 올리기·지우기는 403이고 실패한 인가로 남으며 다른 파트너 공연은 404다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-16.3.2]', async () => {
    const { productionId } = seed();
    const member = identity.partner(TENANT, 'partner_member');
    const r = await upload(productionId, 'PK7-42Q9\n', { headers: member });
    expect([r.statusCode, problem(r).type]).toEqual([403, `${P}partner-admin-required`]);
    const del = await svc.http.inject({ method: 'DELETE', url: `${url(productionId)}/lumen-fanclub-2026`, headers: { ...member, 'x-requested-with': 'x' } });
    expect(problem(del).type).toBe(`${P}partner-admin-required`);
    expect(logs.lines().filter((l) => l.event === 'partner_production_denied' && l.route === 'sale_eligibility' && l.reason === 'partner_admin_required')).toHaveLength(2);
    const other = seed(OTHER);
    expect(problem(await upload(other.productionId, 'PK7-42Q9\n')).type).toBe(`${P}not-found`);
    expect(directory.calls).toEqual([]);
    expect([...repo.saleLists.values()].some((l) => l.productionId === productionId || l.productionId === other.productionId)).toBe(false);
  });

  test('X-Requested-With가 없거나 key·name 모양이 틀리면 400이다(이름 40자까지) [ASVS v5.0.0-2.1.1] [ASVS v5.0.0-2.2.1]', async () => {
    const { productionId } = seed();
    expect((await upload(productionId, 'PK7-42Q9\n', { xrw: false })).statusCode).toBe(400);
    expect((await upload(productionId, 'PK7-42Q9\n', { key: 'AB' })).statusCode).toBe(400);
    expect((await upload(productionId, 'PK7-42Q9\n', { key: 'a'.repeat(33) })).statusCode).toBe(400);
    expect((await upload(productionId, 'PK7-42Q9\n', { name: '가'.repeat(41) })).statusCode).toBe(400);
    expect((await upload(productionId, 'PK7-42Q9\n', { name: '' })).statusCode).toBe(400);
    expect((await upload(productionId, 'PK7-42Q9\n', { name: '가'.repeat(40) })).statusCode).toBe(200);
    expect((await svc.http.inject({ method: 'DELETE', url: `${url(productionId)}/AB`, headers: { ...admin(), 'x-requested-with': 'x' } })).statusCode).toBe(400);
  });

  test('identity 변환이 실패하면 503 member-code-lookup-unavailable(Retry-After)이고 아무것도 저장하지 않으며 기록에 회원 코드가 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const { productionId } = seed();
    directory.failing = true;
    const r = await upload(productionId, 'PK7-42Q9\n');
    expect([r.statusCode, problem(r).type, r.headers['retry-after']]).toEqual([503, `${P}member-code-lookup-unavailable`, '10']);
    expect([...repo.saleLists.values()].some((l) => l.productionId === productionId)).toBe(false);
    expect(logs.text()).not.toContain('PK7-42Q9');
  });

  test('사본 넘기기가 실패해도 올리기는 200이고 copied_version이 그대로다', async () => {
    const { productionId } = seed();
    expect((await upload(productionId, 'PK7-42Q9\n')).statusCode).toBe(200);
    const l = () => [...repo.saleLists.values()].find((x) => x.productionId === productionId)!;
    expect([l().version, l().copiedSeq]).toEqual([1, l().copySeq]);
    copy.failing = true;
    expect((await upload(productionId, 'AB1-CD2E\n')).statusCode).toBe(200);
    expect(l().version).toBe(2);
    expect(l().copiedSeq).toBeLessThan(l().copySeq);
    expect(logs.lines().some((x) => x.event === 'sale_eligibility_copy_failed')).toBe(true);
  });

  test('공연당 명단 11번째 새 키는 409이고 변환을 부르지 않는다(같은 키 바꿔 넣기는 된다) [ASVS v5.0.0-2.3.2]', async () => {
    const { productionId } = seed();
    for (let i = 0; i < 10; i++) expect((await upload(productionId, 'PK7-42Q9\n', { key: `list-${i}` })).statusCode).toBe(200);
    directory.calls = [];
    const r = await upload(productionId, 'PK7-42Q9\n', { key: 'list-10' });
    expect([r.statusCode, problem(r).type]).toEqual([409, `${P}sale-eligibility-list-limit`]);
    expect(directory.calls).toEqual([]);
    expect((await upload(productionId, 'PK7-42Q9\n', { key: 'list-9' })).statusCode).toBe(200);
  });

  test('Q-T36 ⑤ 잠금 시각부터는 올리기가 변환을 부르지 않고 409이며 명단이 바뀌지 않는다(잠금 앞 확인)', async () => {
    const { productionId } = seed();
    expect((await upload(productionId, 'PK7-42Q9\n')).statusCode).toBe(200);
    // 그 키를 쓰는 규칙의 판매 시작 2026-11-20T20:00+09:00 → 잠금은 24시간 전 2026-11-19T11:00Z
    repo.salePolicies.set(productionId, { rules: [{ version: 1, name: '선예매', rounds: 'ALL', during: { from: '2026-11-20T20:00:00+09:00' }, rule: { if: { fact: 'buyer.lists', has: 'lumen-fanclub-2026' }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } } }], version: 2 });
    now = Date.parse('2026-11-19T11:00:00Z');
    directory.calls = [];
    const r = await upload(productionId, 'AB1-CD2E\n');
    expect([r.statusCode, problem(r).type]).toEqual([409, `${P}sale-eligibility-list-locked`]);
    expect(directory.calls).toEqual([]);
    expect(logs.lines().some((l) => l.event === 'sale_eligibility_locked_attempt' && l.kind === 'security')).toBe(true);
    const del = await svc.http.inject({ method: 'DELETE', url: `${url(productionId)}/lumen-fanclub-2026`, headers: { ...admin(), 'x-requested-with': 'x' } });
    expect([problem(del).type, del.headers['cache-control']]).toEqual([`${P}sale-eligibility-list-locked`, 'no-store']);
    const stored = [...repo.saleLists.values()].find((l) => l.productionId === productionId)!;
    expect([stored.version, [...stored.members]]).toEqual([1, [directory.accounts.get('PK7-42Q9')]]);
  });
});

describe('리뷰 재현(메모리, 2026-11-10)', () => {
  test('S3 명단 표시 이름의 제어 문자·양방향 제어 문자·줄바꿈은 400이다', async () => {
    const { productionId } = seed();
    for (const name of ['벨\u0007', '거꾸로‮글', '줄\n바꿈', '줄 바꿈', '격리⁦글', '표시‏글']) expect((await upload(productionId, 'PK7-42Q9\n', { name })).statusCode).toBe(400);
    expect((await upload(productionId, 'PK7-42Q9\n', { name: 'LUMEN 팬클럽 2026 (1차)' })).statusCode).toBe(200);
  });

  test('S4 줄 수 상한은 디코딩 전에 바이트의 줄바꿈으로 센다(잘못된 UTF-8이 섞여도 50만 줄 넘음이 먼저다) [ASVS v5.0.0-5.2.1]', async () => {
    const { productionId } = seed();
    const bytes = new Uint8Array(500_001 * 2);
    bytes.fill(0x0a);
    bytes[0] = 0xff;
    const r = await upload(productionId, bytes);
    expect([r.statusCode, problem(r).detail]).toEqual([422, '50만 줄을 넘었다']);
    // 마지막 줄에 줄바꿈이 없어도 줄로 센다(50만 줄 + 줄바꿈 없는 한 줄)
    const tail = await upload(productionId, `${'x\n'.repeat(500_000)}x`);
    expect(problem(tail).detail).toBe('50만 줄을 넘었다');
    expect((await upload(productionId, 'x\n'.repeat(500_000))).statusCode).toBe(200);
  }, 60_000);

  test('C6 올리기 경로는 이 기능의 시한 95초 [가정]를 쓰고, 트랜잭션 앞에 남은 시간이 모자라면 504이며 아무것도 저장하지 않는다', async () => {
    const { PartnerSaleEligibilityController } = await import('../src/modules/catalog/inbound/partner-sale-eligibility.controller.js');
    // Nest Fastify의 경로 설정 칸(@nestjs/platform-fastify FASTIFY_ROUTE_CONFIG_METADATA)
    const config = Reflect.getMetadata('__fastify_route_config__', PartnerSaleEligibilityController.prototype.upload) as Record<string, unknown>;
    expect(config.peaketDeadline).toBe(95_000);
    const { productionId } = seed();
    // 변환하는 사이에 76초가 지나 남은 시간이 19초(트랜잭션 앞 하한 20초 [가정] 미만)가 된다
    directory.onResolve = () => {
      monoShift += 76_000;
    };
    try {
      const r = await upload(productionId, 'PK7-42Q9\n');
      expect([r.statusCode, problem(r).type]).toEqual([504, `${P}deadline-exceeded`]);
    } finally {
      monoShift = 0;
    }
    expect([...repo.saleLists.values()].some((l) => l.productionId === productionId)).toBe(false);
    // 변환에는 취소 신호를 넘긴다
    expect(directory.signals.at(-1)).toBeInstanceOf(AbortSignal);
  });

  test('S5 공연마다 한 시간에 20번 [가정]을 넘는 올리기는 429 sale-eligibility-upload-limited와 Retry-After이고 변환을 부르지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const { productionId } = seed();
    for (let i = 0; i < 20; i++) {
      expect((await upload(productionId, 'PK7-42Q9\n')).statusCode).toBe(200);
      now += 60_000;
    }
    directory.calls = [];
    const r = await upload(productionId, 'PK7-42Q9\n');
    // 첫 올리기가 한 시간 창에서 빠지는 때까지(첫 올리기 + 1시간 − 지금 = 40분)
    expect([r.statusCode, problem(r).type, r.headers['retry-after'], r.headers['cache-control']]).toEqual([429, `${P}sale-eligibility-upload-limited`, String(40 * 60), 'no-store']);
    expect(directory.calls).toEqual([]);
    // 다른 공연은 따로 센다. 첫 올리기에서 한 시간이 지나면 다시 된다
    expect((await upload(seed().productionId, 'PK7-42Q9\n')).statusCode).toBe(200);
    now = NOW_MS + 60 * 60_000;
    expect((await upload(productionId, 'PK7-42Q9\n')).statusCode).toBe(200);
  });
});

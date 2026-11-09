// 공연 설명 글(구조 문서)과 공연예술통합전산망 항목(openapi PartnerProductionCreate.description·kopisFields, CMP-070, ADR-0204, ADR-0244, BUILD_ORDER HOT-183)
import 'reflect-metadata';
import { GetEventResponse } from '@peaket/contracts/openapi/catalog';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { FakeIdentity, NOW_MS, productionBody, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const TENANT = randomUUID();
const PLACE = randomUUID();

const DOC = {
  v: 1,
  blocks: [
    { t: 'h', level: 2, c: [{ t: 'text', v: '공연 소개' }] },
    { t: 'p', c: [{ t: 'text', v: '첫 줄', b: true }, { t: 'br' }, { t: 'text', v: '둘째 줄' }] },
    { t: 'ul', items: [[{ t: 'text', v: '하나' }], [{ t: 'text', v: '둘' }]] },
  ],
};

beforeAll(async () => {
  repo.sellerNames.set(TENANT, '(주)피켓공연');
  repo.places.add(PLACE);
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, catalog: repo }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW_MS }), logDestination: quiet(), adminAuthz: identity });
});
afterAll(async () => {
  await svc?.close();
});

const create = (extra: Record<string, unknown>) =>
  svc.http.inject({
    method: 'POST',
    url: '/v1/partner/productions',
    headers: { ...identity.partner(TENANT), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    payload: JSON.stringify(productionBody(PLACE, extra)),
  });
const text = (v: string) => ({ t: 'text', v });

describe('공연 설명 글', () => {
  test('[ASVS v5.0.0-1.3.1] 구조 문서를 그대로 두고 글자판을 만들어 저장한다', async () => {
    const r = await create({ description: DOC });
    expect(r.statusCode).toBe(201);
    const stored = repo.registrations.get(JSON.parse(r.payload).productionId)!;
    expect(stored.descriptionDoc).toEqual(DOC);
    expect(stored.description).toBe('공연 소개\n\n첫 줄\n둘째 줄\n\n하나\n둘');
  });

  test('내용이 없는 문서는 설명이 없는 것으로 저장한다', async () => {
    const r = await create({ description: { v: 1, blocks: [{ t: 'p', c: [] }] } });
    const stored = repo.registrations.get(JSON.parse(r.payload).productionId)!;
    expect(stored.descriptionDoc).toBeUndefined();
    expect(stored.description).toBeUndefined();
  });

  test.each([
    ['HTML 노드', { v: 1, blocks: [{ t: 'html', c: '<script>' }] }],
    ['링크 노드', { v: 1, blocks: [{ t: 'p', c: [{ t: 'a', href: 'https://x', v: 'x' }] }] }],
    ['모르는 속성', { v: 1, blocks: [{ t: 'p', c: [], style: 'color:red' }] }],
    ['글자 노드의 모르는 속성', { v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'a', href: 'x' }] }] }],
    ['굵기가 true가 아님', { v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'a', b: false }] }] }],
    ['제목 단계', { v: 1, blocks: [{ t: 'h', level: 1, c: [] }] }],
    ['판', { v: 2, blocks: [] }],
    ['문서의 모르는 속성', { v: 1, blocks: [], x: 1 }],
    ['블록 상한', { v: 1, blocks: Array.from({ length: 201 }, () => ({ t: 'p', c: [] })) }],
    ['글자 상한', { v: 1, blocks: [{ t: 'p', c: [text('가'.repeat(20_001))] }] }],
    ['글자 합계 상한', { v: 1, blocks: [{ t: 'p', c: [text('가'.repeat(10_001)), { t: 'br' }, text('나'.repeat(10_000))] }] }],
    ['노드 합계 상한', { v: 1, blocks: Array.from({ length: 2 }, () => ({ t: 'p', c: Array.from({ length: 2_501 }, () => ({ t: 'br' })) })) }],
    ['리뷰 재현: 글자판(블록 사이 빈 줄 포함)이 상한을 넘음', { v: 1, blocks: Array.from({ length: 200 }, () => ({ t: 'p', c: [text('가'.repeat(100))] })) }],
    ['리뷰 재현: 목록 줄도 노드로 센다', { v: 1, blocks: [{ t: 'ul', items: Array.from({ length: 2_501 }, () => [{ t: 'br' }]) }] }],
    ['NUL 문자', { v: 1, blocks: [{ t: 'p', c: [text('a\u0000b')] }] }],
    ['깨진 서로게이트', { v: 1, blocks: [{ t: 'p', c: [text('a\ud800b')] }] }],
  ])('[ASVS v5.0.0-1.3.1] %s는 400이다', async (_name, description) => {
    expect((await create({ description })).statusCode).toBe(400);
  });

  test('상한에 꼭 맞는 문서는 받는다', async () => {
    // 글자 19,600 + 블록 사이 빈 줄 398 = 19,998
    const r = await create({ description: { v: 1, blocks: Array.from({ length: 200 }, () => ({ t: 'p', c: [text('가'.repeat(98))] })) } });
    expect(r.statusCode).toBe(201);
    const lines = await create({ description: { v: 1, blocks: [{ t: 'ul', items: Array.from({ length: 2_500 }, () => [{ t: 'br' }]) }] } });
    expect(lines.statusCode).toBe(201);
  });

  test('[ASVS v5.0.0-1.3.1] 리뷰 재현: __proto__ 칸은 받지 않는다', async () => {
    const r = await svc.http.inject({
      method: 'POST',
      url: '/v1/partner/productions',
      headers: { ...identity.partner(TENANT), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: JSON.stringify(productionBody(PLACE)).replace('"title"', '"description":{"v":1,"blocks":[],"__proto__":{"x":1}},"title"'),
    });
    expect(r.statusCode).toBe(400);
  });

  test.each([
    ['제목', { title: 'a\u0000' }],
    ['관람 연령', { ageRating: 'a\u0000' }],
    ['다른 이름', { aliases: ['a\ud800'] }],
    ['새 아티스트', { artists: [{ name: 'a\ud800' }] }],
  ])('리뷰 재현: %s에 저장할 수 없는 글자가 있으면 400이다', async (_n, extra) => {
    expect((await create(extra)).statusCode).toBe(400);
  });

  test('리뷰 재현: 새 공연장 요청에 저장할 수 없는 글자가 있으면 400이다', async () => {
    const r = await svc.http.inject({
      method: 'POST',
      url: '/v1/partner/productions',
      headers: { ...identity.partner(TENANT), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: JSON.stringify({ ...productionBody(PLACE), placeId: undefined, newPlace: { name: 'a\ud800', address: '서울' } }),
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('공연예술통합전산망 항목', () => {
  test('기획사·제작사와 안내 사항을 저장한다(임시저장이라 없어도 된다)', async () => {
    const r = await create({ kopisFields: { producer: '(주)피켓공연', notice: '공연 시작 후 입장 제한' } });
    expect(r.statusCode).toBe(201);
    expect(repo.registrations.get(JSON.parse(r.payload).productionId)!.kopisFields).toEqual({ producer: '(주)피켓공연', notice: '공연 시작 후 입장 제한' });
    const none = await create({});
    expect(repo.registrations.get(JSON.parse(none.payload).productionId)!.kopisFields).toBeUndefined();
  });

  test.each([
    ['모르는 칸', { producer: 'a', cast: 'b' }],
    ['빈 값', { producer: '' }],
    ['기획사·제작사 길이', { producer: '가'.repeat(201) }],
    ['안내 사항 길이', { notice: '가'.repeat(1_001) }],
    ['NUL 문자', { producer: 'a\u0000' }],
  ])('%s는 400이다', async (_name, kopisFields) => {
    expect((await create({ kopisFields })).statusCode).toBe(400);
  });
});

describe('공연 상세 응답', () => {
  test('구조 문서를 description으로 함께 준다', async () => {
    const eventId = randomUUID();
    const productionId = randomUUID();
    repo.events.set(eventId, { id: eventId, productionId, promoterId: TENANT, openAt: new Date('2026-12-01T03:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), status: 'SCHEDULED' } as never);
    repo.productions.set(productionId, { id: productionId, promoterId: TENANT, title: '겨울 콘서트', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') } as never);
    repo.details.set(eventId, { production: { description: '공연 소개', descriptionDoc: DOC as never } });
    const r = await svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}` });
    expect(r.statusCode).toBe(200);
    const body = GetEventResponse.parse(JSON.parse(r.payload));
    expect(body).toMatchObject({ descriptionText: '공연 소개', description: DOC });
    // 리뷰 재현: 전산망 항목은 공개 응답에 내지 않는다
    expect(JSON.parse(r.payload)).not.toHaveProperty('kopisFields');
  });
});

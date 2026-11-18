// 아티스트·공연장 찾기(openapi listPartnerArtists·listPartnerPlaces, FR-022, ADR-0093, ADR-0242, BUILD_ORDER HOT-180 ①). 한글 비교 규칙은 packages/search-normalize가 시험한다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DIRECTORY_TTL_MS } from '../src/modules/catalog/application/partner-directory.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { FakeIdentity, fan, NOW_MS, quiet } from './support.js';

const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW_MS });
let svc: Awaited<ReturnType<typeof createService>>;
const LUMEN = randomUUID();
const AURORA = randomUUID();

const get = (url: string, h: Record<string, string> = identity.partner(randomUUID(), 'partner_member')) => svc.http.inject({ method: 'GET', url, headers: h });
const q = (s: string) => encodeURIComponent(s);

beforeAll(async () => {
  repo.artistNames = [
    { id: LUMEN, name: '루멘', aliases: ['LUMEN'] },
    { id: AURORA, name: '오로라', aliases: [] },
    ...Array.from({ length: 5 }, (_, i) => ({ id: randomUUID(), name: `루멘 트리오 ${i}`, aliases: [] })),
  ];
  repo.placeNames = [{ id: randomUUID(), name: '피켓 아레나', aliases: ['PEAKET ARENA'], address: '서울 어딘가 1' }];
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, catalog: repo }), env: { PEAKET_ENV: 'ci' }, adminAuthz: identity, clock, logDestination: quiet() });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  vi.restoreAllMocks();
});

describe('FR-022 아티스트 찾기', () => {
  test('이름 앞부분과 조합 중 글자로 찾는다', async () => {
    for (const s of ['루', '룸', '루멘']) {
      const r = await get(`/v1/partner/artists?q=${q(s)}`);
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.payload).items[0]).toEqual({ artistId: LUMEN, name: '루멘' });
    }
  });

  test('초성과 다른 이름으로 찾고, 한/영이 뒤바뀐 입력도 찾는다', async () => {
    expect(JSON.parse((await get(`/v1/partner/artists?q=${q('ㅇㄹㄹ')}`)).payload).items).toEqual([{ artistId: AURORA, name: '오로라' }]);
    expect(JSON.parse((await get(`/v1/partner/artists?q=lumen`)).payload).items).toEqual([{ artistId: LUMEN, name: '루멘' }]);
    expect(JSON.parse((await get(`/v1/partner/artists?q=fnaps`)).payload).items[0]).toEqual({ artistId: LUMEN, name: '루멘' });
  });

  test('없으면 빈 목록이다', async () => {
    const r = JSON.parse((await get(`/v1/partner/artists?q=${q('없는이름')}`)).payload);
    expect(r).toEqual({ items: [], nextCursor: null });
  });

  test('커서로 끝까지 겹치지 않게 나눈다', async () => {
    const first = JSON.parse((await get(`/v1/partner/artists?q=${q('루멘')}&limit=4`)).payload);
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = JSON.parse((await get(`/v1/partner/artists?q=${q('루멘')}&limit=4&cursor=${first.nextCursor}`)).payload);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((x: { artistId: string }) => x.artistId)).size).toBe(6);
  });

  test('리뷰 재현: 쪽 사이에 앞쪽 항목이 늘어도 다음 쪽에 겹치거나 빠지지 않는다', async () => {
    const first = JSON.parse((await get(`/v1/partner/artists?q=${q('루멘')}&limit=3`)).payload);
    const last = first.items.at(-1).artistId as string;
    const before = repo.artistNames.slice();
    repo.artistNames.push({ id: randomUUID(), name: '루멘 가', aliases: [] });
    clock.advance(DIRECTORY_TTL_MS + 1);
    const second = JSON.parse((await get(`/v1/partner/artists?q=${q('루멘')}&limit=3&cursor=${first.nextCursor}`)).payload);
    expect(second.items.map((x: { artistId: string }) => x.artistId)).not.toContain(last);
    repo.artistNames = before;
    clock.advance(DIRECTORY_TTL_MS + 1);
  });

  test('q가 없거나 비었거나 50자를 넘거나, 커서가 틀리면 400이다', async () => {
    expect((await get('/v1/partner/artists')).statusCode).toBe(400);
    expect((await get('/v1/partner/artists?q=')).statusCode).toBe(400);
    expect((await get(`/v1/partner/artists?q=${'a'.repeat(51)}`)).statusCode).toBe(400);
    expect((await get(`/v1/partner/artists?q=a&cursor=${q('없는 커서')}`)).statusCode).toBe(400);
    expect((await get(`/v1/partner/artists?q=a&limit=101`)).statusCode).toBe(400);
    // 리뷰 재현: JSON 숫자 문법만 받는다
    for (const bad of ['0x10', '05', '1.5']) expect((await get(`/v1/partner/artists?q=a&limit=${bad}`)).statusCode).toBe(400);
  });

  test('[ASVS v5.0.0-8.2.1] 파트너 소속 계정만 부른다', async () => {
    expect((await svc.http.inject({ method: 'GET', url: '/v1/partner/artists?q=a' })).statusCode).toBe(401);
    expect((await get('/v1/partner/artists?q=a', fan())).statusCode).toBe(401);
  });
});

describe('FR-022 공연장 찾기', () => {
  test('이름·다른 이름으로 찾고 주소를 준다', async () => {
    const want = { placeId: repo.placeNames[0]!.id, name: '피켓 아레나', address: '서울 어딘가 1' };
    expect(JSON.parse((await get(`/v1/partner/places?q=${q('ㅍㅋ')}`)).payload).items).toEqual([want]);
    expect(JSON.parse((await get(`/v1/partner/places?q=${q('아레나')}`)).payload).items).toEqual([want]);
    expect(JSON.parse((await get(`/v1/partner/places?q=arena`)).payload).items).toEqual([want]);
  });
});

// BAT-166 재현 시험(버그: 로마자 입력 500). 정본 docs/features/search.md §3.2(98줄, 파트너 화면의 아티스트·공연장 찾기도 같다)·SR-T4(297줄), ADR-0271 결정 24.
describe('SR-T4 변환 값을 만들 수 없는 로마자 입력(FR-022, BAT-166)', () => {
  test.each(['npt', 'mla', 'hov', 'gunpg', 'nPt'])("SR-T4 공연 등록의 아티스트·공연장 찾기도 변환 값을 만들 수 없는 로마자 입력('%s')에 200·빈 목록이다(FR-022)", async (input) => {
    for (const path of ['/v1/partner/artists', '/v1/partner/places']) {
      const r = await get(`${path}?q=${q(input)}`);
      expect(r.statusCode, path).toBe(200);
      expect(JSON.parse(r.payload), path).toEqual({ items: [], nextCursor: null });
    }
  });

  test("SR-T4 변환 값을 만들 수 없는 로마자 입력의 대조군: 공연장 찾기도 'vlzpt'를 '피켓'으로 바꿔 찾는다", async () => {
    // 변환을 통째로 끄는 고침이면 여기서 걸린다(위 시험이 빈 목록으로 통과하지 않게)
    const r = await get(`/v1/partner/places?q=vlzpt`);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).items.map((x: { name: string }) => x.name)).toEqual(['피켓 아레나']);
  });
});

describe('이름 목록 캐시(ADR-0242)', () => {
  test('30초 동안은 저장소를 다시 부르지 않고, 지나면 새 목록을 읽으며, 읽기가 실패하면 앞 목록을 쓴다', async () => {
    clock.advance(DIRECTORY_TTL_MS + 1);
    const spy = vi.spyOn(repo, 'listArtistNames');
    await get('/v1/partner/artists?q=a');
    await get('/v1/partner/artists?q=b');
    expect(spy).toHaveBeenCalledTimes(1);
    clock.advance(DIRECTORY_TTL_MS + 1);
    const added = { id: randomUUID(), name: '새 아티스트', aliases: [] };
    repo.artistNames.push(added);
    expect(JSON.parse((await get(`/v1/partner/artists?q=${q('새 아티스트')}`)).payload).items).toEqual([{ artistId: added.id, name: '새 아티스트' }]);
    clock.advance(DIRECTORY_TTL_MS + 1);
    spy.mockRejectedValueOnce(new Error('db down'));
    const stale = await get(`/v1/partner/artists?q=${q('새 아티스트')}`);
    expect(JSON.parse(stale.payload).items).toEqual([{ artistId: added.id, name: '새 아티스트' }]);
    // 리뷰 재현: 실패 뒤에는 잠시 다시 읽지 않고, 5초가 지나면 새 목록을 읽는다
    const calls = spy.mock.calls.length;
    await get('/v1/partner/artists?q=a');
    expect(spy.mock.calls.length).toBe(calls);
    clock.advance(5_001);
    await get('/v1/partner/artists?q=a');
    expect(spy.mock.calls.length).toBe(calls + 1);
  });
});

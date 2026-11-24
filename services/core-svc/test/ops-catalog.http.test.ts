// 관제 아티스트·공연장 찾기와 만들기(openapi listOpsArtists·createOpsArtist·listOpsPlaces·createOpsPlace, LCH-080 잔여).
// 판매 승인 SCR-048 확인 패널이 기대는 좁은 찾기·만들기 경로다. 이름·다른 이름, 권한, 닫힌 본문, 중복 409를 메모리 저장소로 본다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const LUMEN = randomUUID();
const LUMEN2 = randomUUID();
const OTHER = randomUUID();
const HALL = randomUUID();
const P = 'https://peaket.example/problems/';

beforeAll(async () => {
  repo.artists.add(LUMEN);
  repo.artists.add(LUMEN2);
  repo.artists.add(OTHER);
  repo.artistNames.push({ id: LUMEN, name: 'LUMEN', aliases: ['루멘', '엘유멘'] });
  repo.artistNames.push({ id: LUMEN2, name: 'LUMEN BAND', aliases: [] });
  repo.artistNames.push({ id: OTHER, name: '다른 팀', aliases: [] });
  repo.places.add(HALL);
  repo.placeNames.push({ id: HALL, name: '피켓 아레나', address: '서울 송파구 올림픽로 1', aliases: ['피켓홀'] });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
});

const ops = (role: 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead' = 'operator') => identity.ops(role);
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; status: number; title: string; artistId?: string; placeId?: string };
const artists = (headers: Record<string, string>, q: string) => svc.http.inject({ method: 'GET', url: `/v1/ops/artists?q=${encodeURIComponent(q)}`, headers });
const places = (headers: Record<string, string>, q: string) => svc.http.inject({ method: 'GET', url: `/v1/ops/places?q=${encodeURIComponent(q)}`, headers });
const createArtist = (headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url: '/v1/ops/artists', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const createPlace = (headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url: '/v1/ops/places', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('관제 아티스트·공연장 찾기·만들기(LCH-080 잔여)', () => {
  test('LCH-080 ㉠_ 이름과 다른 이름으로 찾고 viewer·CS가 읽으며 응답은 no-store이고 계좌·연락처가 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const byName = await artists(ops('viewer'), 'LUM');
    expect(byName.statusCode).toBe(200);
    expect(byName.headers['cache-control']).toBe('no-store');
    const names = (JSON.parse(byName.payload).items as { artistId: string; name: string; aliases: string[] }[]).map((x) => x.artistId);
    expect(names).toContain(LUMEN);
    expect(names).toContain(LUMEN2); // 'LUM'은 'LUMEN BAND'도 부분 일치한다
    expect(names).not.toContain(OTHER);
    expect(JSON.stringify(JSON.parse(byName.payload))).not.toMatch(/account|phone|email|business/i);

    const byAlias = await artists(ops('cs_agent'), '루멘');
    expect(byAlias.statusCode).toBe(200);
    expect((JSON.parse(byAlias.payload).items as { artistId: string }[]).map((x) => x.artistId)).toEqual([LUMEN]);

    const placeByAlias = await places(ops('cs_lead'), '피켓홀');
    expect(placeByAlias.statusCode).toBe(200);
    expect(placeByAlias.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(placeByAlias.payload).items[0]).toMatchObject({ placeId: HALL, name: '피켓 아레나', address: '서울 송파구 올림픽로 1' });

    // q 1~50자, limit 1~100, 커서 모양
    expect((await artists(ops(), '')).statusCode).toBe(400);
    expect((await artists(ops(), 'x'.repeat(51))).statusCode).toBe(400);
    expect((await svc.http.inject({ method: 'GET', url: '/v1/ops/artists?q=LUM&limit=0', headers: ops() })).statusCode).toBe(400);
    expect((await svc.http.inject({ method: 'GET', url: '/v1/ops/artists?q=LUM&limit=101', headers: ops() })).statusCode).toBe(400);
    expect((await svc.http.inject({ method: 'GET', url: '/v1/ops/artists?q=LUM&cursor=not-a-cursor', headers: ops() })).statusCode).toBe(400);
  });

  test('LCH-080 ㉡_ operator·commander가 아티스트를 만들고 같은 정규화 이름은 409 artist-exists로 기존 ID를 준다', async () => {
    const denied = await createArtist(ops('viewer'), { name: '새 아티스트', reason: '판매 승인 연결' });
    expect(denied.statusCode).toBe(403);
    expect(repo.artistNames.some((a) => a.name === '새 아티스트')).toBe(false);

    const created = await createArtist(ops('operator'), { name: '새 아티스트', reason: '판매 승인 연결' });
    expect(created.statusCode).toBe(201);
    const { artistId } = JSON.parse(created.payload) as { artistId: string };
    expect(artistId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(repo.artists.has(artistId)).toBe(true);
    expect(repo.artistNames.some((a) => a.id === artistId && a.name === '새 아티스트')).toBe(true);

    // 정규화(공백 제거)가 같은 이름은 새 행을 만들지 않고 기존 ID를 준다
    const duplicate = await createArtist(ops('commander'), { name: '새아티스트', reason: '중복 확인' });
    expect(duplicate.statusCode).toBe(409);
    expect(problem(duplicate).type).toBe(`${P}artist-exists`);
    expect(problem(duplicate).artistId).toBe(artistId);
    expect(repo.artistNames.filter((a) => a.name.replaceAll(/\s/g, '') === '새아티스트')).toHaveLength(1);

    // 닫힌 본문: 이름·사유 필수, 정의 밖 칸 400
    expect((await createArtist(ops(), { name: '', reason: 'x' })).statusCode).toBe(400);
    expect((await createArtist(ops(), { name: '이름만' })).statusCode).toBe(400);
    expect((await createArtist(ops(), { name: '이름', reason: 'x', artistId: randomUUID() })).statusCode).toBe(400);
  });

  test('LCH-080 ㉢_ operator가 공연장을 만들고 같은 이름·주소는 409 place-exists로 기존 ID를 준다', async () => {
    const denied = await createPlace(ops('cs_agent'), { name: '새 공연장', address: '서울 어딘가 2', region: '서울', reason: '새 공연장 요청' });
    expect(denied.statusCode).toBe(403);

    const body = { name: '새 공연장', address: '서울 어딘가 2', region: '서울', reason: '새 공연장 요청' };
    const created = await createPlace(ops('operator'), body);
    expect(created.statusCode).toBe(201);
    const { placeId } = JSON.parse(created.payload) as { placeId: string };
    expect(repo.places.has(placeId)).toBe(true);
    expect(repo.placeNames.some((p) => p.id === placeId && p.name === '새 공연장')).toBe(true);

    const duplicate = await createPlace(ops('operator'), { ...body, name: '새공연장' });
    expect(duplicate.statusCode).toBe(409);
    expect(problem(duplicate).type).toBe(`${P}place-exists`);
    expect(problem(duplicate).placeId).toBe(placeId);

    expect((await createPlace(ops(), { name: '공연장', address: '주소', reason: 'x' })).statusCode).toBe(400);
    expect((await createPlace(ops(), { name: '공연장', address: '주소', region: '서울' })).statusCode).toBe(400);
  });

  test('LCH-080 ㉠_ 목록은 limit과 커서로 한 장씩 넘고, 모르는 역할은 ops 경로에서 401이다', async () => {
    const first = await svc.http.inject({ method: 'GET', url: '/v1/ops/artists?q=LUMEN&limit=1', headers: ops('viewer') });
    expect(first.statusCode).toBe(200);
    const page = JSON.parse(first.payload) as { items: { artistId: string }[]; nextCursor: string | null };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const second = await svc.http.inject({ method: 'GET', url: `/v1/ops/artists?q=LUMEN&limit=1&cursor=${page.nextCursor}`, headers: ops('viewer') });
    expect(second.statusCode).toBe(200);
    expect((JSON.parse(second.payload).items as { artistId: string }[])[0]!.artistId).not.toBe(page.items[0]!.artistId);

    const fan = await svc.http.inject({ method: 'GET', url: '/v1/ops/artists?q=LUMEN', headers: { 'x-user-aud': 'fan', 'x-user-id': randomUUID(), 'x-session-id': randomUUID() } });
    expect([401, 403]).toContain(fan.statusCode);
  });
});

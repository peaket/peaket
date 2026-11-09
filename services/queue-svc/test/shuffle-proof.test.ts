// 셔플 검증 정보 GET /v1/queues/{eventId}/shuffle-proof와 결과 파일 경로(POL-005, FR-038, SCR-019, ADR-0232)
import 'reflect-metadata';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { QueueShuffleProof } from '@peaket/contracts/openapi/model';
import { drandRoundTimeMs, SEED_REVEAL_AFTER_MS } from '@peaket/shuffle';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { MemoryShuffleProofSource } from '../src/modules/state/index.js';
import { newEvent, recordingRisk, tokens } from './support.js';

const NOW = Date.parse('2026-11-03T03:00:00.000Z');
const OPENS = NOW + 3_600_000;
const COMMIT = 'a'.repeat(64);
const ROOT = 'b'.repeat(64);
const BEACON = 'c'.repeat(64);
const SIG = 'd'.repeat(96);
const SEED = 'e'.repeat(64);

let svc: Awaited<ReturnType<typeof createService>>;
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const schedules = new MemoryEventSchedules();
const proofs = new MemoryShuffleProofSource();
const clock = fakeClock({ now: NOW });
const resultDir = mkdtempSync(join(tmpdir(), 'peaket-results-'));

beforeAll(async () => {
  svc = await createService({
    name: 'queue-svc',
    module: AppModule.register({ memory: true, schedules, tokens, risk: recordingRisk(), state: { autoTick: false, proofSource: proofs, resultDir } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

const committed = { 'commit:lobby': COMMIT, 'round:lobby': '8000000', 'at:lobby': String(NOW - 600_000), 'sealed:lobby': 'SEALED-SECRET', chain: 'quicknet', algo: 'v1' };
const get = (e: string) => svc.http.inject({ method: 'GET', url: `/v1/queues/${e}/shuffle-proof` });

/** 표시 칸에 함께 저장되는 서명 묶음의 모양(서명 자체는 리더가 확인한다, ADR-0239 결정 15) */
const signedOf = (reason: string) => ({ bundle: { params: { reason } }, signatures: [{ signer: 'commander-a', sig: 'AA==' }, { signer: 'commander-b', sig: 'AA==' }] });

describe('RB-35 공시(ADR-0239 결정 13, HOT-041)', () => {
  test('Q-T27 비상 셔플은 사유와 고정 한계 문장을 공시한다(서명자는 싣지 않는다)', async () => {
    const id = await event();
    proofs.set(id, { shuffle: { ...committed, 'emergency:lobby': JSON.stringify({ at: NOW - 1_000, stop: 'beacon', reason: '공개 중계가 모두 응답하지 않음', signed: signedOf('공개 중계가 모두 응답하지 않음') }) }, done: {} });
    const res = await get(id);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ lobby: Record<string, unknown> }>();
    expect(QueueShuffleProof.safeParse(body).success).toBe(true);
    expect(body.lobby.emergency).toEqual({ at: new Date(NOW - 1_000).toISOString(), reason: '공개 중계가 모두 응답하지 않음', stopReason: 'beacon', limitation: '이 경우 시드를 아는 내부자가 결과를 미리 알 수 있다' });
    expect(res.body).not.toContain('commander');
  });

  test('Q-T27 다시 공시 이력을 모두 낸다', async () => {
    const id = await event();
    proofs.set(id, { shuffle: { ...committed, 'recommit:lobby': JSON.stringify([{ at: NOW - 2_000, prev: 8_000_000, round: 8_000_100, reason: '오픈 시각 변경', signed: signedOf('오픈 시각 변경') }]) }, done: {} });
    const res = await get(id);
    expect(res.json<{ lobby: { redisclosures: unknown } }>().lobby.redisclosures).toEqual([{ at: new Date(NOW - 2_000).toISOString(), previousRound: 8_000_000, round: 8_000_100, reason: '오픈 시각 변경' }]);
  });

  test.each([
    ['JSON이 아님', 'nope'],
    ['사유가 없음', JSON.stringify({ at: NOW, stop: 'beacon', signed: signedOf('x') })],
    ['서명 묶음이 없음', JSON.stringify({ at: NOW, stop: 'beacon', reason: 'x' })],
    ['사유가 서명과 다름', JSON.stringify({ at: NOW, stop: 'beacon', reason: '다른 말', signed: signedOf('x') })],
    ['이유가 틀림', JSON.stringify({ at: NOW, stop: 'members_changed', reason: 'x', signed: signedOf('x') })],
    ['비콘 지연이 아닌 이유', JSON.stringify({ at: NOW, stop: 'stale_round', reason: 'x', signed: signedOf('x') })],
    ['사유가 200자를 넘음', JSON.stringify({ at: NOW, stop: 'beacon', reason: '가'.repeat(201), signed: signedOf('가'.repeat(201)) })],
  ])('Q-T27 비상 표시 칸이 틀리면(%s) 칸을 내지 않고 읽지 못했다고 공시한다', async (_n, raw) => {
    const id = await event();
    proofs.set(id, { shuffle: { ...committed, 'emergency:lobby': raw }, done: {} });
    const res = await get(id);
    const body = res.json<{ lobby: Record<string, unknown> }>();
    expect(QueueShuffleProof.safeParse(body).success).toBe(true);
    expect(body.lobby.emergency).toBeUndefined();
    expect(body.lobby.invalidDisclosures).toEqual(['emergency']);
  });

  test.each([
    ['JSON이 아님', 'nope'],
    ['칸이 틀림', '[{"at":"x"}]'],
    ['서명 묶음이 없음', JSON.stringify([{ at: NOW, prev: 1, round: 2, reason: 'x' }])],
    ['사유가 200자를 넘음', JSON.stringify([{ at: NOW, prev: 1, round: 2, reason: '가'.repeat(201), signed: signedOf('가'.repeat(201)) }])],
    ['이전 라운드가 0', JSON.stringify([{ at: NOW, prev: 0, round: 2, reason: 'x', signed: signedOf('x') }])],
    ['새 라운드가 소수', JSON.stringify([{ at: NOW, prev: 1, round: 2.5, reason: 'x', signed: signedOf('x') }])],
    ['새 라운드가 음수', JSON.stringify([{ at: NOW, prev: 1, round: -2, reason: 'x', signed: signedOf('x') }])],
  ])('Q-T27 다시 공시 칸이 틀리면(%s) 칸을 내지 않고 읽지 못했다고 공시한다', async (_n, raw) => {
    const id = await event();
    proofs.set(id, { shuffle: { ...committed, 'recommit:lobby': raw }, done: {} });
    const body = (await get(id)).json<{ lobby: Record<string, unknown> }>();
    expect(body.lobby.redisclosures).toBeUndefined();
    expect(body.lobby.invalidDisclosures).toEqual(['redisclosures']);
  });

  test('Q-T27 사유가 정확히 200자면 공시한다', async () => {
    const id = await event();
    const reason = '가'.repeat(200);
    proofs.set(id, { shuffle: { ...committed, 'emergency:lobby': JSON.stringify({ at: NOW, stop: 'beacon', reason, signed: signedOf(reason) }) }, done: {} });
    expect((await get(id)).json<{ lobby: { emergency: { reason: string } } }>().lobby.emergency.reason).toBe(reason);
  });

  test.each([
    ['멈춤 시각의 자릿수가 아주 김', { 'stop:lobby': `${'9'.repeat(40)}:beacon` }],
    ['날짜 범위를 넘는 멈춤 시각', { 'stop:lobby': '9999999999999999:unauthorized' }],
  ])('Q-T27 %s이어도 500이 아니고 unknown으로 낸다', async (_n, extra) => {
    const id = await event();
    proofs.set(id, { shuffle: { ...committed, ...extra }, done: {} });
    const res = await get(id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ lobby: { stopped: { reason: string } } }>().lobby.stopped.reason).toBe('unknown');
  });

  test('Q-T27 날짜 범위를 넘는 시각·라운드는 칸을 내지 않고 500도 없다', async () => {
    const id = await event();
    proofs.set(id, { shuffle: { ...committed, 'at:lobby': '9999999999999999', 'round:lobby': '9999999999999999' }, done: {} });
    const res = await get(id);
    expect(res.statusCode).toBe(200);
    const lobby = res.json<{ lobby: Record<string, unknown> }>().lobby;
    expect(lobby).not.toHaveProperty('committedAt');
    expect(lobby).not.toHaveProperty('roundAt');
  });

  test('Q-T27 서명 없는 표시로 멈춘 구간은 그 이유를 낸다', async () => {
    const id = await event();
    proofs.set(id, { shuffle: { ...committed, 'stop:lobby': `${NOW}:unauthorized` }, done: {} });
    expect((await get(id)).json<{ lobby: { stopped: unknown } }>().lobby.stopped).toEqual({ reason: 'unknown', detail: 'unauthorized', at: new Date(NOW).toISOString() });
  });

  test('Q-T27 시드를 풀지 못해 멈춘 구간은 그 이유를 낸다', async () => {
    const id = await event();
    proofs.set(id, { shuffle: { ...committed, 'stop:lobby': `${NOW}:seed_unavailable` }, done: {} });
    expect((await get(id)).json<{ lobby: { stopped: unknown } }>().lobby.stopped).toEqual({ reason: 'unknown', detail: 'seed_unavailable', at: new Date(NOW).toISOString() });
  });

  test('Q-T27 비상 셔플 표시가 없으면 칸이 없다', async () => {
    const id = await event();
    proofs.set(id, { shuffle: { ...committed }, done: {} });
    const body = (await get(id)).json<{ lobby: Record<string, unknown> }>();
    expect(body.lobby).not.toHaveProperty('emergency');
    expect(body.lobby).not.toHaveProperty('redisclosures');
  });
});

async function event(o: { lobbyShuffle?: boolean; openBatch?: boolean; opensAtMs?: number } = {}) {
  const id = newEvent();
  await schedules.set(id, { opensAtMs: o.opensAtMs ?? OPENS, startsAtMs: OPENS + 3 * 86_400_000, lobbyShuffle: o.lobbyShuffle ?? true, openBatch: o.openBatch ?? true });
  return id;
}

describe('셔플 검증 정보', () => {
  test('[ASVS v5.0.0-3.2.1] [ASVS v5.0.0-14.3.2] POL-005 커밋 전에는 값 칸 없이 공시 틀만 주고 공개 캐시 5초다', async () => {
    const id = await event();
    const r = await get(id);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.headers['cache-control']).toBe('public, max-age=5');
    expect(r.headers['set-cookie']).toBeUndefined();
    const body = QueueShuffleProof.parse(JSON.parse(r.payload));
    expect(body.lobby).toEqual({ chain: 'quicknet', algorithm: 'v1', fixedAt: new Date(OPENS).toISOString(), resultPathPrefix: `/v1/queues/${id}/shuffle-results/`, fileCount: 4096 });
    expect(body.batch).toEqual({ chain: 'quicknet', algorithm: 'v1', fixedAt: new Date(OPENS + 2_000).toISOString(), resultPathPrefix: `/v1/queues/${id}/batch-results/`, fileCount: 4096 });
    expect(body.opensAt).toBe(new Date(OPENS).toISOString());
    expect(body.seedRevealAt).toBe(new Date(OPENS + SEED_REVEAL_AFTER_MS).toISOString());
  });

  test('[ASVS v5.0.0-13.3.2] POL-005 FR-038 커밋·루트·비콘·게시 값을 내고 봉인 값은 어디에도 싣지 않는다', async () => {
    const id = await event();
    proofs.set(id, {
      shuffle: { ...committed, 'beacon:lobby': BEACON, 'sig:lobby': SIG },
      done: { lobby: '1:5:1', 'root:lobby': ROOT, 'rootAt:lobby': String(OPENS + 1_000), 'pub:lobby': String(OPENS + 6_000) },
    });
    const r = await get(id);
    expect(r.payload).not.toContain('SEALED-SECRET');
    const { lobby } = QueueShuffleProof.parse(JSON.parse(r.payload));
    expect(lobby).toMatchObject({
      commit: COMMIT,
      committedAt: new Date(NOW - 600_000).toISOString(),
      round: 8_000_000,
      roundAt: new Date(drandRoundTimeMs(8_000_000)).toISOString(),
      merkleRoot: ROOT,
      rootAt: new Date(OPENS + 1_000).toISOString(),
      firstSeq: 1,
      participantCount: 5,
      beacon: BEACON,
      beaconSignature: SIG,
      publishedAt: new Date(OPENS + 6_000).toISOString(),
    });
  });

  test('[ASVS v5.0.0-13.3.2] POL-005 공개 시각 전에는 저장소에 시드가 있어도 내지 않는다', async () => {
    const id = await event();
    proofs.set(id, { shuffle: { ...committed, 'seed:lobby': SEED, 'seedAt:lobby': String(OPENS + 3_600_000) }, done: { lobby: '1:5:1', 'pub:lobby': String(OPENS + 6_000) } });
    const { lobby } = QueueShuffleProof.parse(JSON.parse((await get(id)).payload));
    expect(lobby?.seed).toBeUndefined();
    expect(lobby?.seedRevealedAt).toBeUndefined();
  });

  test('[ASVS v5.0.0-13.3.2] POL-005 공개 시각이 지나면 공개한 시드를 싣는다', async () => {
    const opensAtMs = NOW - SEED_REVEAL_AFTER_MS - 1_000;
    const id = await event({ opensAtMs });
    proofs.set(id, { shuffle: { ...committed, 'seed:lobby': SEED, 'seedAt:lobby': String(NOW - 500) }, done: { lobby: '1:5:1', 'pub:lobby': String(opensAtMs + 6_000) } });
    const { lobby } = QueueShuffleProof.parse(JSON.parse((await get(id)).payload));
    expect(lobby).toMatchObject({ seed: SEED, seedRevealedAt: new Date(NOW - 500).toISOString() });
  });

  test('POL-005 끈 구간은 null이고 멈춘 구간은 사유를 낸다', async () => {
    const id = await event({ lobbyShuffle: false });
    proofs.set(id, { shuffle: { 'commit:1': COMMIT, 'round:1': '8000000', 'at:1': String(NOW), 'sealed:1': 'x', 'stop:1': `${NOW + 5}:beacon` }, done: { '1': '1:2:1' } });
    const body = QueueShuffleProof.parse(JSON.parse((await get(id)).payload));
    expect(body.lobby).toBeNull();
    expect(body.batch).toMatchObject({ commit: COMMIT, stopped: { reason: 'beacon', at: new Date(NOW + 5).toISOString() } });
  });

  test('POL-005 머클 루트 늦은 공시·참가자 불일치 멈춤도 사유를 낸다', async () => {
    for (const reason of ['late_root', 'members_changed'] as const) {
      const id = await event({ lobbyShuffle: false });
      proofs.set(id, { shuffle: { 'stop:1': `${NOW}:${reason}` }, done: {} });
      const body = QueueShuffleProof.parse(JSON.parse((await get(id)).payload));
      expect(body.batch?.stopped).toEqual({ reason, at: new Date(NOW).toISOString() });
    }
  });

  test('FR-038 참가자 0명 구간은 파일이 없으므로 fileCount가 0이다', async () => {
    const id = await event({ lobbyShuffle: false });
    proofs.set(id, { shuffle: {}, done: { '1': '1:0:1', 'pub:1': String(NOW) } });
    const { batch } = QueueShuffleProof.parse(JSON.parse((await get(id)).payload));
    expect(batch).toMatchObject({ participantCount: 0, fileCount: 0 });
  });

  test('[ASVS v5.0.0-3.5.3] 검증 정보는 읽기 전용이다(GET만 받는다)', async () => {
    const id = await event();
    expect((await svc.http.inject({ method: 'POST', url: `/v1/queues/${id}/shuffle-proof`, payload: {} })).statusCode).toBe(404);
  });

  test('POL-005 없는 회차와 틀린 회차 ID는 404다', async () => {
    expect((await get(newEvent())).statusCode).toBe(404);
    expect((await get('no.such')).statusCode).toBe(404);
  });
});

describe('결과 파일(local·ci·demo)', () => {
  test('[ASVS v5.0.0-3.2.1] FR-038 폴더의 결과 파일을 JSON과 60초 캐시로 준다', async () => {
    const id = newEvent();
    mkdirSync(join(resultDir, id, 'shuffle-results'), { recursive: true });
    writeFileSync(join(resultDir, id, 'shuffle-results', 'abc.json'), '{"x":1}');
    const r = await svc.http.inject({ method: 'GET', url: `/v1/queues/${id}/shuffle-results/abc.json` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    expect(r.headers['access-control-allow-origin']).toBe('https://www.peaket.example');
    expect(r.payload).toBe('{"x":1}');
  });

  test('Q-T32 없는 파일은 1초 캐시 404다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: `/v1/queues/${newEvent()}/batch-results/abc.json` });
    expect(r.statusCode).toBe(404);
    expect(r.headers['cache-control']).toBe('public, max-age=1');
  });

  test('틀린 파일 이름은 폴더를 벗어나지 못하고 404다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: `/v1/queues/e1/shuffle-results/${encodeURIComponent('../../x')}.json` });
    expect(r.statusCode).toBe(404);
  });
});

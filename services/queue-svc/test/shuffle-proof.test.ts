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

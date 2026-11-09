// 허니팟 기록 조건(docs/features/bot-defense.md §7, queue-admission §7 '기록 조건', ADR-0065 결정 9·ADR-0249 결정 3, Q-T40).
// 처리기를 HTTP로 불러 모든 경우 204·빈 본문임을 보고, 기록은 조건을 만족할 때만 남는지 본다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryFeatureStore } from '../src/modules/scoring/adapters/memory-feature-store.js';
import { RecordHoneypot } from '../src/modules/scoring/application/record-honeypot.js';
import { countsAsHoneypotHit } from '../src/modules/scoring/domain/honeypot.js';
import { PID } from './support.js';

const PATH = '/internal/honeypot-hit';
/** 저장소의 회차 ID 형식(UUID) */
const uuidOf = (n: number) => `0190f3a1-7c2e-7a00-8000-${n.toString(16).padStart(12, '0')}`;
const EVENT = uuidOf(1);
const OTHER_EVENT = uuidOf(2);
const NOW = Date.UTC(2026, 10, 9, 1, 0, 0);

const SAME = { 'sec-fetch-site': 'same-origin' };
let svc: Awaited<ReturnType<typeof createService>>;
let features: MemoryFeatureStore;
let hits: boolean[];
let verdicts: { eventId: string; eventKey: string; occurredAtMs: number }[];
let flush: () => Promise<void>;

const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const clock = fakeClock({ now: NOW });
const pending: Promise<void>[] = [];

beforeAll(async () => {
  features = new MemoryFeatureStore();
  hits = [];
  verdicts = [];
  flush = async () => {
    await Promise.all(pending.splice(0));
  };
  const honeypot = new RecordHoneypot({
    features,
    recorder: { honeypot: (r) => verdicts.push(r) },
    signals: { honeypotHit: (signedIn) => hits.push(signedIn), afterFailed: () => undefined },
    clock,
    after: (w) => void pending.push(w()),
  });
  svc = await createService({ name: 'trust-svc', module: AppModule.register({ honeypot }), env: { PEAKET_ENV: 'ci' }, clock, logDestination: quiet });
});

afterAll(async () => {
  await svc?.close();
});

beforeEach(() => {
  features.clear();
  hits.length = 0;
  verdicts.length = 0;
});

async function hit(headers: Record<string, string> = {}, query = `e=${EVENT}`) {
  const res = await svc.app.getHttpAdapter().getInstance().inject({ method: 'GET', url: query ? `${PATH}?${query}` : PATH, headers });
  await flush();
  return res;
}

describe('허니팟 기록 조건(Q-T40)', () => {
  test('[Q-T40] [ASVS v5.0.0-3.5.3] 같은출처의로그인클릭만_적중이고_표시와판정기록이남는다', async () => {
    const r = await hit({ ...SAME, 'x-user-pid': PID });
    expect([r.statusCode, r.body]).toEqual([204, '']);
    expect(await features.honeypotOf(PID)).toEqual({ atMs: clock.now(), eventId: EVENT });
    expect(hits).toEqual([true]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ eventId: EVENT, occurredAtMs: clock.now() });
  });

  test('[Q-T40] 로그인하지않은클릭은_지표만오른다', async () => {
    const r = await hit(SAME);
    expect(r.statusCode).toBe(204);
    expect(hits).toEqual([false]);
    expect(verdicts).toEqual([]);
  });

  test('[Q-T40] [ASVS v5.0.0-3.5.3] 다른사이트·미리가져오기·미리그리기·라우터미리가져오기·헤더없는요청은_기록되지않는다', async () => {
    const cases: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site', 'x-user-pid': PID },
      { 'sec-fetch-site': 'same-site', 'x-user-pid': PID },
      { 'sec-fetch-site': 'none', 'x-user-pid': PID },
      { ...SAME, 'sec-purpose': 'prefetch', 'x-user-pid': PID },
      { ...SAME, 'sec-purpose': 'prefetch;prerender', 'x-user-pid': PID },
      { ...SAME, 'next-router-prefetch': '1', 'x-user-pid': PID },
      { 'x-user-pid': PID },
    ];
    for (const c of cases) {
      const r = await hit(c);
      expect([r.statusCode, r.body], JSON.stringify(c)).toEqual([204, '']);
    }
    expect(await features.honeypotOf(PID)).toBeUndefined();
    expect(hits).toEqual([]);
    expect(verdicts).toEqual([]);
  });

  test('[Q-T40] 회차를모르면_표시만쓰고_판정기록은내지않는다', async () => {
    await hit({ ...SAME, 'x-user-pid': PID }, '');
    expect(await features.honeypotOf(PID)).toEqual({ atMs: clock.now(), eventId: '' });
    expect(verdicts).toEqual([]);
  });

  test('[Q-T40] 같은사람의같은회차반복적중은_24시간에판정기록한번이고_다른회차는따로낸다', async () => {
    await hit({ ...SAME, 'x-user-pid': PID });
    await hit({ ...SAME, 'x-user-pid': PID });
    expect(verdicts).toHaveLength(1);
    await hit({ ...SAME, 'x-user-pid': PID }, `e=${OTHER_EVENT}`);
    expect(verdicts.map((v) => v.eventId)).toEqual([EVENT, OTHER_EVENT]);
    expect(hits).toEqual([true, true, true]);
    clock.advance(86_400_000);
    await hit({ ...SAME, 'x-user-pid': PID });
    expect(verdicts).toHaveLength(3);
  });

  test('[Q-T40] 표시쓰기가실패하면_판정기록을내지않는다', async () => {
    features.failWrites(true);
    await hit({ ...SAME, 'x-user-pid': PID });
    expect(verdicts).toEqual([]);
  });

  test('[Q-T40] pid키전환중에는_옛pid로표시를써서_판정의읽기와같은기준이다', async () => {
    const r = await hit({ ...SAME, 'x-user-pid': PID, 'x-user-pid-prev': 'pid-old' });
    expect(r.statusCode).toBe(204);
    expect(await features.honeypotOf('pid-old')).toMatchObject({ eventId: EVENT });
    expect(await features.honeypotOf(PID)).toBeUndefined();
  });

  test('[Q-T40] 옛pid의모양이틀리면_지금pid를쓴다', async () => {
    await hit({ ...SAME, 'x-user-pid': PID, 'x-user-pid-prev': 'a{b}' });
    expect(await features.honeypotOf(PID)).toMatchObject({ eventId: EVENT });
  });

  test('[Q-T40] 회차값이64자를넘으면_회차를모르는것으로본다(키가늘지않는다)', async () => {
    await hit({ ...SAME, 'x-user-pid': PID }, `e=${'x'.repeat(65)}`);
    expect(await features.honeypotOf(PID)).toMatchObject({ eventId: '' });
    expect(verdicts).toEqual([]);
  });

  test('[Q-T40] 회차가UUID꼴이아니면_회차를모르는것으로보고_판정기록을내지않는다(가짜회차를막는다)', async () => {
    for (const e of ['ev-1', EVENT.toUpperCase(), `${EVENT}0`, 'a'.repeat(36)]) {
      await hit({ ...SAME, 'x-user-pid': PID }, `e=${e}`);
      expect(await features.honeypotOf(PID), e).toMatchObject({ eventId: '' });
    }
    expect(verdicts).toEqual([]);
  });

  test('[Q-T40] pid당24시간에기록하는회차는20개까지이고_넘어도204이며표시는쓴다', async () => {
    for (let n = 1; n <= 25; n++) {
      const r = await hit({ ...SAME, 'x-user-pid': PID }, `e=${uuidOf(n)}`);
      expect(r.statusCode).toBe(204);
    }
    expect(verdicts).toHaveLength(20);
    expect(await features.honeypotOf(PID)).toMatchObject({ eventId: uuidOf(25) });
    // 이미 기록한 회차를 다시 불러도 늘지 않고, 다른 사람의 몫은 따로다
    await hit({ ...SAME, 'x-user-pid': PID }, `e=${uuidOf(1)}`);
    expect(verdicts).toHaveLength(20);
    await hit({ ...SAME, 'x-user-pid': 'pid-other' }, `e=${uuidOf(1)}`);
    expect(verdicts).toHaveLength(21);
    // 24시간이 지나면 다시 센다
    clock.advance(86_400_000);
    await hit({ ...SAME, 'x-user-pid': PID }, `e=${uuidOf(30)}`);
    expect(verdicts).toHaveLength(22);
  });

  test('회차·pid의모양이틀리면_키에넣지않는다(응답은같다)', async () => {
    const bad = await hit({ ...SAME, 'x-user-pid': 'x'.repeat(65) });
    expect(bad.statusCode).toBe(204);
    expect(hits).toEqual([false]);
    await hit({ ...SAME, 'x-user-pid': PID }, 'e=' + encodeURIComponent('a{b}c'));
    expect(await features.honeypotOf(PID)).toEqual({ atMs: clock.now(), eventId: '' });
  });

  test('[Q-T40] 표시쓰기가실패해도_응답은204다', async () => {
    features.failWrites(true);
    const r = await hit({ ...SAME, 'x-user-pid': PID });
    expect(r.statusCode).toBe(204);
  });

  test('[Q-T40] 다음사전검증은_확정신호를읽는다', async () => {
    await hit({ ...SAME, 'x-user-pid': PID });
    const read = await features.read({ deviceRef: undefined, pid: PID, now: NOW });
    expect(read.honeypot).toBe(true);
  });

  test('countsAsHoneypotHit: 헤더의대소문자와배열꼴을가리지않는다', () => {
    expect(countsAsHoneypotHit({ fetchSite: 'SAME-ORIGIN', purpose: undefined, routerPrefetch: undefined })).toBe(true);
    expect(countsAsHoneypotHit({ fetchSite: 'same-origin', purpose: 'Prefetch', routerPrefetch: undefined })).toBe(false);
  });
});

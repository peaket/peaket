// 통합 시험: 라벨 반영 ApplyLabel(docs/features/bot-defense.md §9 '첫 구현', trust.proto TrustLabelService)을 실제 Valkey와 실제 gRPC로 끝까지 돈다.
// 판정 근거 키는 실제 ScoreRisk 판정으로 만든다. 차단 키(tr:block)·판 가드(tr:blkv)·멱등 기록(tr:lbl)은 Valkey에서 직접 읽어 정확한 값까지 본다.
// 칸 이름은 정본의 식(라벨 ID의 SHA-256 앞 32자)을 시험이 따로 계산한다.
// 시험: B-T9 ①~④, B-T20 ①~⑨·⑪~⑬, B-T27 ①~⑪, Q-T48 ①③④⑤. B-T20 ⑩·Q-T48 ②는 다른 단계(docs/review/ledger-notes.md).
import * as grpc from '@grpc/grpc-js';
import { TrustVerdict } from '@peaket/contracts/asyncapi';
import { trustV1Trust } from '@peaket/contracts/proto';
import { createPlatformLogger, type HotRedis, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { deviceRefsFromEnv } from '../src/modules/scoring/adapters/device-refs.js';
import { PromTrustSignals } from '../src/modules/scoring/adapters/prom-trust-signals.js';
import { keys } from '../src/modules/scoring/adapters/redis-feature-store.js';
import { RecordHoneypot } from '../src/modules/scoring/application/record-honeypot.js';
import { labelEventKey } from '../src/modules/scoring/domain/labels.js';
import { DAY, dev, devicesV1, KEY_V2, labelWorld, type LabelWorld, lid, PSEUDONYMS, sha32 } from './label-world.js';
import { startTcpProxy } from './tcp-proxy.js';
import { startValkey } from './valkey.js';

const valkey = startValkey();
let w: LabelWorld;

beforeAll(async () => {
  w = await labelWorld(valkey.url);
});

afterAll(async () => {
  await w?.close();
  valkey.stop();
});

const reset = async (x: LabelWorld) => {
  await x.cmd(['FLUSHALL']);
  x.offered.length = 0;
  x.logLines.length = 0;
  x.warnLines.length = 0;
  x.verdictLog.length = 0;
  x.errors.length = 0;
  (x.signals as { seen?: string[] }).seen?.splice(0);
  x.human.set('PASSED');
};

const ref = (name: string) => devicesV1.ref(dev(name))!;
const B = (r: string) => `BLOCK_LIST_CHANGE_${r}`;
const statusOf = (p: Promise<unknown>): Promise<number | 'OK'> =>
  p.then(
    () => 'OK' as const,
    (e: grpc.ServiceError) => e.code,
  );
const NINETY_DAYS = 90 * DAY;
const NO_REVIEW = { review_batch: undefined, applied_verdict: undefined };
/** 사람·회차 해시(부정 예매 출처는 회차만) */
const who = (pid: string, ev = 'ev-1') => sha32(`${pid}|${ev}`);
const fraudWho = (ev = 'ev-1') => sha32(`*|${ev}`);
const pairF = (ref_: string, pid: string) => sha32(`${ref_}|${pid}`);
const caseF = (ref_: string) => sha32(`case|${ref_}`);
/** 멱등 기록에서 라벨 하나의 칸 */
const entry = (sourceRef: string, pid: string, source: string, o: { v: number; l: string; s: string; r?: string; d?: string }) => {
  const e = lid(sourceRef, pid, source);
  return { [`${e}:v`]: String(o.v), [`${e}:l`]: o.l, [`${e}:s`]: o.s, ...(o.r ? { [`${e}:r`]: o.r } : {}), ...(o.d ? { [`${e}:d`]: o.d } : {}) };
};

async function blockValue(x: LabelWorld, name: string): Promise<Record<string, unknown> | null> {
  const v = await x.cmd(['GET', keys.block(ref(name))]);
  return v === null ? null : (JSON.parse(String(v)) as Record<string, unknown>);
}

/** 사람 확인 실패로 CHALLENGE(확정 신호 없음)를 받아 판정 근거 키를 만든다. 돌려주는 값은 그 판정의 사건 키 */
async function challengeByHuman(x: LabelWorld, pid: string, device: string, event = 'ev-1'): Promise<string> {
  x.human.set('FAILED');
  const r = await x.scoreRisk({ pid, device_id: dev(device), event_id: event });
  x.human.set('PASSED');
  expect(r).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_HUMAN_CHECK' });
  expect(r.eventKey).toMatch(/^[0-9a-f-]{36}$/);
  return r.eventKey;
}

/** 차단 목록 기기로 사전 검증해 판정 근거(확정 신호 차단 목록)를 만든다 */
async function challengeByBlock(x: LabelWorld, pid: string, device: string, event = 'ev-1'): Promise<string> {
  const r = await x.scoreRisk({ pid, device_id: dev(device), event_id: event });
  expect(r).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_DEVICE_HISTORY' });
  return r.eventKey;
}

const evidenceOf = async (x: LabelWorld, pid: string, event = 'ev-1') => JSON.parse(String(await x.cmd(['GET', keys.evidence(pid, event)]))) as Record<string, unknown>;
const seenOf = (x: LabelWorld): string[] => (x.signals as unknown as { seen: string[] }).seen;
const labelsOut = (x: LabelWorld) => x.offered.filter((o) => String(o.value.category).startsWith('LABELED_'));
const expect90Days = (ttl: number) => {
  expect(ttl).toBeGreaterThan(NINETY_DAYS - 60_000);
  expect(ttl).toBeLessThanOrEqual(NINETY_DAYS);
};
const waitReady = async (r: HotRedis) => {
  for (let i = 0; ; i++) {
    try {
      await r.command(['PING'], { deadlineMs: 500 });
      return;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((res) => setTimeout(res, 100));
    }
  }
};

/** 표본 검토(SAMPLE_REVIEW). 뽑힌 판정의 사건 키를 꼭 준다 */
const review = (x: LabelWorld, key: string, o: Record<string, unknown>) => x.applyLabel({ verdict_event_key: key, ...o });
const confirmed = (x: LabelWorld, o: Record<string, unknown>) => x.applyLabel({ source: 'LABEL_SOURCE_FRAUD_CONFIRMED', ...NO_REVIEW, ...o });
const appeal = (x: LabelWorld, o: Record<string, unknown>) => x.applyLabel({ source: 'LABEL_SOURCE_APPEAL_ACCEPTED', label: 'LABEL_HUMAN', ...NO_REVIEW, ...o });
const fraud = (x: LabelWorld, o: Record<string, unknown>) => x.applyLabel({ source: 'LABEL_SOURCE_FRAUD_ACTIONED', label: 'LABEL_BOT', ...NO_REVIEW, ...o });
const fraudAppeal = (x: LabelWorld, o: Record<string, unknown>) => x.applyLabel({ source: 'LABEL_SOURCE_FRAUD_APPEAL_ACCEPTED', label: 'LABEL_HUMAN', ...NO_REVIEW, ...o });

describe('B-T9 차단 기기 목록 등재 조건', () => {
  beforeEach(() => reset(w));

  test('B-T9②_표본검토봇판정은판정근거의기기에차단키를올리고_값에등재사유·확정출처·건ID·등재시각이있으며_세키의수명은90일이다', async () => {
    const k = await challengeByHuman(w, 'pid-a', 'a');
    const before = Date.now();
    expect(await review(w, k, { source_ref: 'rev-1', pid: 'pid-a' })).toEqual({ changed: true, block_list: B('ADDED') });
    const v = await blockValue(w, 'a');
    expect(v).toEqual({ reason: 'SAMPLE_REVIEW', source: 'SAMPLE_REVIEW', caseId: 'rev-1', listedAtMs: expect.any(Number) });
    expect(v!.listedAtMs as number).toBeGreaterThanOrEqual(before);
    expect(v!.listedAtMs as number).toBeLessThanOrEqual(Date.now());
    expect90Days(await w.pttl(keys.block(ref('a'))));
    expect(await w.hash(keys.blockVersion(ref('a')))).toEqual({ [lid('rev-1', 'pid-a', 'SAMPLE_REVIEW')]: '1|ADDED' });
    expect90Days(await w.pttl(keys.blockVersion(ref('a'))));
    expect(await w.hash(keys.label('rev-1'))).toEqual({ src: 'SAMPLE_REVIEW', who: who('pid-a'), ...entry('rev-1', 'pid-a', 'SAMPLE_REVIEW', { v: 1, l: 'BOT', s: 'D', r: 'ADDED', d: ref('a') }) });
    expect90Days(await w.pttl(keys.label('rev-1')));
    // 차단 키가 생긴 기기는 이것 하나다
    expect(await w.keysLike('tr:block:*')).toEqual([keys.block(ref('a'))]);
  });

  test('B-T9②_부정구매확인봇도키를올리고_이미있으면NONE이며_처음등재의값과수명을그대로둔다', async () => {
    const k = await challengeByHuman(w, 'pid-f', 'f');
    expect(await confirmed(w, { source_ref: 'cs-1', pid: 'pid-f' })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await blockValue(w, 'f')).toMatchObject({ reason: 'FRAUD_CONFIRMED', source: 'FRAUD_CONFIRMED', caseId: 'cs-1' });
    // 남은 수명을 줄여 두고 다른 건으로 다시 올린다: 값과 수명이 그대로다
    await w.cmd(['PEXPIRE', keys.block(ref('f')), '3600000']);
    const first = await w.cmd(['GET', keys.block(ref('f'))]);
    expect(await review(w, k, { source_ref: 'rev-9', pid: 'pid-f' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await w.cmd(['GET', keys.block(ref('f'))])).toBe(first);
    expect(await w.pttl(keys.block(ref('f')))).toBeLessThanOrEqual(3_600_000);
    expect(await w.hash(keys.blockVersion(ref('f')))).toEqual({ [lid('cs-1', 'pid-f', 'FRAUD_CONFIRMED')]: '1|ADDED', [lid('rev-9', 'pid-f', 'SAMPLE_REVIEW')]: '1|NONE' });
  });

  test('B-T9②_사람라벨과이의인정은키를만들지않는다', async () => {
    const keysOf: string[] = [];
    for (const i of [0, 1, 2, 3]) keysOf.push(await challengeByHuman(w, `pid-h${i}`, `h${i}`));
    expect(await review(w, keysOf[0]!, { source_ref: 'h-1', pid: 'pid-h0', label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await confirmed(w, { source_ref: 'h-2', pid: 'pid-h1', label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await appeal(w, { source_ref: 'h-3', pid: 'pid-h2' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await fraudAppeal(w, { source_ref: 'h-4', pid: 'pid-h3' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await w.keysLike('tr:block:*')).toEqual([]);
  });

  test('B-T9①_추가검증실패와허니팟적중으로는차단키가생기지않는다', async () => {
    w.human.set('FAILED');
    for (let i = 0; i < 3; i++) await w.scoreRisk({ context: 'SCORE_CONTEXT_VERIFICATION', pid: 'pid-v', device_id: dev('v'), lobby_shuffle: undefined });
    w.human.set('PASSED');
    const after: Promise<unknown>[] = [];
    const hp = new RecordHoneypot({ features: w.features, recorder: { honeypot: () => undefined }, signals: { honeypotHit: () => undefined, afterFailed: () => undefined }, clock: systemClock, after: (x) => void after.push(x()) });
    hp.run({ fetchSite: 'same-origin', purpose: undefined, routerPrefetch: undefined, pid: 'pid-v', eventId: '0190f3a1-7c2e-7a00-8000-000000000001' });
    await Promise.all(after);
    // 허니팟 표시로 다음 사전 검증은 확정 신호(INTERACTION)지만 차단 키는 없다
    expect(await w.scoreRisk({ pid: 'pid-v', device_id: dev('v') })).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_INTERACTION' });
    expect(await w.cmd(['EXISTS', keys.honeypot('pid-v')])).toBe(1);
    const hist = await w.hash(keys.devHistory(ref('v')));
    expect(Object.entries(hist).filter(([k]) => k.startsWith('failed:')).map(([, n]) => n)).toEqual(['3']);
    expect(await w.keysLike('tr:block:*')).toEqual([]);
    expect(await w.keysLike('tr:blkv:*')).toEqual([]);
  });

  test('B-T9③_B-T27①_표본검토사람재판정(큰판)은키를지우고_판가드와멱등기록이큰판으로바뀐다', async () => {
    const k = await challengeByHuman(w, 'pid-r', 'r');
    expect(await review(w, k, { source_ref: 'rev-r', pid: 'pid-r' })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await review(w, k, { source_ref: 'rev-r', pid: 'pid-r', source_version: 2, label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(ref('r'))])).toBe(0);
    expect(await w.hash(keys.blockVersion(ref('r')))).toEqual({ [lid('rev-r', 'pid-r', 'SAMPLE_REVIEW')]: '2|REMOVED' });
    expect(await w.hash(keys.label('rev-r'))).toEqual({ src: 'SAMPLE_REVIEW', who: who('pid-r'), ...entry('rev-r', 'pid-r', 'SAMPLE_REVIEW', { v: 2, l: 'HUMAN', s: 'D', r: 'REMOVED', d: ref('r') }) });
  });

  test('B-T9③_이의인정은판정근거의확정신호가차단목록이면키를지운다', async () => {
    const k = await challengeByHuman(w, 'pid-x', 'x', 'ev-0');
    await review(w, k, { source_ref: 'rev-x', pid: 'pid-x', event_id: 'ev-0' });
    await challengeByBlock(w, 'pid-x', 'x', 'ev-1');
    expect(await evidenceOf(w, 'pid-x', 'ev-1')).toMatchObject({ hardSignal: 'BLOCK_LIST', deviceRef: ref('x') });
    expect(await appeal(w, { source_ref: 'appeal-x', pid: 'pid-x' })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(ref('x'))])).toBe(0);
    expect(await w.hash(keys.blockVersion(ref('x')))).toEqual({ [lid('rev-x', 'pid-x', 'SAMPLE_REVIEW')]: '1|ADDED', [lid('appeal-x', 'pid-x', 'APPEAL_ACCEPTED')]: '1|REMOVED' });
  });

  test('B-T9③_이의인정의큰판은앞판이찾은기기라도판정근거를다시읽는다_판1이NONE이어도다시등재된키를판2가지운다', async () => {
    const k = await challengeByHuman(w, 'pid-w', 'w', 'ev-0');
    await review(w, k, { source_ref: 'rev-w', pid: 'pid-w', event_id: 'ev-0' });
    await challengeByBlock(w, 'pid-w', 'w', 'ev-1');
    // 다른 길(표본 검토 정정)로 키가 지워진 뒤 온 이의 인정 판 1은 지울 키가 없다(앞 판의 기기로 남는다)
    expect(await review(w, k, { source_ref: 'rev-w', pid: 'pid-w', event_id: 'ev-0', source_version: 2, label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await appeal(w, { source_ref: 'ap-w', pid: 'pid-w' })).toEqual({ changed: true, block_list: B('NONE') });
    // 그 기기가 다른 건으로 다시 오른다
    expect(await confirmed(w, { source_ref: 'cs-w', pid: 'pid-w' })).toEqual({ changed: true, block_list: B('ADDED') });
    // 판 2는 앞 판이 찾은 기기를 쓰되 판정 근거의 확정 신호(차단 목록)를 다시 읽어 지운다
    expect(await appeal(w, { source_ref: 'ap-w', pid: 'pid-w', source_version: 2 })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(ref('w'))])).toBe(0);
  });

  test('B-T9③_이의인정은판정근거의확정신호가차단목록이아니면키를두고NONE이다', async () => {
    const k = await challengeByHuman(w, 'pid-y', 'y');
    // 판정 뒤에 그 판정의 표본 검토로 그 기기가 목록에 올랐다(판정의 근거는 차단 목록이 아니다)
    await review(w, k, { source_ref: 'rev-y', pid: 'pid-y' });
    expect(await appeal(w, { source_ref: 'appeal-y', pid: 'pid-y' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await w.cmd(['EXISTS', keys.block(ref('y'))])).toBe(1);
  });

  test('B-T9③_소유자대조_다른pid·다른회차의판정근거로는남의차단키를지우지못한다', async () => {
    // pid-a의 ev-1 판정 근거는 차단 목록(기기 a), pid-b의 ev-1 판정 근거는 다른 기기의 사람 확인 실패다
    const k = await challengeByHuman(w, 'pid-a', 'a', 'ev-0');
    await review(w, k, { source_ref: 'rev-a', pid: 'pid-a', event_id: 'ev-0' });
    await challengeByBlock(w, 'pid-a', 'a', 'ev-1');
    await challengeByHuman(w, 'pid-b', 'b', 'ev-1');
    expect(await appeal(w, { source_ref: 'ap-1', pid: 'pid-b', event_id: 'ev-1' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await appeal(w, { source_ref: 'ap-2', pid: 'pid-a', event_id: 'ev-2' })).toEqual({ changed: true, block_list: B('DEVICE_NOT_FOUND') });
    expect(await w.cmd(['EXISTS', keys.block(ref('a'))])).toBe(1);
    expect(await w.keysLike('tr:blkv:*')).toEqual([keys.blockVersion(ref('a')), keys.blockVersion(ref('b'))].sort());
    expect(await w.hash(keys.blockVersion(ref('b')))).toEqual({ [lid('ap-1', 'pid-b', 'APPEAL_ACCEPTED')]: '1|NONE' });
    // 그 사람의 그 회차 판정 근거로 와야 지운다
    expect(await appeal(w, { source_ref: 'ap-3', pid: 'pid-a', event_id: 'ev-1' })).toEqual({ changed: true, block_list: B('REMOVED') });
  });

  test('B-T9③_다른건(부정구매확인)이올린키도표본검토사람판정이지운다', async () => {
    const k = await challengeByHuman(w, 'pid-c', 'c');
    await confirmed(w, { source_ref: 'cs-a', pid: 'pid-c' });
    expect(await review(w, k, { source_ref: 'rev-c', pid: 'pid-c', label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(ref('c'))])).toBe(0);
  });

  test('B-T9③_부정구매확인판1BOT은올리고_판2HUMAN정정은그건이올린키를지운다', async () => {
    await challengeByHuman(w, 'pid-g', 'g');
    expect(await confirmed(w, { source_ref: 'cs-g', pid: 'pid-g' })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await confirmed(w, { source_ref: 'cs-g', pid: 'pid-g', source_version: 2, label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(ref('g'))])).toBe(0);
  });

  test('B-T9③_부정구매확인의HUMAN정정은다른건이올린키를지우지않는다', async () => {
    const k = await challengeByHuman(w, 'pid-e', 'e');
    await review(w, k, { source_ref: 'rev-x', pid: 'pid-e' });
    expect(await confirmed(w, { source_ref: 'cs-b', pid: 'pid-e', label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await blockValue(w, 'e')).toMatchObject({ caseId: 'rev-x' });
  });

  test('B-T9④_표본검토사람판정은부정예매조치가올린키를지우지않는다_그사건의이의인정만지운다', async () => {
    const k = await challengeByHuman(w, 'pid-j', 'j');
    expect(await fraud(w, { source_ref: 'fc-j', pid: 'pid-j' })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await review(w, k, { source_ref: 'rev-j', pid: 'pid-j', label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await blockValue(w, 'j')).toMatchObject({ source: 'FRAUD_ACTIONED', caseId: 'fc-j' });
    // 판정 근거가 차단 목록이어도 CS의 이의 인정·다른 사건의 이의 인정은 조치가 올린 키를 지우지 않는다(2인 승인 조치)
    await challengeByBlock(w, 'pid-j', 'j', 'ev-2');
    expect(await appeal(w, { source_ref: 'ap-j', pid: 'pid-j', event_id: 'ev-2' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await fraudAppeal(w, { source_ref: 'fc-other', pid: 'pid-j', event_id: 'ev-2' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await w.cmd(['EXISTS', keys.block(ref('j'))])).toBe(1);
    expect(await fraudAppeal(w, { source_ref: 'fc-j', pid: 'pid-j', source_version: 2 })).toEqual({ changed: true, block_list: B('REMOVED') });
  });

  test('B-T9④_뽑힌판정의사건키를대문자로보내도소문자와같은판정근거로보고같은결과다', async () => {
    const k = await challengeByHuman(w, 'pid-u', 'u');
    expect(k).toBe(k.toLowerCase());
    expect(await review(w, k.toUpperCase(), { source_ref: 'rev-u', pid: 'pid-u' })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await w.keysLike('tr:block:*')).toEqual([keys.block(ref('u'))]);
  });

  test('B-T9④_표본검토는뽑힌판정의사건키가판정근거와같을때만그기기를바꾼다_같은사람의다른판정으로는DEVICE_NOT_FOUND다', async () => {
    // 같은 사람·회차: 사전 검증 A(기기 a)는 CHALLENGE, 로비 B(기기 b)는 ALLOW. 판정 근거 키는 A의 것이다
    const kA = await challengeByHuman(w, 'pid-p', 'pa');
    expect(await review(w, kA, { source_ref: 'rev-pa', pid: 'pid-p' })).toEqual({ changed: true, block_list: B('ADDED') });
    const before = await w.cmd(['GET', keys.block(ref('pa'))]);
    const lobby = await w.scoreRisk({ context: 'SCORE_CONTEXT_LOBBY_ENTRY', pid: 'pid-p', device_id: dev('pb') });
    expect(lobby).toMatchObject({ verdict: 'VERDICT_ALLOW' });
    expect(lobby.eventKey).not.toBe(kA);
    const pb = { review_batch: 'REVIEW_BATCH_PASSED', applied_verdict: 'VERDICT_ALLOW' };
    expect(await review(w, lobby.eventKey, { source_ref: 'rev-pb1', pid: 'pid-p', ...pb })).toEqual({ changed: true, block_list: B('DEVICE_NOT_FOUND') });
    expect(await review(w, lobby.eventKey, { source_ref: 'rev-pb2', pid: 'pid-p', label: 'LABEL_HUMAN', ...pb })).toEqual({ changed: true, block_list: B('DEVICE_NOT_FOUND') });
    expect(await w.cmd(['GET', keys.block(ref('pa'))])).toBe(before);
    expect(await w.keysLike('tr:block:*')).toEqual([keys.block(ref('pa'))]);
  });
});

describe('B-T20 부정 예매 조사에서 오는 라벨', () => {
  beforeEach(() => reset(w));

  test('B-T20①_FRAUD_ACTIONED봇이면판정근거의기기에차단키가생기고_값에확정출처와건ID가있다', async () => {
    await challengeByHuman(w, 'pid-1', 'one');
    expect(await fraud(w, { source_ref: 'fc-1', pid: 'pid-1' })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await blockValue(w, 'one')).toEqual({ reason: 'FRAUD_ACTIONED', source: 'FRAUD_ACTIONED', caseId: 'fc-1', listedAtMs: expect.any(Number) });
    expect90Days(await w.pttl(keys.block(ref('one'))));
    // 멱등 기록은 (pid, 출처)마다이고, 짝 칸에 가장 큰 판과 차례(0 조치)가 있다
    expect(await w.hash(keys.label('fc-1'))).toEqual({ src: 'FRAUD', who: fraudWho(), [`p${pairF('fc-1', 'pid-1')}`]: '1|0', ...entry('fc-1', 'pid-1', 'FRAUD_ACTIONED', { v: 1, l: 'BOT', s: 'D', r: 'ADDED', d: ref('one') }) });
    // 판 가드에는 라벨 칸, 짝 칸(조치 상태), 사건의 조치 계정 수가 있다
    expect(await w.hash(keys.blockVersion(ref('one')))).toEqual({ [lid('fc-1', 'pid-1', 'FRAUD_ACTIONED')]: '1|ADDED', [`p${pairF('fc-1', 'pid-1')}`]: '1|A', [`c${caseF('fc-1')}`]: '1' });
  });

  test('B-T20②_외부게시물대조는라벨출처가아니라_INVALID_ARGUMENT이고차단키가생기지않는다', async () => {
    const values = Object.keys((trustV1Trust as { nested: { peaket: { nested: { trust: { nested: { v1: { nested: { LabelSource: { values: Record<string, number> } } } } } } } } }).nested.peaket.nested.trust.nested.v1.nested.LabelSource.values);
    expect(values.some((v) => v.includes('POST_MATCH'))).toBe(false);
    await challengeByHuman(w, 'pid-2', 'two');
    // 2026-10-31에 뺀 게시물 대조 출처의 번호(6)를 보내도 받지 않는다
    expect(await statusOf(w.applyLabel({ source_ref: 'pm-1', pid: 'pid-2', source: 6, ...NO_REVIEW }))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await w.keysLike('tr:block:*')).toEqual([]);
    expect(await w.keysLike('tr:lbl:*')).toEqual([]);
  });

  test('B-T20③_①의기기에FRAUD_APPEAL_ACCEPTED사람을보내면같은사건이올린키를지운다', async () => {
    await challengeByHuman(w, 'pid-3', 'three');
    await fraud(w, { source_ref: 'fc-3', pid: 'pid-3' });
    expect(await fraudAppeal(w, { source_ref: 'fc-3', pid: 'pid-3', source_version: 2 })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(ref('three'))])).toBe(0);
    expect(await w.hash(keys.blockVersion(ref('three')))).toEqual({
      [lid('fc-3', 'pid-3', 'FRAUD_ACTIONED')]: '1|ADDED',
      [lid('fc-3', 'pid-3', 'FRAUD_APPEAL_ACCEPTED')]: '2|REMOVED',
      [`p${pairF('fc-3', 'pid-3')}`]: '2|R',
      [`c${caseF('fc-3')}`]: '0',
    });
    expect(await w.hash(keys.label('fc-3'))).toMatchObject({ src: 'FRAUD', [`p${pairF('fc-3', 'pid-3')}`]: '2|1', ...entry('fc-3', 'pid-3', 'FRAUD_APPEAL_ACCEPTED', { v: 2, l: 'HUMAN', s: 'D', r: 'REMOVED', d: ref('three') }) });
  });

  test('B-T20④_판정근거에차단목록이있던사람의FRAUD_APPEAL_ACCEPTED는다른건(표본검토)이올린키도지운다', async () => {
    const k = await challengeByHuman(w, 'pid-4', 'four', 'ev-0');
    await review(w, k, { source_ref: 'rev-4', pid: 'pid-4', event_id: 'ev-0' });
    await challengeByBlock(w, 'pid-4', 'four', 'ev-1');
    expect(await fraudAppeal(w, { source_ref: 'fc-4', pid: 'pid-4' })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(ref('four'))])).toBe(0);
  });

  test('B-T20④_조치판1이기기를찾아둬도_이의인정판2는판정근거(차단목록)를다시읽어다른건이올린키를지운다', async () => {
    const k = await challengeByHuman(w, 'pid-22', 'tt', 'ev-0');
    await review(w, k, { source_ref: 'rev-22', pid: 'pid-22', event_id: 'ev-0' });
    await challengeByBlock(w, 'pid-22', 'tt', 'ev-1');
    // 같은 (사건, pid)의 조치 판 1: 이미 표본 검토로 올라 있어 NONE이고, 찾은 기기를 멱등 기록에 둔다
    expect(await fraud(w, { source_ref: 'fc-22', pid: 'pid-22' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await fraudAppeal(w, { source_ref: 'fc-22', pid: 'pid-22', source_version: 2 })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(ref('tt'))])).toBe(0);
  });

  test('B-T20③_같은판의조치뒤이의인정은뒤의일로보고키를지우고_다시온같은판의조치는키를올리지않는다', async () => {
    await challengeByHuman(w, 'pid-tie', 'tie');
    expect(await fraud(w, { source_ref: 'fc-tie', pid: 'pid-tie' })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await fraudAppeal(w, { source_ref: 'fc-tie', pid: 'pid-tie' })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect((await fraud(w, { source_ref: 'fc-tie', pid: 'pid-tie' })).changed).toBe(false);
    expect(await w.cmd(['EXISTS', keys.block(ref('tie'))])).toBe(0);
    expect((await w.hash(keys.label('fc-tie')))[`p${pairF('fc-tie', 'pid-tie')}`]).toBe('1|1');
  });

  test('B-T20④_판정근거도차단목록이아니고키의건ID도다르면FRAUD_APPEAL_ACCEPTED가지우지않는다', async () => {
    const k = await challengeByHuman(w, 'pid-5', 'five');
    await review(w, k, { source_ref: 'rev-5', pid: 'pid-5' });
    expect(await fraudAppeal(w, { source_ref: 'fc-other', pid: 'pid-5' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await blockValue(w, 'five')).toMatchObject({ caseId: 'rev-5' });
  });

  test('B-T20⑤_FRAUD_ACTIONED에사람·FRAUD_APPEAL_ACCEPTED에봇이면INVALID_ARGUMENT이고아무것도바뀌지않는다', async () => {
    await challengeByHuman(w, 'pid-6', 'six');
    expect(await statusOf(fraud(w, { source_ref: 'fc-6', pid: 'pid-6', label: 'LABEL_HUMAN' }))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await statusOf(fraudAppeal(w, { source_ref: 'fc-6', pid: 'pid-6', label: 'LABEL_BOT' }))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await w.keysLike('tr:lbl:*')).toEqual([]);
    expect(await w.keysLike('tr:block:*')).toEqual([]);
    expect(await w.keysLike('tr:blkv:*')).toEqual([]);
  });

  test('B-T20⑥_같은건ID·판을다시보내면changed가false이고처음결과를준다', async () => {
    await challengeByHuman(w, 'pid-7', 'seven');
    expect(await fraud(w, { source_ref: 'fc-7', pid: 'pid-7' })).toEqual({ changed: true, block_list: B('ADDED') });
    const value = await w.cmd(['GET', keys.block(ref('seven'))]);
    const guard = await w.hash(keys.blockVersion(ref('seven')));
    expect(await fraud(w, { source_ref: 'fc-7', pid: 'pid-7' })).toEqual({ changed: false, block_list: B('ADDED') });
    expect(await w.cmd(['GET', keys.block(ref('seven'))])).toBe(value);
    // 조치 계정 수가 두 번 오르지 않는다
    expect(await w.hash(keys.blockVersion(ref('seven')))).toEqual(guard);
    expect(w.logLines).toHaveLength(1);
  });

  test('B-T20⑦_부정예매출처둘은판정기록(telemetry.trust-verdicts)에라벨사건을내지않는다', async () => {
    await challengeByHuman(w, 'pid-8', 'eight');
    w.offered.length = 0;
    await fraud(w, { source_ref: 'fc-8', pid: 'pid-8' });
    await fraudAppeal(w, { source_ref: 'fc-8', pid: 'pid-8', source_version: 2 });
    // 끝난 판을 다시 보내도 내지 않는다
    await fraud(w, { source_ref: 'fc-8', pid: 'pid-8' });
    expect(w.offered).toEqual([]);
    // 차단 키를 바꾼 보안 로그 줄은 남는다
    expect(w.logLines.map((l) => l.change)).toEqual(['ADDED', 'REMOVED']);
  });

  test('B-T20⑧_판정근거키가수명(30일)을다하면요청의device_ref로올리고_그것도없으면DEVICE_NOT_FOUND이며라벨만반영한다', async () => {
    await challengeByHuman(w, 'pid-9', 'nine');
    const e = keys.evidence('pid-9', 'ev-1');
    const ttl = await w.pttl(e);
    expect(ttl).toBeGreaterThan(30 * DAY - 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * DAY);
    // 판정 근거가 있으면 요청의 device_ref보다 그 값을 먼저 쓴다
    expect(await fraud(w, { source_ref: 'fc-9a', pid: 'pid-9', device_ref: ref('other') })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await w.keysLike('tr:block:*')).toEqual([keys.block(ref('nine'))]);
    // 30일이 지난 것처럼 판정 근거 키의 수명을 끝낸다
    await w.cmd(['PEXPIRE', e, '1']);
    await new Promise((r) => setTimeout(r, 20));
    expect(await w.cmd(['EXISTS', e])).toBe(0);
    expect(await fraud(w, { source_ref: 'fc-9b', pid: 'pid-9' })).toEqual({ changed: true, block_list: B('DEVICE_NOT_FOUND') });
    expect(await w.hash(keys.label('fc-9b'))).toMatchObject(entry('fc-9b', 'pid-9', 'FRAUD_ACTIONED', { v: 1, l: 'BOT', s: 'D', r: 'DEVICE_NOT_FOUND' }));
    expect(await fraud(w, { source_ref: 'fc-9c', pid: 'pid-9', device_ref: ref('nine-new') })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await w.keysLike('tr:block:*')).toEqual([keys.block(ref('nine')), keys.block(ref('nine-new'))].sort());
    expect(await blockValue(w, 'nine-new')).toMatchObject({ source: 'FRAUD_ACTIONED', caseId: 'fc-9c' });
  });

  test('B-T20⑨_한사건ID로계정둘을차례로보내면둘다반영된다', async () => {
    await challengeByHuman(w, 'pid-a1', 'a1');
    await challengeByHuman(w, 'pid-a2', 'a2');
    expect(await fraud(w, { source_ref: 'fc-10', pid: 'pid-a1' })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await fraud(w, { source_ref: 'fc-10', pid: 'pid-a2' })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await w.keysLike('tr:block:*')).toEqual([keys.block(ref('a1')), keys.block(ref('a2'))].sort());
    // 한 계정의 소명 인정은 그 계정의 기기 키만 지운다(앞 판이 찾은 기기를 쓴다)
    expect(await fraudAppeal(w, { source_ref: 'fc-10', pid: 'pid-a1', source_version: 2 })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.keysLike('tr:block:*')).toEqual([keys.block(ref('a2'))]);
    const states = Object.keys(await w.hash(keys.label('fc-10'))).filter((k) => k.endsWith(':s')).sort();
    expect(states).toEqual([`${lid('fc-10', 'pid-a1', 'FRAUD_ACTIONED')}:s`, `${lid('fc-10', 'pid-a1', 'FRAUD_APPEAL_ACCEPTED')}:s`, `${lid('fc-10', 'pid-a2', 'FRAUD_ACTIONED')}:s`].sort());
  });

  test('B-T20⑪_한사건의두계정이같은기기로조치되면한계정의이의인정으로는지워지지않고_둘다인정되면지워진다', async () => {
    const d = ref('shared-dev');
    expect(await fraud(w, { source_ref: 'fc-11', pid: 'pid-s1', device_ref: d })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await fraud(w, { source_ref: 'fc-11', pid: 'pid-s2', device_ref: d })).toEqual({ changed: true, block_list: B('NONE') });
    expect((await w.hash(keys.blockVersion(d)))[`c${caseF('fc-11')}`]).toBe('2');
    expect(await fraudAppeal(w, { source_ref: 'fc-11', pid: 'pid-s1', source_version: 2 })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await w.cmd(['EXISTS', keys.block(d)])).toBe(1);
    expect((await w.hash(keys.blockVersion(d)))[`c${caseF('fc-11')}`]).toBe('1');
    expect(await fraudAppeal(w, { source_ref: 'fc-11', pid: 'pid-s2', source_version: 2 })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(d)])).toBe(0);
    expect((await w.hash(keys.blockVersion(d)))[`c${caseF('fc-11')}`]).toBe('0');
  });

  test('B-T20⑪_같은계정의조치큰판은사건계정수를두번세지않는다_이의인정판3에지운다', async () => {
    const d = ref('again-dev');
    expect(await fraud(w, { source_ref: 'fc-29', pid: 'pid-29', device_ref: d })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await fraud(w, { source_ref: 'fc-29', pid: 'pid-29', device_ref: d, source_version: 2 })).toEqual({ changed: true, block_list: B('NONE') });
    expect((await w.hash(keys.blockVersion(d)))[`c${caseF('fc-29')}`]).toBe('1');
    expect(await fraudAppeal(w, { source_ref: 'fc-29', pid: 'pid-29', device_ref: d, source_version: 3 })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect((await w.hash(keys.blockVersion(d)))[`c${caseF('fc-29')}`]).toBe('0');
    expect(await w.cmd(['EXISTS', keys.block(d)])).toBe(0);
  });

  test('B-T20⑪_같은계정의이의인정큰판은사건계정수를두번내리지않는다_다른계정의조치가남아키를둔다', async () => {
    const d = ref('two-dev');
    await fraud(w, { source_ref: 'fc-30', pid: 'pid-s1', device_ref: d });
    await fraud(w, { source_ref: 'fc-30', pid: 'pid-s2', device_ref: d });
    expect((await w.hash(keys.blockVersion(d)))[`c${caseF('fc-30')}`]).toBe('2');
    expect(await fraudAppeal(w, { source_ref: 'fc-30', pid: 'pid-s1', device_ref: d, source_version: 2 })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await fraudAppeal(w, { source_ref: 'fc-30', pid: 'pid-s1', device_ref: d, source_version: 3 })).toEqual({ changed: true, block_list: B('NONE') });
    expect((await w.hash(keys.blockVersion(d)))[`c${caseF('fc-30')}`]).toBe('1');
    expect(await w.cmd(['EXISTS', keys.block(d)])).toBe(1);
  });

  test('B-T20⑫_조치판1이차단키Lua앞에서멈춘사이이의인정판2가끝나면_풀린조치판1은키를올리지않는다', async () => {
    const d = ref('gate-32');
    let release!: () => void;
    let reached!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const at = new Promise<void>((r) => (reached = r));
    const wrap = (r: HotRedis): HotRedis => ({
      ...r,
      evalScript: async (s, k, a, o) => {
        // 차단 키 Lua(키 셋)의 인자: [라벨 칸, 판, …, 이 라벨이 조치(A)·이의 인정(R)]
        if (k.length === 3 && k[0] === keys.block(d) && a[1] === '1' && a[9] === 'A') {
          reached();
          await hold;
        }
        return r.evalScript(s, k, a, o);
      },
    });
    const x = await labelWorld(valkey.url, { wrap });
    try {
      await reset(x);
      const p1 = fraud(x, { source_ref: 'fc-32', pid: 'pid-32', device_ref: d });
      await at;
      expect(await fraudAppeal(x, { source_ref: 'fc-32', pid: 'pid-32', device_ref: d, source_version: 2 })).toEqual({ changed: true, block_list: B('NONE') });
      release();
      expect(await p1).toEqual({ changed: false, block_list: B('NONE') });
      expect(await x.cmd(['EXISTS', keys.block(d)])).toBe(0);
      const guard = await x.hash(keys.blockVersion(d));
      expect(guard[`p${pairF('fc-32', 'pid-32')}`]).toBe('2|R');
      expect(guard[`c${caseF('fc-32')}`]).toBeUndefined();
    } finally {
      release();
      await x.close();
    }
  });

  test('[ASVS v5.0.0-16.3.4] B-T20⑫_같은(사건,pid)에서큰판의이의인정이반영된뒤늦게온작은판의조치는키를올리지않는다', async () => {
    // 조치 판 1은 판정 근거를 읽는 단계에서 저장소 장애로 끊긴다('시작함'에 머문다)
    let failEvidence = true;
    const wrap = (r: HotRedis): HotRedis => ({
      ...r,
      command: async (args, o) => {
        if (failEvidence && String(args[1]).startsWith('tr:vb:')) {
          failEvidence = false;
          throw new Error('주입한 장애');
        }
        return r.command(args, o);
      },
    });
    const x = await labelWorld(valkey.url, { wrap });
    try {
      await reset(x);
      const d = ref('late');
      expect(await statusOf(fraud(x, { source_ref: 'fc-12', pid: 'pid-12', device_ref: d }))).toBe(grpc.status.UNAVAILABLE);
      expect(failEvidence).toBe(false);
      expect(x.warnLines).toEqual([{ kind: 'security', event: 'trust_label_apply_failed', caseId: 'fc-12', source: 'FRAUD_ACTIONED', step: 'evidence' }]);
      expect(await fraudAppeal(x, { source_ref: 'fc-12', pid: 'pid-12', source_version: 2, device_ref: d })).toEqual({ changed: true, block_list: B('NONE') });
      expect(await fraud(x, { source_ref: 'fc-12', pid: 'pid-12', device_ref: d })).toEqual({ changed: false, block_list: B('NONE') });
      expect(await x.cmd(['EXISTS', keys.block(d)])).toBe(0);
      expect(x.logLines).toEqual([]);
      // 멱등 기록의 짝 칸은 큰 판(2, 이의 인정)에 남고, 늦은 조치 판 1은 '시작함'에서 더 나아가지 않는다(멱등 기록이 작은 판으로 덮이지 않는다)
      const lbl = await x.hash(keys.label('fc-12'));
      expect(lbl[`p${pairF('fc-12', 'pid-12')}`]).toBe('2|1');
      expect(lbl[`${lid('fc-12', 'pid-12', 'FRAUD_ACTIONED')}:s`]).toBe('S');
    } finally {
      await x.close();
    }
  });

  test('B-T20⑬_지금판도이음중인옛판도아닌device_ref는DEVICE_NOT_FOUND다', async () => {
    const v2Only = deviceRefsFromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: KEY_V2.toString('base64'), PEAKET_INV_REF_DEVICE_KEY_VERSION: '2' }, systemClock).refs;
    const x = await labelWorld(valkey.url, { devices: v2Only });
    try {
      await reset(x);
      // k1 기기 가명은 이 키 링의 판정이 읽지 않는다
      expect(await fraud(x, { source_ref: 'fc-13', pid: 'pid-13', device_ref: ref('k1-only') })).toEqual({ changed: true, block_list: B('DEVICE_NOT_FOUND') });
      expect(await x.keysLike('tr:block:*')).toEqual([]);
      const k2 = v2Only.ref(dev('k2-dev'))!;
      expect(await fraud(x, { source_ref: 'fc-13b', pid: 'pid-13', device_ref: k2 })).toEqual({ changed: true, block_list: B('ADDED') });
    } finally {
      await x.close();
    }
  });
});

describe('B-T27 라벨 반영 호출', () => {
  beforeEach(() => reset(w));

  test('B-T27①_같은판·작은판은changed가false이고아무것도바꾸지않는다_큰판은반영한다', async () => {
    const k = await challengeByHuman(w, 'pid-s', 's');
    expect(await review(w, k, { source_ref: 'rev-s', pid: 'pid-s', source_version: 2 })).toEqual({ changed: true, block_list: B('ADDED') });
    const snapshot = async () => ({ block: await w.cmd(['GET', keys.block(ref('s'))]), blkv: await w.hash(keys.blockVersion(ref('s'))), lbl: await w.hash(keys.label('rev-s')) });
    const before = await snapshot();
    expect(await review(w, k, { source_ref: 'rev-s', pid: 'pid-s', source_version: 2 })).toEqual({ changed: false, block_list: B('ADDED') });
    expect(await review(w, k, { source_ref: 'rev-s', pid: 'pid-s', source_version: 1, label: 'LABEL_HUMAN' })).toEqual({ changed: false, block_list: B('ADDED') });
    expect(await snapshot()).toEqual(before);
    // 끝난 판의 다시 보내기는 같은 사건 키로 다시 내고, 작은 판은 내지 않는다
    expect(labelsOut(w).map((o) => o.value.eventKey)).toEqual([labelEventKey({ sourceRef: 'rev-s', pid: 'pid-s', source: 'SAMPLE_REVIEW', sourceVersion: 2 }), labelEventKey({ sourceRef: 'rev-s', pid: 'pid-s', source: 'SAMPLE_REVIEW', sourceVersion: 2 })]);
    expect(await review(w, k, { source_ref: 'rev-s', pid: 'pid-s', source_version: 3, label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.hash(keys.label('rev-s'))).toEqual({ src: 'SAMPLE_REVIEW', who: who('pid-s'), ...entry('rev-s', 'pid-s', 'SAMPLE_REVIEW', { v: 3, l: 'HUMAN', s: 'D', r: 'REMOVED', d: ref('s') }) });
  });

  test('B-T27①_판번호는수로견준다_판9뒤판10을반영하고다시온판9는작은판이다', async () => {
    const k = await challengeByHuman(w, 'pid-52', 'fiftytwo');
    expect(await review(w, k, { source_ref: 'rev-52', pid: 'pid-52', source_version: 9 })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await review(w, k, { source_ref: 'rev-52', pid: 'pid-52', source_version: 10, label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await review(w, k, { source_ref: 'rev-52', pid: 'pid-52', source_version: 9 })).toEqual({ changed: false, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(ref('fiftytwo'))])).toBe(0);
    expect((await w.hash(keys.label('rev-52')))[`${lid('rev-52', 'pid-52', 'SAMPLE_REVIEW')}:v`]).toBe('10');
    expect(await w.hash(keys.blockVersion(ref('fiftytwo')))).toEqual({ [lid('rev-52', 'pid-52', 'SAMPLE_REVIEW')]: '10|REMOVED' });
  });

  test('B-T27②_같은건ID에다른출처면ALREADY_EXISTS이고아무것도바뀌지않는다_부정예매출처둘끼리는아니다', async () => {
    const k = await challengeByHuman(w, 'pid-c', 'c');
    await review(w, k, { source_ref: 'case-c', pid: 'pid-c' });
    const before = { lbl: await w.hash(keys.label('case-c')), blkv: await w.hash(keys.blockVersion(ref('c'))) };
    expect(await statusOf(appeal(w, { source_ref: 'case-c', pid: 'pid-c' }))).toBe(grpc.status.ALREADY_EXISTS);
    expect(await statusOf(fraud(w, { source_ref: 'case-c', pid: 'pid-c' }))).toBe(grpc.status.ALREADY_EXISTS);
    expect({ lbl: await w.hash(keys.label('case-c')), blkv: await w.hash(keys.blockVersion(ref('c'))) }).toEqual(before);
    // 부정 예매 출처 둘은 같은 건 ID에 함께 온다. 그 건 ID에 다른 출처는 받지 않는다
    expect(await fraud(w, { source_ref: 'fc-c', pid: 'pid-c' })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await fraudAppeal(w, { source_ref: 'fc-c', pid: 'pid-c', source_version: 2 })).toEqual({ changed: true, block_list: B('NONE') });
    expect(await statusOf(review(w, k, { source_ref: 'fc-c', pid: 'pid-c' }))).toBe(grpc.status.ALREADY_EXISTS);
  });

  test('B-T27③_틀린값은INVALID_ARGUMENT이고_문구에값이없으며_아무것도바뀌지않는다', async () => {
    const k = await challengeByHuman(w, 'pid-i', 'i');
    const good = ref('i');
    const bad: Record<string, unknown>[] = [
      { source: 'LABEL_SOURCE_APPEAL_ACCEPTED', ...NO_REVIEW },
      { source: 'LABEL_SOURCE_UNSPECIFIED' },
      { label: 'LABEL_UNSPECIFIED' },
      { source_ref: '' },
      { source_ref: 'x'.repeat(65) },
      { source_ref: 'case 1' },
      { source_ref: 'case:1' },
      { source_version: -1 },
      { pid: '' },
      { pid: 'pid|x' },
      { event_id: '' },
      { event_id: 'ev}1' },
      { acted_by: '' },
      { acted_by: '가'.repeat(65) },
      { queue_entry_id: 'qe 1' },
      { device_ref: good },
      { source: 'LABEL_SOURCE_APPEAL_ACCEPTED', label: 'LABEL_HUMAN', device_ref: good, ...NO_REVIEW },
      { source: 'LABEL_SOURCE_FRAUD_CONFIRMED', device_ref: good, ...NO_REVIEW },
      { source: 'LABEL_SOURCE_FRAUD_ACTIONED', device_ref: 'k1.short', ...NO_REVIEW },
      { source: 'LABEL_SOURCE_FRAUD_ACTIONED', device_ref: `k0.${'A'.repeat(43)}`, ...NO_REVIEW },
      { source: 'LABEL_SOURCE_FRAUD_ACTIONED', device_ref: `x1.${'A'.repeat(43)}`, ...NO_REVIEW },
      { source: 'LABEL_SOURCE_FRAUD_ACTIONED', device_ref: `k1.${'A'.repeat(44)}`, ...NO_REVIEW },
      { review_batch: undefined },
      { applied_verdict: undefined },
      { applied_verdict: 'VERDICT_BLOCK' },
      { review_batch: 9 },
      { verdict_event_key: '' },
      { verdict_event_key: 'not-a-uuid-value' },
      { source: 'LABEL_SOURCE_FRAUD_CONFIRMED', applied_verdict: undefined },
      { source: 'LABEL_SOURCE_FRAUD_CONFIRMED', review_batch: undefined },
      { source: 'LABEL_SOURCE_FRAUD_CONFIRMED', ...NO_REVIEW, verdict_event_key: k },
    ];
    for (const b of bad) {
      const err = await w.applyLabel({ source_ref: 'case-i', pid: 'pid-i', verdict_event_key: k, ...b }).then(
        () => null,
        (e: grpc.ServiceError) => e,
      );
      expect(err?.code, JSON.stringify(b)).toBe(grpc.status.INVALID_ARGUMENT);
      for (const v of Object.values(b)) if (typeof v === 'string' && v.length > 3 && !v.startsWith('LABEL_') && !v.startsWith('VERDICT_')) expect(err!.details).not.toContain(v);
    }
    expect(await w.keysLike('tr:lbl:*')).toEqual([]);
    expect(await w.keysLike('tr:block:*')).toEqual([]);
    expect(await w.keysLike('tr:blkv:*')).toEqual([]);
    expect(labelsOut(w)).toEqual([]);
    // 경계의 안쪽은 받는다: 건 ID 64자, 처리자 64자(글자 수), 판 1, 판 번호 두 자리의 기기 가명은 모양으로는 받는다
    expect(await review(w, k, { source_ref: 'r'.repeat(64), pid: 'pid-i', acted_by: '가'.repeat(64) })).toEqual({ changed: true, block_list: B('ADDED') });
    expect(await fraud(w, { source_ref: 'fc-i', pid: 'pid-z', device_ref: `k12.${'A'.repeat(43)}` })).toEqual({ changed: true, block_list: B('DEVICE_NOT_FOUND') });
  });

  test('B-T27④_표본검토라벨은SAMPLE_REVIEW로묶음표시와적용판판정을싣고_부정구매확인·이의인정은POST_LABEL이며_처리자·pid·기기가명이없다', async () => {
    const k = await challengeByHuman(w, 'pid-t', 't');
    w.offered.length = 0;
    await review(w, k, { source_ref: 'rev-t', pid: 'pid-t', queue_entry_id: 'qe-1', acted_by: 'admin-secret-77' });
    await confirmed(w, { source_ref: 'cs-t', pid: 'pid-t', acted_by: 'admin-secret-77' });
    await appeal(w, { source_ref: 'ap-t', pid: 'pid-t', acted_by: 'admin-secret-77' });
    const out = labelsOut(w);
    expect(out.map((o) => [o.topic, o.key])).toEqual([
      ['telemetry.trust-verdicts', 'qe-1'],
      ['telemetry.trust-verdicts', null],
      ['telemetry.trust-verdicts', null],
    ]);
    expect(out[0]!.value).toEqual({
      eventId: 'ev-1',
      queueEntryId: 'qe-1',
      refMissing: false,
      category: 'LABELED_BOT',
      action: 'NONE',
      source: 'SAMPLE_REVIEW',
      shadow: false,
      reviewBatch: 'SHADOW_CHALLENGED',
      appliedVerdict: 'CHALLENGE',
      occurredAt: expect.any(String),
      eventKey: labelEventKey({ sourceRef: 'rev-t', pid: 'pid-t', source: 'SAMPLE_REVIEW', sourceVersion: 1 }),
    });
    expect(out[1]!.value).toMatchObject({ category: 'LABELED_BOT', action: 'NONE', source: 'POST_LABEL', shadow: false });
    expect(out[2]!.value).toMatchObject({ category: 'LABELED_HUMAN', action: 'NONE', source: 'POST_LABEL' });
    for (const o of out.slice(1)) {
      expect(o.value.reviewBatch).toBeUndefined();
      expect(o.value.appliedVerdict).toBeUndefined();
    }
    for (const o of out) {
      expect(TrustVerdict.safeParse(o.value).success, JSON.stringify(o.value)).toBe(true);
      const text = JSON.stringify(o.value);
      for (const banned of ['admin-secret-77', 'pid-t', ref('t'), 'actedBy', 'deviceRef', '"pid"']) expect(text.includes(banned), banned).toBe(false);
    }
    // 판이 다르면 사건 키도 다르다
    expect(labelEventKey({ sourceRef: 'rev-t', pid: 'pid-t', source: 'SAMPLE_REVIEW', sourceVersion: 2 })).not.toBe(out[0]!.value.eventKey);
  });

  test('[ASVS v5.0.0-16.3.3] B-T27⑤_차단키를바꾸면보안로그줄(건ID·출처·바뀐것·처리자로그가명·시각)과지표가남고_바뀌지않으면남지않는다', async () => {
    const metrics = new PlatformMetrics('trust-svc');
    const signals = new PromTrustSignals();
    signals.register(metrics.registry);
    const x = await labelWorld(valkey.url, { signals });
    try {
      const k = await challengeByHuman(x, 'pid-l', 'l');
      const t0 = Date.now();
      await review(x, k, { source_ref: 'rev-l', pid: 'pid-l', acted_by: 'ops-42' });
      await review(x, k, { source_ref: 'rev-l', pid: 'pid-l', acted_by: 'ops-42' });
      await review(x, k, { source_ref: 'rev-m', pid: 'pid-l', acted_by: 'ops-43' });
      await appeal(x, { source_ref: 'ap-n', pid: 'pid-nobody' });
      await review(x, k, { source_ref: 'rev-l', pid: 'pid-l', source_version: 2, label: 'LABEL_HUMAN', acted_by: 'ops-44' });
      expect(x.logLines).toEqual([
        { kind: 'security', event: 'trust_block_list_change', caseId: 'rev-l', source: 'SAMPLE_REVIEW', change: 'ADDED', accountRef: PSEUDONYMS.ref('ops-42'), at: expect.any(String) },
        { kind: 'security', event: 'trust_block_list_change', caseId: 'rev-l', source: 'SAMPLE_REVIEW', change: 'REMOVED', accountRef: PSEUDONYMS.ref('ops-44'), at: expect.any(String) },
      ]);
      for (const l of x.logLines) expect(Date.parse(String(l.at))).toBeGreaterThanOrEqual(t0 - 1);
      // 확정 신호로 차단 목록에 걸린 판정도 센다
      await review(x, k, { source_ref: 'rev-o', pid: 'pid-l' });
      await challengeByBlock(x, 'pid-l', 'l', 'ev-2');
      const text = await metrics.registry.metrics();
      expect(text).toContain('trust_block_list_changes_total{op="added",source="SAMPLE_REVIEW"} 2');
      expect(text).toContain('trust_block_list_changes_total{op="removed",source="SAMPLE_REVIEW"} 1');
      expect(text).toContain('trust_block_list_hits_total{signal="BLOCK_LIST"} 1');
    } finally {
      await x.close();
    }
  });

  test('[ASVS v5.0.0-16.3.3] B-T27⑤⑨_실제플랫폼로거를지난보안로그줄에기기가명·처리자원문·pid가없고_처리자는로그가명이다', async () => {
    const raw: string[] = [];
    const logger = createPlatformLogger({ service: 'trust-svc', env: 'ci', version: 't', clock: systemClock, level: 'info', destination: { write: (s: string) => (raw.push(s), true) } as unknown as NodeJS.WritableStream });
    const x = await labelWorld(valkey.url, { securityLogger: logger });
    try {
      await reset(x);
      const k = await challengeByHuman(x, 'pid-raw-77', 'raw');
      await review(x, k, { source_ref: 'rev-raw', pid: 'pid-raw-77', acted_by: 'admin-raw-99' });
      await review(x, k, { source_ref: 'rev-raw', pid: 'pid-raw-77', source_version: 2, label: 'LABEL_HUMAN', acted_by: 'admin-raw-99' });
      const lines = raw.map((s) => JSON.parse(s) as Record<string, unknown>).filter((l) => l.event === 'trust_block_list_change');
      expect(lines.map((l) => l.change)).toEqual(['ADDED', 'REMOVED']);
      for (const l of lines) expect(l).toMatchObject({ kind: 'security', caseId: 'rev-raw', source: 'SAMPLE_REVIEW', accountRef: PSEUDONYMS.ref('admin-raw-99'), level: 'info', msg: 'trust_block_list_change' });
      const text = raw.join('\n');
      expect(text).not.toMatch(/k\d+\.[A-Za-z0-9_-]{43}/);
      expect(text).not.toContain('admin-raw-99');
      expect(text).not.toContain('pid-raw-77');
    } finally {
      await x.close();
    }
  });

  test('[ASVS v5.0.0-16.3.4] B-T27⑥_차단키를바꾼뒤끝남을적기전에피처Redis를끊으면UNAVAILABLE이고_같은판을다시보내면한번만반영되며같은사건키로낸다', async () => {
    const proxy = await startTcpProxy(valkey.url);
    let armed = false;
    let cutAfter: string | undefined;
    const wrap = (r: HotRedis): HotRedis => ({
      ...r,
      evalScript: async (s, k, a, o) => {
        const out = await r.evalScript(s, k, a, o);
        // 차단 키를 바꾸는 Lua가 Valkey에서 끝난 바로 뒤('끝남'을 적기 전)에 실제 연결을 끊는다
        if (armed && k[0]?.startsWith('tr:block:')) {
          armed = false;
          cutAfter = k[0];
          proxy.cut();
          await new Promise((res) => setTimeout(res, 50));
        }
        return out;
      },
    });
    const x = await labelWorld(valkey.url, { serviceUrl: proxy.url, wrap });
    try {
      const k = await challengeByHuman(x, 'pid-cut', 'cut');
      armed = true;
      const err = await review(x, k, { source_ref: 'rev-cut', pid: 'pid-cut' }).then(
        () => null,
        (e: grpc.ServiceError) => e,
      );
      // 끊긴 사례가 실제로 있었다: 호출이 실패했고, 끊은 자리는 차단 키를 바꾼 뒤다
      expect(err?.code).toBe(grpc.status.UNAVAILABLE);
      expect(proxy.cuts).toBe(1);
      expect(cutAfter).toBe(keys.block(ref('cut')));
      expect(x.warnLines).toEqual([{ kind: 'security', event: 'trust_label_apply_failed', caseId: 'rev-cut', source: 'SAMPLE_REVIEW', step: 'finish' }]);
      const value = await x.cmd(['GET', keys.block(ref('cut'))]);
      expect(JSON.parse(String(value))).toMatchObject({ caseId: 'rev-cut', source: 'SAMPLE_REVIEW' });
      expect(await x.hash(keys.blockVersion(ref('cut')))).toEqual({ [lid('rev-cut', 'pid-cut', 'SAMPLE_REVIEW')]: '1|ADDED' });
      expect(await x.hash(keys.label('rev-cut'))).toEqual({ src: 'SAMPLE_REVIEW', who: who('pid-cut'), ...entry('rev-cut', 'pid-cut', 'SAMPLE_REVIEW', { v: 1, l: 'BOT', s: 'S' }) });
      expect(x.logLines).toHaveLength(1);
      expect(labelsOut(x)).toEqual([]);
      const ttl = await x.pttl(keys.block(ref('cut')));

      proxy.restore();
      await waitReady(x.serviceRedis);
      expect(await review(x, k, { source_ref: 'rev-cut', pid: 'pid-cut' })).toEqual({ changed: true, block_list: B('ADDED') });
      // 한 번만 반영했다: 차단 키를 다시 쓰지 않았다. 이어 반영한 같은 판도 보안 로그 줄을 남긴다(빠지는 것보다 두 번 남는 쪽)
      expect(await x.cmd(['GET', keys.block(ref('cut'))])).toBe(value);
      expect(await x.pttl(keys.block(ref('cut')))).toBeLessThanOrEqual(ttl);
      expect(x.logLines.map((l) => l.change)).toEqual(['ADDED', 'ADDED']);
      expect(await x.hash(keys.label('rev-cut'))).toEqual({ src: 'SAMPLE_REVIEW', who: who('pid-cut'), ...entry('rev-cut', 'pid-cut', 'SAMPLE_REVIEW', { v: 1, l: 'BOT', s: 'D', r: 'ADDED', d: ref('cut') }) });
      const key = labelEventKey({ sourceRef: 'rev-cut', pid: 'pid-cut', source: 'SAMPLE_REVIEW', sourceVersion: 1 });
      expect(labelsOut(x).map((o) => o.value.eventKey)).toEqual([key]);
      // 끝난 판을 다시 보내면 바꾸지 않고 같은 사건 키로 다시 낸다
      expect(await review(x, k, { source_ref: 'rev-cut', pid: 'pid-cut' })).toEqual({ changed: false, block_list: B('ADDED') });
      expect(labelsOut(x).map((o) => o.value.eventKey)).toEqual([key, key]);
    } finally {
      await x.close();
      await proxy.close();
    }
  });

  test('[ASVS v5.0.0-16.3.4] B-T27⑥_피처Redis에닿지못하면UNAVAILABLE이고_경고줄(건ID·출처·실패한단계)이남으며_오류문구에받은값이없다', async () => {
    const proxy = await startTcpProxy(valkey.url);
    const raw: string[] = [];
    const logger = createPlatformLogger({ service: 'trust-svc', env: 'ci', version: 't', clock: systemClock, level: 'info', destination: { write: (s: string) => (raw.push(s), true) } as unknown as NodeJS.WritableStream });
    const x = await labelWorld(valkey.url, { serviceUrl: proxy.url, securityLogger: logger });
    try {
      proxy.cut();
      const err = await x.applyLabel({ source_ref: 'rev-down-77', pid: 'pid-down-77', verdict_event_key: '0190f3a1-7c2e-7a00-8000-0000000000aa', acted_by: 'admin-down-1' }).then(
        () => null,
        (e: grpc.ServiceError) => e,
      );
      expect(err?.code).toBe(grpc.status.UNAVAILABLE);
      expect(err!.details).not.toContain('rev-down-77');
      expect(err!.details).not.toContain('pid-down-77');
      const lines = raw.map((s) => JSON.parse(s) as Record<string, unknown>);
      expect(lines).toEqual([expect.objectContaining({ level: 'warn', kind: 'security', event: 'trust_label_apply_failed', caseId: 'rev-down-77', source: 'SAMPLE_REVIEW', step: 'claim' })]);
      expect(raw.join('\n')).not.toMatch(/pid-down-77|admin-down-1/);
      expect(await x.keysLike('tr:lbl:*')).toEqual([]);
    } finally {
      await x.close();
      await proxy.close();
    }
  });

  test('[ASVS v5.0.0-16.3.4] B-T27⑧_차단키Lua의답만잃고다시보내면보안로그줄이남고_끝남의답만잃고다시보내면같은사건키로라벨을낸다', async () => {
    const proxy = await startTcpProxy(valkey.url);
    let lose: 'block' | 'finish' | undefined;
    const wrap = (r: HotRedis): HotRedis => ({
      ...r,
      evalScript: async (s, k, a, o) => {
        // 차단 키 Lua(키 셋, tr:block…)나 '끝남' Lua(tr:lbl…, 인자 다섯)를 보내기 직전에 Valkey의 답만 버리게 한다(명령은 실행된다)
        const hit = (lose === 'block' && k[0]?.startsWith('tr:block:')) || (lose === 'finish' && k[0]?.startsWith('tr:lbl:') && a.length === 5);
        if (hit) {
          lose = undefined;
          proxy.dropReplies();
        }
        return r.evalScript(s, k, a, o);
      },
    });
    const x = await labelWorld(valkey.url, { serviceUrl: proxy.url, wrap });
    try {
      await reset(x);
      const k = await challengeByHuman(x, 'pid-lost', 'lost');
      lose = 'block';
      expect(await statusOf(review(x, k, { source_ref: 'rev-lost', pid: 'pid-lost' }))).toBe(grpc.status.UNAVAILABLE);
      // 차단 키는 Valkey에서 바뀌었지만 답을 잃어 보안 로그 줄이 없다
      expect(proxy.dropped).toBeGreaterThan(0);
      expect(await x.cmd(['EXISTS', keys.block(ref('lost'))])).toBe(1);
      expect(x.logLines).toEqual([]);
      proxy.restore();
      await waitReady(x.serviceRedis);
      expect(await review(x, k, { source_ref: 'rev-lost', pid: 'pid-lost' })).toEqual({ changed: true, block_list: B('ADDED') });
      expect(x.logLines.map((l) => [l.caseId, l.change])).toEqual([['rev-lost', 'ADDED']]);
      expect(labelsOut(x)).toHaveLength(1);

      // '끝남'의 답만 잃는다: 멱등 기록은 끝남이지만 부른 쪽은 UNAVAILABLE을 받아 라벨을 내지 못했다
      const k2 = await challengeByHuman(x, 'pid-fin', 'fin');
      x.offered.length = 0;
      lose = 'finish';
      const before = proxy.dropped;
      expect(await statusOf(review(x, k2, { source_ref: 'rev-fin', pid: 'pid-fin' }))).toBe(grpc.status.UNAVAILABLE);
      expect(proxy.dropped).toBeGreaterThan(before);
      expect((await x.hash(keys.label('rev-fin')))[`${lid('rev-fin', 'pid-fin', 'SAMPLE_REVIEW')}:s`]).toBe('D');
      expect(labelsOut(x)).toEqual([]);
      proxy.restore();
      await waitReady(x.serviceRedis);
      expect(await review(x, k2, { source_ref: 'rev-fin', pid: 'pid-fin' })).toEqual({ changed: false, block_list: B('ADDED') });
      expect(labelsOut(x).map((o) => o.value.eventKey)).toEqual([labelEventKey({ sourceRef: 'rev-fin', pid: 'pid-fin', source: 'SAMPLE_REVIEW', sourceVersion: 1 })]);
    } finally {
      await x.close();
      await proxy.close();
    }
  });

  test('B-T27⑨_같은건ID에처음과다른사람·회차가오면ALREADY_EXISTS이고_멱등기록·판가드의칸이름과값에pid원문이없다', async () => {
    const k = await challengeByHuman(w, 'pid-orig-77', 'orig');
    expect(await review(w, k, { source_ref: 'rev-9', pid: 'pid-orig-77' })).toEqual({ changed: true, block_list: B('ADDED') });
    const kOther = await challengeByHuman(w, 'pid-other-77', 'other');
    expect(await statusOf(review(w, kOther, { source_ref: 'rev-9', pid: 'pid-other-77', source_version: 2 }))).toBe(grpc.status.ALREADY_EXISTS);
    const kEv = await challengeByHuman(w, 'pid-orig-77', 'orig-b', 'ev-other');
    expect(await statusOf(review(w, kEv, { source_ref: 'rev-9', pid: 'pid-orig-77', event_id: 'ev-other', source_version: 2 }))).toBe(grpc.status.ALREADY_EXISTS);
    // 부정 예매 사건도 회차가 다르면 받지 않는다(계정은 여럿이어도 된다)
    await fraud(w, { source_ref: 'fc-9', pid: 'pid-orig-77' });
    expect(await statusOf(fraud(w, { source_ref: 'fc-9', pid: 'pid-orig-77', event_id: 'ev-other', source_version: 2 }))).toBe(grpc.status.ALREADY_EXISTS);
    for (const key of [keys.label('rev-9'), keys.label('fc-9'), keys.blockVersion(ref('orig'))]) {
      const h = await w.hash(key);
      expect(Object.keys(h).length).toBeGreaterThan(0);
      const text = JSON.stringify(h);
      expect(text, key).not.toContain('pid-orig-77');
      expect(text, key).not.toContain('pid-other-77');
      for (const name of Object.keys(h)) expect(name, key).toMatch(/^(src|who|[pc]?[0-9a-f]{32}(:[vlsrd])?)$/);
    }
  });

  test('B-T27⑩_표본검토의첫째묶음에적용판CHALLENGE와_판0은INVALID_ARGUMENT다', async () => {
    const k = await challengeByHuman(w, 'pid-10', 'ten');
    expect(await statusOf(review(w, k, { source_ref: 'rev-10', pid: 'pid-10', review_batch: 'REVIEW_BATCH_PASSED', applied_verdict: 'VERDICT_CHALLENGE' }))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await statusOf(review(w, k, { source_ref: 'rev-10', pid: 'pid-10', source_version: 0 }))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await w.keysLike('tr:lbl:*')).toEqual([]);
    // 둘째 묶음은 적용 판 판정 둘 다 받는다
    expect(await review(w, k, { source_ref: 'rev-10', pid: 'pid-10', review_batch: 'REVIEW_BATCH_SHADOW_CHALLENGED', applied_verdict: 'VERDICT_ALLOW' })).toEqual({ changed: true, block_list: B('ADDED') });
  });

  test('B-T27⑪_같은라벨의정정(BOT→HUMAN)은판정근거키가사라진뒤에도앞판이찾은기기의키를지운다', async () => {
    const k = await challengeByHuman(w, 'pid-11', 'eleven');
    expect(await review(w, k, { source_ref: 'rev-11', pid: 'pid-11' })).toEqual({ changed: true, block_list: B('ADDED') });
    await w.cmd(['PEXPIRE', keys.evidence('pid-11', 'ev-1'), '1']);
    await new Promise((r) => setTimeout(r, 20));
    expect(await w.cmd(['EXISTS', keys.evidence('pid-11', 'ev-1')])).toBe(0);
    expect(await review(w, k, { source_ref: 'rev-11', pid: 'pid-11', source_version: 2, label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('REMOVED') });
    expect(await w.cmd(['EXISTS', keys.block(ref('eleven'))])).toBe(0);
  });

  describe('B-T27⑦ 판이 다른 두 호출이 겹친다', () => {
    /** 정한 판의 차단 키 Lua나 '끝남' Lua를 hold가 풀릴 때까지 늦춘다. reached는 그 자리에 닿았을 때 풀린다 */
    function gate(on: 'block' | 'finish', version: string) {
      let release!: () => void;
      let reached!: () => void;
      const g = { hold: new Promise<void>((r) => (release = r)), reached: new Promise<void>((r) => (reached = r)), release: () => release() };
      const wrap = (r: HotRedis): HotRedis => ({
        ...r,
        evalScript: async (s, k, a, o) => {
          // 차단 키 Lua의 인자: [라벨, 판, …]. '끝남' Lua의 인자: [라벨 칸, 판, 결과, 수명, 기기](멱등 기록 키, 인자 다섯)
          const hit = on === 'block' ? k[0]?.startsWith('tr:block:') && a[1] === version : k[0]?.startsWith('tr:lbl:') && a.length === 5 && a[1] === version;
          if (hit) {
            reached();
            await g.hold;
          }
          return r.evalScript(s, k, a, o);
        },
      });
      return { g, wrap };
    }

    test('B-T27⑦_옛판의차단키Lua가새판뒤에돌면건너뛰고_마지막상태는큰판의결과다', async () => {
      // 판 1(BOT, 올림)이 판정한 뒤 차단 키 Lua 앞에서 멈춘 사이 판 2(HUMAN, 지움)가 끝까지 간다
      const { g, wrap } = gate('block', '1');
      const x = await labelWorld(valkey.url, { wrap });
      try {
        await reset(x);
        const k = await challengeByHuman(x, 'pid-o', 'o');
        const p1 = review(x, k, { source_ref: 'rev-o', pid: 'pid-o', source_version: 1 });
        await g.reached;
        expect(await review(x, k, { source_ref: 'rev-o', pid: 'pid-o', source_version: 2, label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('NONE') });
        g.release();
        expect(await p1).toEqual({ changed: false, block_list: B('NONE') });
        expect(await x.cmd(['EXISTS', keys.block(ref('o'))])).toBe(0);
        expect(await x.hash(keys.blockVersion(ref('o')))).toEqual({ [lid('rev-o', 'pid-o', 'SAMPLE_REVIEW')]: '2|NONE' });
        expect(await x.hash(keys.label('rev-o'))).toEqual({ src: 'SAMPLE_REVIEW', who: who('pid-o'), ...entry('rev-o', 'pid-o', 'SAMPLE_REVIEW', { v: 2, l: 'HUMAN', s: 'D', r: 'NONE', d: ref('o') }) });
        expect(x.logLines).toEqual([]);
        expect(labelsOut(x).map((o) => o.value.category)).toEqual(['LABELED_HUMAN']);
      } finally {
        g.release();
        await x.close();
      }
    });

    test('B-T27⑦_옛판(사람)이늦게와도새판(봇)이올린키를지우지못한다', async () => {
      const { g, wrap } = gate('block', '1');
      const x = await labelWorld(valkey.url, { wrap });
      try {
        await reset(x);
        const k = await challengeByHuman(x, 'pid-p', 'p');
        const p1 = review(x, k, { source_ref: 'rev-p', pid: 'pid-p', source_version: 1, label: 'LABEL_HUMAN' });
        await g.reached;
        expect(await review(x, k, { source_ref: 'rev-p', pid: 'pid-p', source_version: 2 })).toEqual({ changed: true, block_list: B('ADDED') });
        g.release();
        expect(await p1).toEqual({ changed: false, block_list: B('ADDED') });
        expect(await blockValue(x, 'p')).toMatchObject({ caseId: 'rev-p' });
        expect(await x.hash(keys.blockVersion(ref('p')))).toEqual({ [lid('rev-p', 'pid-p', 'SAMPLE_REVIEW')]: '2|ADDED' });
        expect(await x.hash(keys.label('rev-p'))).toEqual({ src: 'SAMPLE_REVIEW', who: who('pid-p'), ...entry('rev-p', 'pid-p', 'SAMPLE_REVIEW', { v: 2, l: 'BOT', s: 'D', r: 'ADDED', d: ref('p') }) });
      } finally {
        g.release();
        await x.close();
      }
    });

    test('B-T27⑦_옛판의끝남이새판뒤에오면적지않는다_마지막상태는큰판의결과다', async () => {
      // 판 1이 차단 키를 올린 뒤 '끝남' 앞에서 멈춘 사이 판 2가 지우고 끝난다
      const { g, wrap } = gate('finish', '1');
      const x = await labelWorld(valkey.url, { wrap });
      try {
        await reset(x);
        const k = await challengeByHuman(x, 'pid-q', 'q');
        const p1 = review(x, k, { source_ref: 'rev-q', pid: 'pid-q', source_version: 1 });
        await g.reached;
        expect(await x.cmd(['EXISTS', keys.block(ref('q'))])).toBe(1);
        expect(await review(x, k, { source_ref: 'rev-q', pid: 'pid-q', source_version: 2, label: 'LABEL_HUMAN' })).toEqual({ changed: true, block_list: B('REMOVED') });
        g.release();
        expect(await p1).toEqual({ changed: false, block_list: B('ADDED') });
        expect(await x.cmd(['EXISTS', keys.block(ref('q'))])).toBe(0);
        expect(await x.hash(keys.label('rev-q'))).toEqual({ src: 'SAMPLE_REVIEW', who: who('pid-q'), ...entry('rev-q', 'pid-q', 'SAMPLE_REVIEW', { v: 2, l: 'HUMAN', s: 'D', r: 'REMOVED', d: ref('q') }) });
        expect(await x.hash(keys.blockVersion(ref('q')))).toEqual({ [lid('rev-q', 'pid-q', 'SAMPLE_REVIEW')]: '2|REMOVED' });
        expect(labelsOut(x).map((o) => o.value.category)).toEqual(['LABELED_HUMAN']);
      } finally {
        g.release();
        await x.close();
      }
    });
  });
});

describe('Q-T48 차단 기기 키와 이의 인정', () => {
  beforeAll(() => reset(w));

  test('Q-T48①③④_차단기기셋은사전검증에서모두확정신호이고_하나를이의인정하면다음회차에신호가없으며_남은두키의수명은90일이다', async () => {
    // 악성 봇으로 확정한 기기 셋을 올린다(표본 검토 BOT)
    for (const i of [0, 1, 2]) {
      const k = await challengeByHuman(w, `pid-q${i}`, `q${i}`, 'ev-q1');
      expect(await review(w, k, { source_ref: `rev-q${i}`, pid: `pid-q${i}`, event_id: 'ev-q1' })).toEqual({ changed: true, block_list: B('ADDED') });
    }
    const seen = seenOf(w);
    seen.length = 0;
    // ① 그 기기로 사전 검증을 받는다: 셋 모두 차단 목록 신호
    for (const i of [0, 1, 2]) await challengeByBlock(w, `pid-q${i}`, `q${i}`, 'ev-q2');
    expect(seen.filter((s) => s === 'hard:BLOCK_LIST')).toHaveLength(3);
    for (const i of [0, 1, 2]) expect(await evidenceOf(w, `pid-q${i}`, 'ev-q2')).toMatchObject({ hardSignal: 'BLOCK_LIST', deviceRef: ref(`q${i}`), reason: 'DEVICE_HISTORY' });
    // ② 하나의 격리에 CS가 이의를 인정한다
    expect(await appeal(w, { source_ref: 'appeal-q0', pid: 'pid-q0', event_id: 'ev-q2' })).toEqual({ changed: true, block_list: B('REMOVED') });
    // ③ 인정한 기기로 다음 회차에 다시 사전 검증: 차단 목록 신호가 없다
    seen.length = 0;
    expect(await w.scoreRisk({ pid: 'pid-q0', device_id: dev('q0'), event_id: 'ev-q3' })).toMatchObject({ verdict: 'VERDICT_ALLOW' });
    expect(seen.filter((s) => s.startsWith('hard:'))).toEqual([]);
    // ④ 남은 두 키는 등재 뒤 90일 [가정]에 사라진다(수명을 본다)
    expect(await w.keysLike('tr:block:*')).toEqual([keys.block(ref('q1')), keys.block(ref('q2'))].sort());
    for (const i of [1, 2]) expect90Days(await w.pttl(keys.block(ref(`q${i}`))));
  });

  test('Q-T48⑤_목록에없는기기1만개로사전검증을받으면차단목록신호가붙은기기가0개다', async () => {
    const seen = seenOf(w);
    seen.length = 0;
    const N = 10_000;
    const BATCH = 200;
    const reasons = new Map<string, number>();
    for (let start = 0; start < N; start += BATCH) {
      const batch = Array.from({ length: Math.min(BATCH, N - start) }, (_, j) => start + j);
      const out = await Promise.all(
        batch.map((n) =>
          w.score.run({
            context: 'PREVERIFY',
            eventId: 'ev-q4',
            pid: `pid-n${n}`,
            accountId: '',
            humanCheckToken: 'tok',
            deviceId: dev(`n${String(n).padStart(5, '0')}`),
            client: { ip: '198.51.100.7', userAgent: 'UA', clientHints: {}, asn: 64512 },
            shuffle: 'OFF',
            journeyId: '0190f3a1-7c2e-7a00-8000-0000000000aa',
            deadlineAtMs: Date.now() + 5_000,
          }),
        ),
      );
      for (const r of out) reasons.set(r.reason ?? 'NONE', (reasons.get(r.reason ?? 'NONE') ?? 0) + 1);
      await w.settle();
    }
    expect(seen.filter((s) => s === 'hard:BLOCK_LIST')).toEqual([]);
    expect(seen.filter((s) => s.startsWith('verdict:PREVERIFY:'))).toHaveLength(N);
    expect(reasons.get('DEVICE_HISTORY') ?? 0).toBe(0);
    // 목록에는 Q-T48④의 두 키뿐이다
    expect(await w.keysLike('tr:block:*')).toEqual([keys.block(ref('q1')), keys.block(ref('q2'))].sort());
  }, 180_000);
});

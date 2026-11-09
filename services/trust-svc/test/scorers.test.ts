// 점수기 여섯의 순수 함수(docs/features/bot-defense.md §4.2). 기준값은 합성 값이다(POL-006).
import { describe, expect, test } from 'vitest';
import { SCORER_LIST, type ScorerInput } from '../src/modules/scoring/domain/scorers.js';
import { SYNTHETIC_RULES } from './support.js';

const params = SYNTHETIC_RULES.params;
const NOW = Date.UTC(2026, 10, 9);
const base: ScorerInput = {
  now: NOW,
  human: 'PASSED',
  device: { state: 'READ', accounts: 1, shared: undefined, history: { sent: 0, passed: 0, failed: 0 } },
  behavior: undefined,
  network: { netClass: 'OTHER', entries10s: undefined },
  firstVisitAtMs: undefined,
  sessionCreatedAtMs: undefined,
  client: { ip: '', userAgent: '', clientHints: {}, asn: 64512 },
};
const run = (name: string, o: Partial<ScorerInput>) => SCORER_LIST.find((s) => s.name === name)!.score({ ...base, ...o }, params);

describe('HumanCheck', () => {
  test('B-T1_통과는0_실패는1_보류는의존성값없음_해당없음은원래없는값이다', () => {
    expect(run('HumanCheck', { human: 'PASSED' })).toMatchObject({ risk: 0 });
    expect(run('HumanCheck', { human: 'FAILED' })).toMatchObject({ risk: 1, reason: 'HUMAN_CHECK' });
    expect(run('HumanCheck', { human: 'PENDING' })).toMatchObject({ risk: null, missing: 'dependency' });
    expect(run('HumanCheck', { human: 'ABSENT' })).toMatchObject({ risk: null, missing: 'absent' });
  });
});

describe('DeviceTrust', () => {
  test('기기신호가없으면원래없는값이고_저장소오류면의존성값없음이다', () => {
    expect(run('DeviceTrust', { device: { state: 'NONE' } })).toMatchObject({ risk: null, missing: 'absent' });
    expect(run('DeviceTrust', { device: { state: 'FAILED' } })).toMatchObject({ risk: null, missing: 'dependency' });
  });

  test('계정수가많을수록_검증실패가많을수록위험이크고_세신호가운데큰값을낸다', () => {
    expect(run('DeviceTrust', { device: { state: 'READ', accounts: 1, shared: undefined, history: { sent: 0, passed: 0, failed: 0 } } })).toMatchObject({ risk: 0, reason: 'DEVICE_HISTORY' });
    expect(run('DeviceTrust', { device: { state: 'READ', accounts: 2, shared: undefined, history: { sent: 0, passed: 0, failed: 0 } } })).toMatchObject({ risk: 0.5 });
    expect(run('DeviceTrust', { device: { state: 'READ', accounts: 1, shared: undefined, history: { sent: 2, passed: 0, failed: 2 } } })).toMatchObject({ risk: 1 });
    expect(run('DeviceTrust', { device: { state: 'READ', accounts: 1, shared: 3, history: { sent: 0, passed: 0, failed: 0 } } })).toMatchObject({ risk: 1 });
  });
});

describe('BehaviorScore', () => {
  const b = { v: 1, windowMs: 2000, pointerMoves: 10, pointerEntropy: 0, inputIntervalMeanMs: 100, inputIntervalStdMs: 200, scrollEvents: 0, scrollDistancePx: 0 };
  test('낮음10_포인터이동수가최소표본수보다적으면포인터신호를쓰지않는다', () => {
    expect(run('BehaviorScore', { behavior: { ...b, pointerMoves: 3, pointerEntropy: 0.05, inputIntervalMeanMs: undefined, inputIntervalStdMs: undefined } })).toMatchObject({ risk: null, missing: 'absent' });
  });
  test('낮음10_창이최소보다짧으면입력간격신호를쓰지않는다', () => {
    expect(run('BehaviorScore', { behavior: { ...b, windowMs: 500, pointerMoves: undefined, pointerEntropy: undefined, inputIntervalStdMs: 1 } })).toMatchObject({ risk: null, missing: 'absent' });
  });
  test('요약이없으면값없음이고_입력이없는요약도값없음이다', () => {
    expect(run('BehaviorScore', {})).toMatchObject({ risk: null, missing: 'absent' });
    expect(run('BehaviorScore', { behavior: { v: 1, windowMs: 1000, pointerMoves: 0, scrollEvents: 0, scrollDistancePx: 0 } })).toMatchObject({ risk: null, missing: 'absent' });
  });

  test('포인터엔트로피가낮으면위험하고_입력간격이고르면위험하다', () => {
    expect(run('BehaviorScore', { behavior: { ...b, pointerEntropy: 3, inputIntervalStdMs: 300 } })).toMatchObject({ risk: 0, reason: 'INTERACTION' });
    expect(run('BehaviorScore', { behavior: { ...b, pointerEntropy: 0.05, inputIntervalStdMs: 300 } })).toMatchObject({ risk: 1 });
    expect(run('BehaviorScore', { behavior: { ...b, pointerEntropy: 3, inputIntervalStdMs: 1 } })).toMatchObject({ risk: 1 });
  });
});

describe('NetworkScore', () => {
  test('낮음11_ASN이0이면값없음이다', () => {
    expect(run('NetworkScore', { client: { ip: '', userAgent: '', clientHints: {}, asn: 0 } })).toMatchObject({ risk: null, missing: 'absent' });
  });

  test('호스팅·프록시는설정값_그밖과ASN없음은0이다', () => {
    expect(run('NetworkScore', { network: { netClass: 'HOSTING', entries10s: undefined } })).toMatchObject({ risk: 1, reason: 'NETWORK' });
    expect(run('NetworkScore', { network: { netClass: 'PROXY', entries10s: undefined } })).toMatchObject({ risk: 0.8 });
    expect(run('NetworkScore', { network: { netClass: 'OTHER', entries10s: undefined } })).toMatchObject({ risk: 0 });
  });

  test('호스팅대역진입수가몰리면사유는짧은시간많은요청이다', () => {
    expect(run('NetworkScore', { network: { netClass: 'PROXY', entries10s: 3 } })).toMatchObject({ risk: 1, reason: 'RAPID_REQUESTS' });
  });
});

describe('AgeScore', () => {
  test('[Q-T39] 쿠키없음은값없음이라0으로더해지고_갓받은쿠키만위험이다(소유자결정전의동작을고정한다,ADR-0249남는한계)', () => {
    const noCookie = run('AgeScore', {});
    const young = run('AgeScore', { firstVisitAtMs: NOW - 1 });
    expect(noCookie).toMatchObject({ risk: null, missing: 'absent' });
    expect(young).toMatchObject({ risk: 1 });
  });

  test('쿠키·세션이없으면값없음이고_젊을수록위험이크다', () => {
    expect(run('AgeScore', {})).toMatchObject({ risk: null, missing: 'absent' });
    expect(run('AgeScore', { firstVisitAtMs: NOW - 500 })).toMatchObject({ risk: 1, reason: 'DEVICE_HISTORY' });
    expect(run('AgeScore', { firstVisitAtMs: NOW - 5_000 })).toMatchObject({ risk: 0 });
    expect(run('AgeScore', { firstVisitAtMs: NOW - 5_000, sessionCreatedAtMs: NOW - 1_500 })).toMatchObject({ risk: 0.5 });
  });
});

describe('ConsistencyScore', () => {
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0';
  test('Client Hints가없으면값없음이다', () => {
    expect(run('ConsistencyScore', { client: { ip: '', userAgent: windows, clientHints: {}, asn: 0 } })).toMatchObject({ risk: null, missing: 'absent' });
  });

  test('UA와Client Hints의운영체제가맞으면0_다르면설정값이고사유는화면조작모양이다', () => {
    expect(run('ConsistencyScore', { client: { ip: '', userAgent: windows, clientHints: { 'sec-ch-ua-platform': '"Windows"' }, asn: 0 } })).toMatchObject({ risk: 0 });
    expect(run('ConsistencyScore', { client: { ip: '', userAgent: windows, clientHints: { 'sec-ch-ua-platform': '"Android"', 'sec-ch-ua-mobile': '?1' }, asn: 0 } })).toMatchObject({ risk: 1, reason: 'INTERACTION' });
  });
});

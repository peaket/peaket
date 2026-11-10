// 회차 일정 사본(q:{event:E}:cfg)의 판매 자격 칸 모양과 창 고르기(ADR-0265 결정 1·6, Q-T36 ①).
import { expect, test } from 'vitest';
import { type EventSchedule, candidateEligibilityLists, eligibilityAt, parseEligibility } from '../src/modules/entry/domain/queue.js';

const base = (): EventSchedule => ({ opensAtMs: 1_000, startsAtMs: 100_000, lobbyShuffle: true, openBatch: false });
const gate = (fromMs: number, toMs: number, lists: string[]) => ({ fromMs, toMs, lists });

test('Q-T36 ① eligGates·eligLists가 없으면 창이 없고, 모양이 맞으면 창과 후보 명단을 읽는다', () => {
  expect(parseEligibility(undefined, undefined)).toEqual({ kind: 'NONE' });
  const e = parseEligibility(JSON.stringify([gate(10, 20, ['fan-a'])]), JSON.stringify(['fan-b']));
  expect(e).toEqual({ kind: 'GATED', gates: [gate(10, 20, ['fan-a'])], lists: ['fan-b'] });
  expect(candidateEligibilityLists({ ...base(), eligibility: e })).toEqual(['fan-a', 'fan-b']);
});

test('Q-T36 ① 창 경계는 fromMs 이상 toMs 미만이고 겹친 창은 명단 키를 합친다', () => {
  const s: EventSchedule = { ...base(), eligibility: { kind: 'GATED', gates: [gate(10, 20, ['fan-a']), gate(15, 30, ['fan-b'])], lists: [] } };
  expect(eligibilityAt(s, 9)).toEqual({ kind: 'NONE' });
  expect(eligibilityAt(s, 10)).toEqual({ kind: 'GATED', gates: [gate(10, 20, ['fan-a'])], lists: ['fan-a'] });
  // 두 창에 걸치면 합친다(글자 차례)
  expect(eligibilityAt(s, 15)).toEqual({ kind: 'GATED', gates: [gate(10, 20, ['fan-a']), gate(15, 30, ['fan-b'])], lists: ['fan-a', 'fan-b'] });
  // toMs 경계는 창 밖이다
  expect(eligibilityAt(s, 20)).toEqual({ kind: 'GATED', gates: [gate(15, 30, ['fan-b'])], lists: ['fan-b'] });
  expect(eligibilityAt(s, 30)).toEqual({ kind: 'NONE' });
});

test('Q-T36 ① eligGates·eligLists의 모양이 틀리면 INVALID이고 후보 명단도 없다 [ASVS v5.0.0-16.5.2]', () => {
  const bad: [string, string | undefined][] = [
    ['{', undefined],
    ['{}', undefined],
    [JSON.stringify([{ fromMs: 1, toMs: 2 }]), undefined],
    [JSON.stringify([{ fromMs: 1, toMs: 2, lists: [], extra: 1 }]), undefined],
    [JSON.stringify([{ fromMs: 2, toMs: 2, lists: [] }]), undefined],
    [JSON.stringify([{ fromMs: -1, toMs: 2, lists: [] }]), undefined],
    [JSON.stringify([{ fromMs: 1.5, toMs: 2, lists: [] }]), undefined],
    [JSON.stringify([gate(1, 2, ['a'])]), undefined],
    [JSON.stringify([gate(1, 2, ['fan-a', 'fan-a'])]), undefined],
    [JSON.stringify(Array.from({ length: 11 }, (_, i) => gate(i, i + 1, [`fan-${i}`]))), undefined],
    [JSON.stringify([gate(1, 2, ['fan-a'])]), JSON.stringify(['fan-b', 'fan-c', 'fan-d', 'fan-e', 'fan-f', 'fan-g', 'fan-h', 'fan-i', 'fan-j', 'fan-k'])],
  ];
  for (const [gates, lists] of bad) {
    const e = parseEligibility(gates, lists);
    expect(e, `${gates} / ${lists}`).toEqual({ kind: 'INVALID' });
    expect(candidateEligibilityLists({ ...base(), eligibility: e })).toBeUndefined();
  }
  // 합쳐 10개까지는 받는다
  expect(parseEligibility(JSON.stringify([gate(1, 2, ['fan-a'])]), JSON.stringify(Array.from({ length: 9 }, (_, i) => `fan-${i}`)))).toMatchObject({ kind: 'GATED' });
});

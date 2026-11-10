// 판매 정책 규칙 문법 1판의 읽기·평가 함수 시험(S-T39, docs/features/seat-hold.md §4 '판매 정책 규칙의 한도', ADR-0261 결정 3, docs/design/d5 §6.7).
// 공개 함수 넷(parseSalePolicy·evaluateSalePolicy·entryGate·salePhases)으로만 본다. 단언 값은 정본의 글로 적는다(코드 상수를 가져오지 않는다):
// 창은 from 포함·to 제외, 거부가 한도보다 앞서고 한도끼리는 작은 값, 조건 10·깊이 3·규칙 8KB·공연당 20개 [가정],
// POL-032 상한(관람일 10일 전까지 0%, 7~9일 10%, 3~6일 20%, 1~2일 30%, 당일 90%).
import { describe, expect, it } from 'vitest';
import { entryGate, evaluateSalePolicy, parseSalePolicy, type SalePolicyRule, SalePolicyShapeError, salePhases } from '../src/sale-policy/index';
import { UnsafeKeyError } from '../src/safe-json';

// 회차 둘(1인 한도 4·3, 정본 기본 4와 다른 회차 하나)과 등급 둘
const R1 = '0195a1b2-0000-7000-8000-000000000001';
const R2 = '0195a1b2-0000-7000-8000-000000000002';
const OTHER_PRODUCTION_ROUND = '0195a1b2-0000-7000-8000-0000000000ff';
const CTX = { rounds: [{ eventId: R1, perPersonLimit: 4 }, { eventId: R2, perPersonLimit: 3 }], grades: ['VIP', 'R'] };
const KEY = 'lumen-fanclub-2026';

/** d5 §6.7의 선예매 예시 규칙(창 2026-10-13T20:00:00+09:00~22:00, 명단 lumen-fanclub-2026, 1인 2매) */
const FANCLUB: SalePolicyRule = {
  version: 1,
  name: '팬클럽 선예매',
  rounds: 'ALL',
  during: { from: '2026-10-13T20:00:00+09:00', to: '2026-10-13T22:00:00+09:00' },
  rule: { if: { fact: 'buyer.lists', has: KEY }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } },
};
const FROM = Date.parse('2026-10-13T20:00:00+09:00');
const TO = Date.parse('2026-10-13T22:00:00+09:00');
const IN = new Date(FROM + 30 * 60_000);

const plain = (name: string, then: NonNullable<SalePolicyRule['rule']>['then'], extra: Partial<SalePolicyRule> = {}): SalePolicyRule => ({ version: 1, name, rounds: 'ALL', rule: { then }, ...extra });
const when = (cond: unknown): SalePolicyRule => ({ version: 1, name: '조건', rounds: 'ALL', rule: { if: cond as never, then: { limitPerPerson: 1 }, else: { limitPerPerson: 2 } } });
const facts = (o: Partial<Parameters<typeof evaluateSalePolicy>[1]> = {}) => ({ at: IN, round: R1, grade: 'VIP', quantity: 1, lists: [] as string[], ...o });

const ok = (input: unknown) => {
  const r = parseSalePolicy(input, CTX);
  if (!r.ok) throw new Error(`저장 검사 실패: ${JSON.stringify(r.errors)}`);
  return r.rules;
};
const codes = (input: unknown) => {
  const r = parseSalePolicy(input, CTX);
  return r.ok ? [] : r.errors.map((e) => e.code);
};

describe('S-T39 판매 정책 평가와 1인 한도 합치기', () => {
  it('S-T39 ① 같은 시각·회차·등급에 걸린 두 규칙은 거부가 한도보다 앞서고 한도끼리는 작은 값이며 allow는 한도를 바꾸지 않고, 걸린 규칙이 없으면 회차 한도다 [ASVS v5.0.0-2.2.3]', () => {
    const limit2 = plain('한도 2', { limitPerPerson: 2 });
    const limit3 = plain('한도 3', { limitPerPerson: 3 });
    const deny = plain('등급 막기', { deny: 'GRADE_NOT_ON_SALE' });
    const allow = plain('허용', { allow: true });
    // 한도 2와 거부: 차례와 상관없이 거부
    expect(evaluateSalePolicy([limit2, deny], facts(), 4)).toEqual({ allowed: false, reason: 'GRADE_NOT_ON_SALE' });
    expect(evaluateSalePolicy([deny, limit2], facts(), 4)).toEqual({ allowed: false, reason: 'GRADE_NOT_ON_SALE' });
    // 거부가 둘이면 사유는 규칙 차례로 먼저 거부한 것
    expect(evaluateSalePolicy([plain('선예매', { deny: 'PRESALE_ONLY' }), deny], facts(), 4)).toEqual({ allowed: false, reason: 'PRESALE_ONLY' });
    // 한도 2와 한도 3: 차례와 상관없이 2
    expect(evaluateSalePolicy([limit2, limit3], facts(), 4)).toEqual({ allowed: true, limit: 2 });
    expect(evaluateSalePolicy([limit3, limit2], facts(), 4)).toEqual({ allowed: true, limit: 2 });
    // 한도 2와 allow: 2(allow가 회차 한도로 되돌리지 않는다)
    expect(evaluateSalePolicy([limit2, allow], facts(), 4)).toEqual({ allowed: true, limit: 2 });
    expect(evaluateSalePolicy([allow, limit2], facts(), 4)).toEqual({ allowed: true, limit: 2 });
    expect(evaluateSalePolicy([allow], facts(), 4)).toEqual({ allowed: true, limit: 4 });
    // 거부와 allow: 차례와 상관없이 거부(allow는 거부를 덮지 않는다, 틀린 구현 검사 BAT-157)
    expect(evaluateSalePolicy([deny, allow], facts(), 4)).toEqual({ allowed: false, reason: 'GRADE_NOT_ON_SALE' });
    expect(evaluateSalePolicy([allow, deny], facts(), 4)).toEqual({ allowed: false, reason: 'GRADE_NOT_ON_SALE' });
    // 걸린 규칙이 없으면 회차 1인 한도(4와 3인 회차를 따로 본다)
    expect(evaluateSalePolicy([], facts(), 4)).toEqual({ allowed: true, limit: 4 });
    expect(evaluateSalePolicy([], facts({ round: R2 }), 3)).toEqual({ allowed: true, limit: 3 });
    // 결과 한도는 회차 1인 한도를 넘지 않는다
    expect(evaluateSalePolicy([limit3], facts({ round: R2 }), 2)).toEqual({ allowed: true, limit: 2 });
  });

  it('S-T39 ② 창은 from − 1ms·to에는 적용되지 않고 from·to − 1ms에는 적용되며, rounds에 없는 회차에는 적용되지 않는다', () => {
    const at = (ms: number) => facts({ at: new Date(ms) });
    // 명단 없는 사람: 창 안이면 거부, 밖이면 회차 한도
    expect(evaluateSalePolicy([FANCLUB], at(FROM - 1), 4)).toEqual({ allowed: true, limit: 4 });
    expect(evaluateSalePolicy([FANCLUB], at(FROM), 4)).toEqual({ allowed: false, reason: 'PRESALE_ONLY' });
    expect(evaluateSalePolicy([FANCLUB], at(TO - 1), 4)).toEqual({ allowed: false, reason: 'PRESALE_ONLY' });
    expect(evaluateSalePolicy([FANCLUB], at(TO), 4)).toEqual({ allowed: true, limit: 4 });
    // 명단 있는 사람: 창 안이면 2
    expect(evaluateSalePolicy([FANCLUB], facts({ at: new Date(FROM), lists: [KEY] }), 4)).toEqual({ allowed: true, limit: 2 });
    expect(evaluateSalePolicy([FANCLUB], facts({ at: new Date(TO - 1), lists: [KEY] }), 4)).toEqual({ allowed: true, limit: 2 });
    // to가 없으면 끝이 없다
    const open = { ...FANCLUB, during: { from: FANCLUB.during!.from } };
    expect(evaluateSalePolicy([open], facts({ at: new Date(TO + 86_400_000) }), 4)).toEqual({ allowed: false, reason: 'PRESALE_ONLY' });
    // rounds에 그 회차가 없으면 적용하지 않는다
    const onlyR1 = { ...FANCLUB, rounds: [R1] };
    expect(evaluateSalePolicy([onlyR1], facts({ round: R1 }), 4)).toEqual({ allowed: false, reason: 'PRESALE_ONLY' });
    expect(evaluateSalePolicy([onlyR1], facts({ round: R2 }), 3)).toEqual({ allowed: true, limit: 3 });
  });

  it('S-T39 ③ 사실·연산자마다 참·거짓이 표대로이고 lte·gte는 같은 값에서 참이며 all·any·not을 계산한다', () => {
    // 참이면 then(한도 1), 거짓이면 else(한도 2)
    const truth = (cond: unknown, f: Partial<ReturnType<typeof facts>> = {}) => {
      const r = evaluateSalePolicy([when(cond)], facts(f), 4);
      if (!r.allowed) throw new Error('거부가 나오면 안 된다');
      return r.limit === 1;
    };
    // buyer.lists has
    expect(truth({ fact: 'buyer.lists', has: KEY }, { lists: ['other-list', KEY] })).toBe(true);
    expect(truth({ fact: 'buyer.lists', has: KEY }, { lists: ['other-list'] })).toBe(false);
    // round eq·in
    expect(truth({ fact: 'round', eq: R1 }, { round: R1 })).toBe(true);
    expect(truth({ fact: 'round', eq: R1 }, { round: R2 })).toBe(false);
    expect(truth({ fact: 'round', in: [R2, R1] }, { round: R1 })).toBe(true);
    expect(truth({ fact: 'round', in: [R2] }, { round: R1 })).toBe(false);
    // grade eq·in
    expect(truth({ fact: 'grade', eq: 'VIP' }, { grade: 'VIP' })).toBe(true);
    expect(truth({ fact: 'grade', eq: 'VIP' }, { grade: 'R' })).toBe(false);
    expect(truth({ fact: 'grade', in: ['R', 'VIP'] }, { grade: 'R' })).toBe(true);
    expect(truth({ fact: 'grade', in: ['VIP'] }, { grade: 'R' })).toBe(false);
    // quantity eq·lte·gte(경계 둘)
    expect(truth({ fact: 'quantity', eq: 2 }, { quantity: 2 })).toBe(true);
    expect(truth({ fact: 'quantity', eq: 2 }, { quantity: 3 })).toBe(false);
    expect(truth({ fact: 'quantity', lte: 2 }, { quantity: 2 })).toBe(true);
    expect(truth({ fact: 'quantity', lte: 2 }, { quantity: 3 })).toBe(false);
    expect(truth({ fact: 'quantity', gte: 2 }, { quantity: 2 })).toBe(true);
    expect(truth({ fact: 'quantity', gte: 2 }, { quantity: 1 })).toBe(false);
    // all·any·not
    const vip = { fact: 'grade', eq: 'VIP' };
    const two = { fact: 'quantity', eq: 2 };
    expect(truth({ all: [vip, two] }, { grade: 'VIP', quantity: 2 })).toBe(true);
    expect(truth({ all: [vip, two] }, { grade: 'VIP', quantity: 1 })).toBe(false);
    expect(truth({ any: [vip, two] }, { grade: 'R', quantity: 2 })).toBe(true);
    expect(truth({ any: [vip, two] }, { grade: 'R', quantity: 1 })).toBe(false);
    expect(truth({ not: vip }, { grade: 'R' })).toBe(true);
    expect(truth({ not: vip }, { grade: 'VIP' })).toBe(false);
    expect(truth({ not: { any: [vip, { not: two }] } }, { grade: 'R', quantity: 2 })).toBe(true);
    // else가 없으면 조건이 거짓일 때 그 규칙은 적용되지 않는다(회차 한도)
    const noElse: SalePolicyRule = { version: 1, name: '조건만', rounds: 'ALL', rule: { if: vip as never, then: { limitPerPerson: 1 } } };
    expect(evaluateSalePolicy([noElse], facts({ grade: 'R' }), 4)).toEqual({ allowed: true, limit: 4 });
    expect(evaluateSalePolicy([noElse], facts({ grade: 'VIP' }), 4)).toEqual({ allowed: true, limit: 1 });
  });

  it('S-T39 ④ 진입 판정은 창 안 명단 없음만 PRESALE_ONLY로 들이지 않고, 등급·매수 조건만으로 거부하는 규칙은 진입을 막지 않는다', () => {
    const gate = (rules: SalePolicyRule[], at: number, lists: string[] = []) => entryGate(rules, { at: new Date(at), round: R1, lists });
    expect(gate([FANCLUB], FROM, [])).toEqual({ allowed: false, reason: 'PRESALE_ONLY' });
    expect(gate([FANCLUB], TO - 1, [])).toEqual({ allowed: false, reason: 'PRESALE_ONLY' });
    expect(gate([FANCLUB], FROM, [KEY])).toEqual({ allowed: true });
    expect(gate([FANCLUB], FROM - 1, [])).toEqual({ allowed: true });
    expect(gate([FANCLUB], TO, [])).toEqual({ allowed: true });
    // 등급·매수 조건만으로 거부하는 규칙(모름이 then·else를 둘 다 낼 수 있다)
    const vipOff: SalePolicyRule = { version: 1, name: 'VIP 판매 안 함', rounds: 'ALL', rule: { if: { fact: 'grade', eq: 'VIP' }, then: { deny: 'GRADE_NOT_ON_SALE' } } };
    const bulk: SalePolicyRule = { version: 1, name: '3매 이상 거부', rounds: 'ALL', rule: { if: { fact: 'quantity', gte: 3 }, then: { deny: 'PRESALE_ONLY' }, else: { limitPerPerson: 2 } } };
    expect(gate([vipOff], FROM)).toEqual({ allowed: true });
    expect(gate([bulk], FROM)).toEqual({ allowed: true });
    expect(gate([vipOff, bulk], FROM)).toEqual({ allowed: true });
    // 셋값 논리: all(거짓, 모름)은 거짓이라 else 거부, all(참, 모름)은 모름이라 들인다, any(거짓, 모름)·not(모름)은 모름
    const both: SalePolicyRule = { version: 1, name: '명단과 등급', rounds: 'ALL', rule: { if: { all: [{ fact: 'buyer.lists', has: KEY }, { fact: 'grade', eq: 'VIP' }] }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } } };
    expect(gate([both], FROM, [])).toEqual({ allowed: false, reason: 'PRESALE_ONLY' });
    expect(gate([both], FROM, [KEY])).toEqual({ allowed: true });
    const either: SalePolicyRule = { ...both, rule: { ...both.rule!, if: { any: [{ fact: 'buyer.lists', has: KEY }, { fact: 'grade', eq: 'VIP' }] } } };
    expect(gate([either], FROM, [])).toEqual({ allowed: true });
    const notGrade: SalePolicyRule = { ...both, rule: { ...both.rule!, if: { not: { fact: 'grade', eq: 'VIP' } } } };
    expect(gate([notGrade], FROM, [])).toEqual({ allowed: true });
    // 조건 없이 거부하는 규칙은 진입도 막는다
    expect(gate([plain('판매 안 함', { deny: 'GRADE_NOT_ON_SALE' })], FROM)).toEqual({ allowed: false, reason: 'GRADE_NOT_ON_SALE' });
    // 회차·명단 조건은 진입 때 안다
    const roundOnly: SalePolicyRule = { version: 1, name: '회차', rounds: 'ALL', rule: { if: { fact: 'round', eq: R1 }, then: { deny: 'PRESALE_ONLY' } } };
    expect(entryGate([roundOnly], { at: new Date(FROM), round: R1, lists: [] })).toEqual({ allowed: false, reason: 'PRESALE_ONLY' });
    expect(entryGate([roundOnly], { at: new Date(FROM), round: R2, lists: [] })).toEqual({ allowed: true });
  });

  it('S-T39 ⑤ 오픈 20:00 회차는 PRESALE(20:00~22:00, 2) 뒤 GENERAL(22:00~판매 종료, 회차 한도)이고 19:00 회차는 그 앞에 GENERAL(19:00~20:00)이 하나 더 있다', () => {
    const saleEndsAt = new Date('2026-10-24T10:00:00Z');
    const iso = (d: Date) => d.toISOString();
    const view = (ps: ReturnType<typeof salePhases>) => ps.map((p) => ({ kind: p.kind, startsAt: iso(p.startsAt), endsAt: iso(p.endsAt), limitPerPerson: p.limitPerPerson, lists: p.lists }));
    const at20 = salePhases([FANCLUB], R1, { openAt: new Date(FROM), saleEndsAt, perPersonLimit: 4 });
    expect(view(at20)).toEqual([
      { kind: 'PRESALE', startsAt: '2026-10-13T11:00:00.000Z', endsAt: '2026-10-13T13:00:00.000Z', limitPerPerson: 2, lists: [KEY] },
      { kind: 'GENERAL', startsAt: '2026-10-13T13:00:00.000Z', endsAt: '2026-10-24T10:00:00.000Z', limitPerPerson: 4, lists: [] },
    ]);
    const at19 = salePhases([FANCLUB], R2, { openAt: new Date(FROM - 3_600_000), saleEndsAt, perPersonLimit: 3 });
    expect(view(at19)).toEqual([
      { kind: 'GENERAL', startsAt: '2026-10-13T10:00:00.000Z', endsAt: '2026-10-13T11:00:00.000Z', limitPerPerson: 3, lists: [] },
      { kind: 'PRESALE', startsAt: '2026-10-13T11:00:00.000Z', endsAt: '2026-10-13T13:00:00.000Z', limitPerPerson: 2, lists: [KEY] },
      { kind: 'GENERAL', startsAt: '2026-10-13T13:00:00.000Z', endsAt: '2026-10-24T10:00:00.000Z', limitPerPerson: 3, lists: [] },
    ]);
    // 다른 규칙의 창 경계(21:00·23:00)가 조각을 잘라도 이웃한 같은 종류 조각은 합친다
    const vipLate: SalePolicyRule = { version: 1, name: 'VIP 늦게', rounds: 'ALL', during: { from: '2026-10-13T21:00:00+09:00', to: '2026-10-13T23:00:00+09:00' }, rule: { if: { fact: 'grade', eq: 'VIP' }, then: { deny: 'GRADE_NOT_ON_SALE' } } };
    expect(view(salePhases([FANCLUB, vipLate], R1, { openAt: new Date(FROM), saleEndsAt, perPersonLimit: 4 }))).toEqual(view(at20));
    // 규칙이 없으면 GENERAL 하나, 회차가 rounds에 없으면 그 규칙은 보지 않는다
    expect(view(salePhases([], R1, { openAt: new Date(FROM), saleEndsAt, perPersonLimit: 4 }))).toEqual([{ kind: 'GENERAL', startsAt: '2026-10-13T11:00:00.000Z', endsAt: '2026-10-24T10:00:00.000Z', limitPerPerson: 4, lists: [] }]);
    expect(view(salePhases([{ ...FANCLUB, rounds: [R1] }], R2, { openAt: new Date(FROM), saleEndsAt, perPersonLimit: 3 }))).toHaveLength(1);
    // 일반 단계의 한도도 나올 수 있는 한도 가운데 가장 작은 값이다(매수 조건의 else 한도 2)
    const bulk: SalePolicyRule = { version: 1, name: '3매 이상 거부', rounds: 'ALL', rule: { if: { fact: 'quantity', gte: 3 }, then: { deny: 'PRESALE_ONLY' }, else: { limitPerPerson: 2 } } };
    expect(view(salePhases([bulk], R1, { openAt: new Date(FROM), saleEndsAt, perPersonLimit: 4 }))[0]).toMatchObject({ kind: 'GENERAL', limitPerPerson: 2 });
  });

  it('S-T39 ⑥ 회차 한도 3인 회차에 limitPerPerson 4, POL-032 7~9일 구간에 20%, 겹치는 공제율 구간, 다른 공연의 회차 ID는 넷 다 거절된다 [ASVS v5.0.0-2.1.2] [ASVS v5.0.0-2.2.3]', () => {
    const r = parseSalePolicy(
      [
        { version: 1, name: '한도', rounds: [R2], rule: { then: { limitPerPerson: 4 } } },
        { version: 1, name: '공제 상한', rounds: [R1], refundFee: [{ daysLeft: { gte: 7, lte: 9 }, rate: 20 }] },
        { version: 1, name: '겹침', rounds: [R2], refundFee: [{ daysLeft: { gte: 3, lte: 6 }, rate: 20 }, { daysLeft: { gte: 6, lte: 9 }, rate: 10 }] },
        { version: 1, name: '남의 회차', rounds: [OTHER_PRODUCTION_ROUND], rule: { then: { limitPerPerson: 1 } } },
      ],
      CTX,
    );
    expect(r).toEqual({
      ok: false,
      errors: [
        { rule: 0, path: '/rule/then/limitPerPerson', code: 'LIMIT_ABOVE_EVENT' },
        { rule: 1, path: '/refundFee/0/rate', code: 'REFUND_RATE_ABOVE_CAP' },
        { rule: 2, path: '/refundFee/1/daysLeft', code: 'REFUND_BAND_OVERLAP' },
        { rule: 3, path: '/rounds/0', code: 'UNKNOWN_ROUND' },
      ],
    });
    // 경계: 한도 3인 회차에 3, 7~9일 10%, 맞닿지 않은 구간(3~6·7~9)은 받는다
    expect(
      ok([
        { version: 1, name: '한도', rounds: [R2], rule: { then: { limitPerPerson: 3 } } },
        { version: 1, name: '공제', rounds: 'ALL', refundFee: [{ daysLeft: { gte: 3, lte: 6 }, rate: 20 }, { daysLeft: { gte: 7, lte: 9 }, rate: 10 }] },
      ]),
    ).toHaveLength(2);
    // ALL 규칙은 걸리는 회차 한도 가운데 가장 작은 값(3) 이하여야 한다
    expect(codes([{ version: 1, name: '전체', rounds: 'ALL', rule: { then: { limitPerPerson: 4 } } }])).toEqual(['LIMIT_ABOVE_EVENT']);
    // POL-032 상한: 10일 전까지 0%, 당일 90%, 1~2일 30%, 3~6일 20%
    const band = (gte: number, lte: number, rate: number) => [{ version: 1, name: '공제', rounds: 'ALL', refundFee: [{ daysLeft: { gte, lte }, rate }] }];
    expect(codes(band(10, 10, 1))).toEqual(['REFUND_RATE_ABOVE_CAP']);
    expect(codes(band(10, 365, 0))).toEqual([]);
    expect(codes(band(9, 12, 1))).toEqual(['REFUND_RATE_ABOVE_CAP']);
    expect(codes(band(0, 0, 90))).toEqual([]);
    expect(codes(band(0, 0, 91))).toEqual(['REFUND_RATE_ABOVE_CAP']);
    expect(codes(band(1, 2, 30))).toEqual([]);
    expect(codes(band(1, 3, 30))).toEqual(['REFUND_RATE_ABOVE_CAP']);
    expect(codes(band(3, 6, 21))).toEqual(['REFUND_RATE_ABOVE_CAP']);
    // 같은 회차에 걸리는 다른 규칙의 구간과도 겹치면 안 된다(끝이 맞닿은 구간 9는 겹침)
    expect(
      codes([
        { version: 1, name: 'A', rounds: 'ALL', refundFee: [{ daysLeft: { gte: 7, lte: 9 }, rate: 10 }] },
        { version: 1, name: 'B', rounds: [R1], refundFee: [{ daysLeft: { gte: 9, lte: 12 }, rate: 0 }] },
      ]),
    ).toEqual(['REFUND_BAND_OVERLAP']);
    // 걸리는 회차가 다르면 겹치지 않는다
    expect(
      codes([
        { version: 1, name: 'A', rounds: [R2], refundFee: [{ daysLeft: { gte: 7, lte: 9 }, rate: 10 }] },
        { version: 1, name: 'B', rounds: [R1], refundFee: [{ daysLeft: { gte: 9, lte: 12 }, rate: 0 }] },
      ]),
    ).toEqual([]);
    // 조건 안의 회차 값도 그 공연의 회차여야 한다
    expect(codes([{ version: 1, name: '회차', rounds: 'ALL', rule: { if: { fact: 'round', in: [R1, OTHER_PRODUCTION_ROUND] }, then: { limitPerPerson: 1 } } }])).toEqual(['UNKNOWN_ROUND']);
  });
});

describe('판매 정책 규칙 읽기(저장 검사)', () => {
  it('계약 밖 모양(사실·연산자·깊이 4·잎 11·8KB·규칙 21·명단 키·창·종류·등급)은 코드로 거절한다 [ASVS v5.0.0-2.1.1] [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-2.3.2]', () => {
    const leaf = { fact: 'grade', eq: 'VIP' };
    const rule = (cond: unknown) => [{ version: 1, name: '조건', rounds: 'ALL', rule: { if: cond, then: { limitPerPerson: 1 } } }];
    // 깊이 3까지(all → all → 잎)는 받고 4는 TOO_DEEP
    expect(codes(rule({ all: [{ any: [leaf] }] }))).toEqual([]);
    expect(codes(rule({ not: { not: leaf } }))).toEqual([]);
    expect(codes(rule({ all: [{ any: [{ not: leaf }] }] }))).toEqual(['TOO_DEEP']);
    // 잎 10개까지, 11개는 TOO_MANY_CONDITIONS
    expect(codes(rule({ all: Array.from({ length: 10 }, () => leaf) }))).toEqual([]);
    expect(codes(rule({ all: [{ all: Array.from({ length: 6 }, () => leaf) }, { any: Array.from({ length: 5 }, () => leaf) }] }))).toEqual(['TOO_MANY_CONDITIONS']);
    // 규칙 하나 8KB(직렬화 UTF-8 8,192바이트)
    const sized = (bytes: number) => {
      const base = { version: 1, name: '크기', rounds: 'ALL', rule: { if: { fact: 'grade', in: [''] }, then: { limitPerPerson: 1 } } };
      const pad = bytes - new TextEncoder().encode(JSON.stringify(base)).length;
      return [{ ...base, rule: { ...base.rule, if: { fact: 'grade', in: ['VIP'.padEnd(pad, 'x')] } } }];
    };
    expect(codes(sized(8192))).toEqual(['UNKNOWN_GRADE']);
    expect(codes(sized(8193))).toEqual(['RULE_TOO_LARGE', 'UNKNOWN_GRADE']);
    // 공연당 20개까지
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ version: 1, name: `규칙 ${i}`, rounds: 'ALL', rule: { then: { allow: true } } }));
    expect(codes(many(20))).toEqual([]);
    expect(codes(many(21))).toEqual(['TOO_MANY_RULES']);
    // 사실과 연산자 짝
    expect(codes(rule({ fact: 'buyer.age', eq: 1 }))).toEqual(['UNKNOWN_FACT']);
    expect(codes(rule({ fact: 'buyer.lists', eq: KEY }))).toEqual(['OPERATOR_MISMATCH']);
    expect(codes(rule({ fact: 'quantity', in: ['1'] }))).toEqual(['OPERATOR_MISMATCH']);
    expect(codes(rule({ fact: 'quantity', eq: '2' }))).toEqual(['OPERATOR_MISMATCH']);
    expect(codes(rule({ fact: 'grade', lte: 2 }))).toEqual(['OPERATOR_MISMATCH']);
    expect(codes(rule({ fact: 'grade' }))).toEqual(['OPERATOR_MISMATCH']);
    expect(codes(rule({ fact: 'grade', eq: 'VIP', in: ['R'] }))).toEqual(['OPERATOR_MISMATCH']);
    // 명단 키 모양(영문 소문자·숫자·하이픈 3~32자)
    expect(codes(rule({ fact: 'buyer.lists', has: 'ab' }))).toEqual(['LIST_KEY_INVALID']);
    expect(codes(rule({ fact: 'buyer.lists', has: 'Lumen' }))).toEqual(['LIST_KEY_INVALID']);
    expect(codes(rule({ fact: 'buyer.lists', has: 'a'.repeat(33) }))).toEqual(['LIST_KEY_INVALID']);
    expect(codes(rule({ fact: 'buyer.lists', has: 'a'.repeat(32) }))).toEqual([]);
    // 없는 등급
    expect(codes(rule({ fact: 'grade', in: ['VIP', 'S'] }))).toEqual(['UNKNOWN_GRADE']);
    // 창: to > from, 시간대가 붙은 ISO 8601만
    const windowed = (during: unknown) => [{ version: 1, name: '창', rounds: 'ALL', during, rule: { then: { limitPerPerson: 1 } } }];
    expect(codes(windowed({ from: '2026-10-13T20:00:00+09:00', to: '2026-10-13T20:00:00+09:00' }))).toEqual(['WINDOW_INVALID']);
    expect(codes(windowed({ from: '2026-10-13T20:00:00+09:00', to: '2026-10-13T19:59:59+09:00' }))).toEqual(['WINDOW_INVALID']);
    expect(codes(windowed({ from: '2026-10-13T20:00' }))).toEqual(['WINDOW_INVALID']);
    // 계약(date-time)과 같게 초가 있어야 하고 소수 초 자릿수는 받는다(리뷰 A4)
    expect(codes(windowed({ from: '2026-10-13T20:00+09:00' }))).toEqual(['WINDOW_INVALID']);
    expect(codes(windowed({ from: '2026-10-13T20:00:00.123456+09:00', to: '2026-10-13T20:00:01.1234567+09:00' }))).toEqual([]);
    expect(codes(windowed({ from: '2026-10-13T20:00:00.000Z', to: '2026-10-13T20:00:00.001Z' }))).toEqual([]);
    // 규칙 종류는 rule과 refundFee 가운데 꼭 하나, during은 rule에만
    expect(codes([{ version: 1, name: '둘 다', rounds: 'ALL', rule: { then: { allow: true } }, refundFee: [{ daysLeft: { gte: 10, lte: 20 }, rate: 0 }] }])).toEqual(['RULE_KIND_INVALID']);
    expect(codes([{ version: 1, name: '없음', rounds: 'ALL' }])).toEqual(['RULE_KIND_INVALID']);
    expect(codes([{ version: 1, name: '창 공제', rounds: 'ALL', during: { from: '2026-10-13T20:00:00+09:00' }, refundFee: [{ daysLeft: { gte: 10, lte: 20 }, rate: 0 }] }])).toEqual(['RULE_KIND_INVALID']);
    // 구간 gte > lte는 창 오류
    expect(codes([{ version: 1, name: '거꾸로', rounds: 'ALL', refundFee: [{ daysLeft: { gte: 9, lte: 7 }, rate: 0 }] }])).toEqual(['WINDOW_INVALID']);
    // 오류는 50개까지만 싣는다
    const bad = Array.from({ length: 20 }, () => ({ version: 1, name: '나쁨', rounds: [OTHER_PRODUCTION_ROUND, OTHER_PRODUCTION_ROUND.replace('ff', 'fe'), OTHER_PRODUCTION_ROUND.replace('ff', 'fd')], rule: { then: { limitPerPerson: 9 } } }));
    const r = parseSalePolicy(bad, CTX);
    expect(r.ok ? 0 : r.errors.length).toBe(50);
  });

  it('규칙 본문의 __proto__·constructor·prototype 키와 정의 밖 칸은 거절한다 [ASVS v5.0.0-1.5.2]', () => {
    const text = (inner: string) => `[{"version":1,"name":"x","rounds":"ALL","rule":{"then":{"allow":true}${inner}}}]`;
    for (const key of ['__proto__', 'constructor', 'prototype']) expect(() => parseSalePolicy(text(`,"${key}":{"x":1}`), CTX)).toThrow(UnsafeKeyError);
    // 값으로 받아도(이미 읽은 JSON) 같은 키를 거절한다
    const parsed = JSON.parse(text(',"__proto__":{"polluted":true}'));
    expect(() => parseSalePolicy(parsed, CTX)).toThrow(UnsafeKeyError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // 정의 밖 칸·알 수 없는 연산자·결과 종류는 모양 오류다
    expect(() => parseSalePolicy([{ version: 1, name: 'x', rounds: 'ALL', rule: { then: { allow: true } }, extra: 1 }], CTX)).toThrow(SalePolicyShapeError);
    expect(() => parseSalePolicy([{ version: 1, name: 'x', rounds: 'ALL', rule: { if: { fact: 'grade', ne: 'VIP' }, then: { allow: true } } }], CTX)).toThrow(SalePolicyShapeError);
    expect(() => parseSalePolicy([{ version: 1, name: 'x', rounds: 'ALL', rule: { then: { deny: 'SOLD_OUT' } } }], CTX)).toThrow(SalePolicyShapeError);
    expect(() => parseSalePolicy([{ version: 2, name: 'x', rounds: 'ALL', rule: { then: { allow: true } } }], CTX)).toThrow(SalePolicyShapeError);
    expect(() => parseSalePolicy([{ version: 1, name: 'x'.repeat(41), rounds: 'ALL', rule: { then: { allow: true } } }], CTX)).toThrow(SalePolicyShapeError);
    expect(() => parseSalePolicy('[{"version":1', CTX)).toThrow(SyntaxError);
    // 이름 40자, 글로 받은 규칙은 그대로 읽는다
    expect(ok(`[{"version":1,"name":"${'가'.repeat(40)}","rounds":"ALL","rule":{"then":{"allow":true}}}]`)).toHaveLength(1);
  });
});

describe('리뷰 재현(2026-11-10)', () => {
  const at = (h: string) => `2026-10-13T${h}:00:00+09:00`;
  const presale = (key: string, from: string, to: string): SalePolicyRule => ({ version: 1, name: key, rounds: 'ALL', during: { from: at(from), to: at(to) }, rule: { if: { fact: 'buyer.lists', has: key }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } } });
  const view = (ps: ReturnType<typeof salePhases>) => ps.map((p) => ({ kind: p.kind, startsAt: p.startsAt.toISOString(), endsAt: p.endsAt.toISOString(), limitPerPerson: p.limitPerPerson, lists: p.lists }));

  it('S-T39 ⑤ 이웃한 PRESALE 조각은 명단 키 집합이 다르면 합치지 않는다(팬클럽 20~21시·카드사 21~22시, 리뷰 A2)', () => {
    const out = salePhases([presale('fanclub-a', '20', '21'), presale('card-b', '21', '22')], R1, { openAt: new Date(FROM), saleEndsAt: new Date('2026-10-24T10:00:00Z'), perPersonLimit: 4 });
    expect(view(out)).toEqual([
      { kind: 'PRESALE', startsAt: '2026-10-13T11:00:00.000Z', endsAt: '2026-10-13T12:00:00.000Z', limitPerPerson: 2, lists: ['fanclub-a'] },
      { kind: 'PRESALE', startsAt: '2026-10-13T12:00:00.000Z', endsAt: '2026-10-13T13:00:00.000Z', limitPerPerson: 2, lists: ['card-b'] },
      { kind: 'GENERAL', startsAt: '2026-10-13T13:00:00.000Z', endsAt: '2026-10-24T10:00:00.000Z', limitPerPerson: 4, lists: [] },
    ]);
  });

  it('S-T39 ⑤ 진입 자격 창의 명단은 그 창에서 진입 판정을 지날 수 있는 사람이 가질 수 있는 키 모두다(all[has A, has B]면 둘, 리뷰 A3)', () => {
    const both: SalePolicyRule = { version: 1, name: '둘 다', rounds: 'ALL', during: { from: at('20'), to: at('22') }, rule: { if: { all: [{ fact: 'buyer.lists', has: 'list-a' }, { fact: 'buyer.lists', has: 'list-b' }] }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } } };
    const [first] = salePhases([both], R1, { openAt: new Date(FROM), saleEndsAt: new Date('2026-10-24T10:00:00Z'), perPersonLimit: 4 });
    expect(view([first!])).toEqual([{ kind: 'PRESALE', startsAt: '2026-10-13T11:00:00.000Z', endsAt: '2026-10-13T13:00:00.000Z', limitPerPerson: 2, lists: ['list-a', 'list-b'] }]);
  });

  it('S-T39 ⑥ 한 회차에 걸리는 공제율 구간이 모두 20개를 넘으면 TOO_MANY_REFUND_BANDS다(리뷰 A1)', () => {
    const bands = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ daysLeft: { gte: from + i, lte: from + i }, rate: 0 }));
    const fee = (name: string, rounds: unknown, from: number, n: number) => ({ version: 1, name, rounds, refundFee: bands(from, n) });
    expect(codes([fee('가', 'ALL', 10, 10), fee('나', [R1], 30, 10)])).toEqual([]);
    const r = parseSalePolicy([fee('가', 'ALL', 10, 10), fee('나', [R1], 30, 10), fee('다', [R1], 50, 1)], CTX);
    expect(r).toEqual({ ok: false, errors: [{ rule: 2, path: '/refundFee', code: 'TOO_MANY_REFUND_BANDS' }] });
    // 다른 회차에 걸리면 세지 않는다
    expect(codes([fee('가', 'ALL', 10, 10), fee('나', [R1], 30, 10), fee('다', [R2], 50, 1)])).toEqual([]);
  });

  it('회차 ID는 대소문자를 가리지 않고 소문자로 읽어 평가한다(리뷰 A4)', () => {
    const rules = ok([{ version: 1, name: '회차', rounds: [R1.toUpperCase()], rule: { if: { fact: 'round', in: [R1.toUpperCase()] }, then: { limitPerPerson: 1 } } }]);
    expect(rules[0]!.rounds).toEqual([R1]);
    expect(evaluateSalePolicy(rules, facts({ round: R1 }), 4)).toEqual({ allowed: true, limit: 1 });
  });
});

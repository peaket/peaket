// FX-T11 후보 묶음 R1~R6·구매 수 대 한도·점수 범주·결과 지문. 동결 로컬 F-04-11.
import { describe, expect, test } from 'vitest';
import {
  computeClusters,
  purchasesOfSteps,
  RULE_VERSION,
  type ClusterInput,
  type ClusterLink,
  type ClusterRequest,
  type ClusterStep,
  type ExternalPost,
} from '../src/cluster.js';

const LIMIT = 4;
const link = (kind: ClusterLink['kind'], value: string, accountId: string, journeyId = `j-${accountId}`, firstSeenAt = 0): ClusterLink => ({
  kind,
  value,
  accountId,
  journeyId,
  firstSeenAt,
});
const step = (accountId: string, name: string, ts: number, extra: Partial<ClusterStep> = {}): ClusterStep => ({
  accountId,
  journeyId: `j-${accountId}`,
  step: name,
  ts,
  queueEntryId: '',
  seatIds: [],
  ...extra,
});
const request = (accountId: string, ip: string, ts: number, extra: Partial<ClusterRequest> = {}): ClusterRequest => ({
  accountId,
  ip,
  netClass: 'OTHER',
  asn: 64_500,
  ts,
  ...extra,
});
const base = (o: Partial<ClusterInput>): ClusterInput => ({
  eventId: '11111111-1111-7111-8111-111111111111',
  snapshotVersion: 1,
  ruleVersion: RULE_VERSION,
  limitPerPerson: LIMIT,
  saleStartMs: 0,
  links: [],
  requests: [],
  steps: [],
  ...o,
});

describe('R1 연결 그래프와 구매 수 대 한도', () => {
  test('FX-T11 ① 결제 수단 9계정 27장은 한 묶음이고 27/4·PAYMENT_METHOD·HIGH다', () => {
    const accounts = Array.from({ length: 9 }, (_, i) => `pay${i}`);
    const links: ClusterLink[] = [];
    const steps: ClusterStep[] = [];
    for (const [i, a] of accounts.entries()) {
      links.push(link('PAYMENT_METHOD', 'pm-planted-nine', a));
      links.push(link('ACCOUNT', a, a));
      links.push(link('PID', `p-${a}`, a));
      for (let k = 0; k < 3; k += 1) steps.push(step(a, 'SALE', 1_000 + (i * 3 + k) * 100, { seatIds: [`s-${i}-${k}`] }));
    }
    const out = computeClusters(base({ links, steps }));
    const c = out.clusters.find((x) => x.accounts.includes('pay0'));
    expect(c).toBeDefined();
    expect(c!.accounts).toEqual(accounts);
    expect(c!.accountCount).toBe(9);
    expect(c!.purchaseCount).toBe(27);
    expect(c!.limitPerPerson).toBe(4);
    expect(c!.sharedAttributes).toEqual(['PAYMENT_METHOD']);
    expect(c!.signals).toContain('LINK_GRAPH');
    expect(c!.candidate).toBe(true);
    expect(c!.scoreBand).toBe('HIGH');
    expect(out.candidateCount).toBeGreaterThanOrEqual(1);
  });

  test('FX-T11 ② 같은 결제 수단 2계정은 다른 약한 연결 없이는 묶이지 않는다', () => {
    const links = [link('PAYMENT_METHOD', 'pm-two', 'a'), link('PAYMENT_METHOD', 'pm-two', 'b')];
    const steps = [step('a', 'SALE', 100, { seatIds: ['s-a'] }), step('b', 'SALE', 200, { seatIds: ['s-b'] })];
    const onlyPayment = computeClusters(base({ links, steps }));
    expect(onlyPayment.clusters.some((c) => c.accounts.length === 2)).toBe(false);
    expect(onlyPayment.clusters.every((c) => c.accounts.length === 1)).toBe(true);

    const withIp = computeClusters(
      base({ links, steps, requests: [request('a', '198.51.100.7', 100), request('b', '198.51.100.7', 200)] }),
    );
    const pair = withIp.clusters.find((c) => c.accounts.length === 2);
    expect(pair).toBeDefined();
    expect(pair!.sharedAttributes).toEqual(['IP', 'PAYMENT_METHOD']);
    expect(pair!.candidate).toBe(false);
  });

  test('FX-T11 ③ 입장 토큰 없는 홀드는 계정 하나짜리 후보이고 가족 2계정 4장은 후보가 아니다', () => {
    const bypass = computeClusters(base({ steps: [step('bypass', 'HOLD_TRY', 100, { seatIds: ['s-b'] })] }));
    const b = bypass.clusters.find((c) => c.accounts.includes('bypass'));
    expect(b).toBeDefined();
    expect(b!.accounts).toEqual(['bypass']);
    expect(b!.signals).toEqual(['BYPASS_TRACE']);
    expect(b!.candidate).toBe(true);
    expect(b!.scoreBand).toBe('LOW');

    const family = computeClusters(
      base({
        links: [link('CONTACT', 'contact-family', 'f0'), link('CONTACT', 'contact-family', 'f1')],
        steps: [
          step('f0', 'SALE', 100, { seatIds: ['s-f0a', 's-f0b'] }),
          step('f1', 'SALE', 200, { seatIds: ['s-f1a', 's-f1b'] }),
        ],
      }),
    );
    const f = family.clusters.find((c) => c.accounts.length === 2);
    expect(f).toBeDefined();
    expect(f!.purchaseCount).toBe(4);
    expect(f!.limitPerPerson).toBe(4);
    expect(f!.candidate).toBe(false);
    expect(f!.scoreBand).toBe('LOW');
    expect(f!.sharedAttributes).toEqual(['CONTACT']);
  });

  test('FX-T11 ④ 이동통신 같은 IP 50계정과 행동만 비슷한 10계정은 묶이지 않는다', () => {
    const mobileAccounts = Array.from({ length: 50 }, (_, i) => `mobile${i}`);
    const mobile = computeClusters(
      base({ requests: mobileAccounts.map((a, i) => request(a, '203.0.113.77', i * 1_000, { netClass: 'OTHER' })) }),
    );
    expect(mobile.clusters).toEqual([]);

    const behaviorAccounts = Array.from({ length: 10 }, (_, i) => `beh${i}`);
    const behavior = computeClusters(
      base({
        steps: behaviorAccounts.flatMap((a, i) => [
          step(a, 'QUEUE_ENTER', i * 1_000, { journeyId: `j-${a}` }),
          step(a, 'ADMIT', i * 1_000 + 1, { journeyId: `j-${a}` }),
          step(a, 'HOLD_TRY', i * 1_000 + 2, { journeyId: `j-${a}` }),
        ]),
      }),
    );
    expect(behavior.clusters).toEqual([]);
  });

  test('FX-T11 ④ 같은 IP·ASN 20계정까지는 약한 연결 둘이 되고 21계정이면 아니다', () => {
    const at = (n: number, ip: string) =>
      base({
        steps: Array.from({ length: n }, (_, i) => step(`x${i}`, 'HOLD_TRY', i)),
        requests: Array.from({ length: n }, (_, i) => request(`x${i}`, ip, i * 10, { netClass: 'HOSTING', asn: 16_509 })),
      });
    const twenty = computeClusters(at(20, '198.51.100.10')).clusters.find((c) => c.accounts.length === 20);
    expect(twenty).toBeDefined();
    expect(twenty!.sharedAttributes).toEqual(['ASN', 'IP']);
    const twentyOne = computeClusters(at(21, '198.51.100.11'));
    expect(twentyOne.clusters.some((c) => c.accounts.length > 1)).toBe(false);
  });
});

describe('R2~R6 근거 신호', () => {
  test('FX-T11 ⑤ R2 동시 행동은 세 단계 이상일 때만 신호를 준다', () => {
    const accounts = ['s0', 's1', 's2'];
    const rows = accounts.flatMap((a) => [
      step(a, 'QUEUE_ENTER', 0),
      step(a, 'ADMIT', 0, { journeyId: `j-${a}` }),
      step(a, 'HOLD_TRY', 0, { journeyId: `j-${a}` }),
    ]);
    const out = computeClusters(base({ steps: rows }));
    expect(out.clusters).toHaveLength(3);
    for (const c of out.clusters) expect(c.signals).toEqual(['SYNC_STEPS']);
    expect(out.clusters.some((c) => c.accounts.length > 1)).toBe(false);

    const two = computeClusters(base({ steps: accounts.flatMap((a) => [step(a, 'QUEUE_ENTER', 0), step(a, 'ADMIT', 0, { journeyId: `j-${a}` })]) }));
    expect(two.clusters).toEqual([]);
  });

  test('FX-T11 ⑤ R3 같은 IP 5계정은 속도 신호, 다시 쓴 입장 링크는 강한 근거다', () => {
    const accounts = ['v0', 'v1', 'v2', 'v3', 'v4'];
    const velocity = computeClusters(
      base({
        requests: accounts.map((a, i) => request(a, '192.0.2.5', i * 1_000)),
        steps: accounts.flatMap((a, i) => [
          step(a, 'ADMIT', i, { journeyId: `j-${a}` }),
          step(a, 'HOLD_TRY', i + 1, { journeyId: `j-${a}` }),
        ]),
      }),
    );
    expect(velocity.clusters).toHaveLength(5);
    for (const c of velocity.clusters) expect(c.signals).toContain('VELOCITY');

    const reuse = computeClusters(
      base({
        links: [
          link('CONTACT', 'contact-reuse', 'r0'),
          link('CONTACT', 'contact-reuse', 'r1'),
          link('DEVICE', 'dev-0', 'r0', 'j-r0'),
          link('DEVICE', 'dev-1', 'r1', 'j-r1'),
        ],
        steps: [
          step('r0', 'ADMIT', 10, { journeyId: 'j-r0', queueEntryId: 'q-reuse' }),
          step('r1', 'ADMIT', 11, { journeyId: 'j-r1', queueEntryId: 'q-reuse' }),
          step('r0', 'HOLD_TRY', 20, { journeyId: 'j-r0' }),
          step('r1', 'HOLD_TRY', 21, { journeyId: 'j-r1' }),
        ],
      }),
    );
    const c = reuse.clusters.find((x) => x.accounts.length === 2);
    expect(c).toBeDefined();
    expect(c!.signals).toContain('VELOCITY');
    expect(c!.candidate).toBe(true);
    expect(c!.scoreBand).toBe('MEDIUM');
  });

  test('FX-T11 ⑤ R4 하위 0.1%보다 빠른 단계 둘이면 시간 기준선 신호다', () => {
    const steps: ClusterStep[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      const a = i === 0 ? 'fast' : `t${i}`;
      const base = i === 0 ? 0 : 1_000 + i * 10;
      steps.push(step(a, 'ADMIT', base, { journeyId: `j-${a}` }));
      steps.push(step(a, 'HOLD_TRY', base + 1, { journeyId: `j-${a}` }));
    }
    const out = computeClusters(base({ steps }));
    expect(out.clusters).toHaveLength(1);
    expect(out.clusters[0]!.accounts).toEqual(['fast']);
    expect(out.clusters[0]!.signals).toEqual(['TIMING_BASELINE']);
  });

  test('FX-T11 ⑤ R6 외부 게시물 좌석이 맞으면 묶음을 잇지 않고 신호를 붙인다', () => {
    const posts: ExternalPost[] = [{ postId: 'post-1', seatIds: ['s-2'] }];
    const out = computeClusters(
      base({
        links: [link('CONTACT', 'contact-post', 'p0'), link('CONTACT', 'contact-post', 'p1')],
        steps: [step('p0', 'SALE', 100, { seatIds: ['s-1'] }), step('p1', 'SALE', 200, { seatIds: ['s-2'] })],
        posts,
      }),
    );
    const c = out.clusters.find((x) => x.accounts.length === 2);
    expect(c).toBeDefined();
    expect(c!.signals).toEqual(['LINK_GRAPH', 'POST_MATCH']);
    expect(c!.candidate).toBe(true);
    expect(c!.scoreBand).toBe('MEDIUM');
  });
});

describe('지문과 공개 모양', () => {
  const nine = () => {
    const accounts = Array.from({ length: 9 }, (_, i) => `pay${i}`);
    const links: ClusterLink[] = [];
    const steps: ClusterStep[] = [];
    for (const [i, a] of accounts.entries()) {
      links.push(link('PAYMENT_METHOD', 'pm-planted-nine', a));
      for (let k = 0; k < 3; k += 1) steps.push(step(a, 'SALE', 1_000 + (i * 3 + k) * 100, { seatIds: [`s-${i}-${k}`] }));
    }
    return base({ links, steps });
  };

  test('FX-T11 ⑥ 같은 판·규칙 판이면 지문이 같고 입력 행 순서를 섞어도 같다', () => {
    const input = nine();
    const a = computeClusters(input);
    const b = computeClusters(input);
    expect(b.resultFingerprint).toBe(a.resultFingerprint);
    expect(b.clusters).toEqual(a.clusters);
    const shuffled = { ...input, links: [...input.links].reverse(), steps: [...input.steps].reverse() };
    expect(computeClusters(shuffled).resultFingerprint).toBe(a.resultFingerprint);
    expect(computeClusters({ ...input, ruleVersion: 'rules-next' }).resultFingerprint).not.toBe(a.resultFingerprint);
    expect(computeClusters({ ...input, snapshotVersion: 2 }).resultFingerprint).not.toBe(a.resultFingerprint);
    expect(computeClusters({ ...input, steps: input.steps.slice(1) }).resultFingerprint).not.toBe(a.resultFingerprint);
  });

  test('FX-T11 ⑦ 응답에 점수 원값·가중치가 없고 입력을 바꾸지 않는다', () => {
    const input = nine();
    const clone = structuredClone(input);
    const out = computeClusters(input);
    expect(input).toEqual(clone);
    const text = JSON.stringify(out);
    expect(text).not.toContain('"score"');
    expect(text).not.toContain('"weights"');
    expect(text).not.toContain('"scoreValue"');
    expect(() => computeClusters({ ...input, limitPerPerson: 0 })).toThrow(/한도/);
    expect(() => computeClusters({ ...input, limitPerPerson: 1.5 })).toThrow(/한도/);
    expect(() => computeClusters({ ...input, snapshotVersion: 0 })).toThrow(/판/);
    expect(() => computeClusters({ ...input, saleStartMs: Number.NaN })).toThrow(/시각/);
    expect(() => computeClusters({ ...input, steps: [{ ...step('a', 'SALE', Number.NaN), accountId: 'a' }] })).toThrow(/시각/);
  });

  test('FX-T11 ⑦ 구매 점수 경계가 P=L, P=L+1, P=3L에서 맞다', () => {
    const run = (seats: number[]) =>
      computeClusters(
        base({
          links: [link('CONTACT', 'c-bound', 'b0'), link('CONTACT', 'c-bound', 'b1')],
          steps: seats.map((n, i) => step(i === 0 ? 'b0' : 'b1', 'SALE', 100 + i, { seatIds: Array.from({ length: n }, (_, k) => `s-${i}-${k}`) })),
        }),
      ).clusters[0]!;
    expect(run([2, 2])).toMatchObject({ purchaseCount: 4, scoreBand: 'LOW', candidate: false });
    expect(run([3, 2])).toMatchObject({ purchaseCount: 5, scoreBand: 'MEDIUM', candidate: true });
    expect(run([6, 6])).toMatchObject({ purchaseCount: 12, scoreBand: 'HIGH', candidate: true });
  });

  test('FX-T11 ⑦ 구매 수는 SALE 좌석에서 CANCEL 좌석을 뺀다', () => {
    const steps = [
      step('a', 'SALE', 100, { seatIds: ['s1', 's2', 's3'] }),
      step('a', 'CANCEL', 200, { seatIds: ['s2'] }),
      step('b', 'SALE', 300, { seatIds: [] }),
    ];
    expect([...purchasesOfSteps(steps)]).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });
});

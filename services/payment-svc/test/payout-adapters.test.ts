// 지급대행 어댑터 순수 규칙 시험(토스 지급 웹훅 서명·포트원 출금 대사·잔액 원장, J-T6·J-T20·J-T25).
// F-07-6(ADR-0369 결정 5, settlement §8 웹훅 행): 서명 원문은 `{본문}:{전송 시각}`이고 머리의 v1: 값은 쉼표나 공백으로 나뉜 최대 넷이다.
// STALE은 서명이 맞고 전송 시각이 5분 넘게 다를 때만이다(서명이 틀리면 늦어도 SIGNATURE_MISMATCH). 설정 시험은 settlement-toss-assembly.test.ts J-T37 ⑤로 옮겼다.
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { ledgerBalance, normalizeHolderName, reconcilePortoneWithdrawals, verifyTossPayoutSignature } from '../src/modules/settlement/domain/payout-adapters.js';

const NOW = new Date('2026-11-15T00:00:00.000Z');
const BODY = JSON.stringify({ eventType: 'payout.changed', data: { payoutId: 'p1' } });
const TIME = NOW.toISOString();
const KEY = 'a1b2'.repeat(16);
const OLD = 'c3d4'.repeat(16);
const sign = (secret: string, time = TIME, body = BODY) => `v1:${createHmac('sha256', secret).update(`${body}:${time}`).digest('base64')}`;
const verify = (signature: string | undefined, o: { secrets?: string[]; time?: string; now?: Date } = {}) =>
  verifyTossPayoutSignature({ signature, secrets: o.secrets ?? [KEY], body: BODY, transmissionTime: o.time ?? TIME, now: o.now ?? NOW });

describe('J-T6 토스 지급 웹훅 서명', () => {
  test('J-T6 서명 원문은 {본문}:{전송 시각}이고, 본문만 서명한 값·다른 시각으로 만든 값은 거절한다 [ASVS v5.0.0-11.4.1]', () => {
    expect(verify(sign(KEY))).toBe('OK');
    expect(verify(`v1:${createHmac('sha256', KEY).update(BODY).digest('base64')}`)).toBe('SIGNATURE_MISMATCH');
    expect(verify(sign(KEY, new Date(NOW.getTime() + 1).toISOString()))).toBe('SIGNATURE_MISMATCH');
    expect(verify(sign(KEY, TIME, `${BODY} `))).toBe('SIGNATURE_MISMATCH');
    expect(verify(undefined)).toBe('SIGNATURE_MISMATCH');
    expect(verify('')).toBe('SIGNATURE_MISMATCH');
  });

  test('J-T6 키 교체 중: 쉼표·공백으로 나뉜 서명 넷 가운데 하나만 맞아도 받고, 지금·옛 키 어느 쪽이든 받는다', () => {
    const four = [sign('x'.repeat(64)), sign(OLD), sign('y'.repeat(64)), sign('z'.repeat(64))];
    expect(verify(four.join(','), { secrets: [KEY, OLD] })).toBe('OK');
    expect(verify(four.join(' '), { secrets: [KEY, OLD] })).toBe('OK');
    expect(verify(four.join(', '), { secrets: [KEY, OLD] })).toBe('OK');
    // 옛 키를 목록에서 빼면 같은 머리라도 거절한다
    expect(verify(four.join(','), { secrets: [KEY] })).toBe('SIGNATURE_MISMATCH');
    expect(verify([sign('x'.repeat(64)), sign('y'.repeat(64))].join(','), { secrets: [KEY, OLD] })).toBe('SIGNATURE_MISMATCH');
  });

  test('J-T6 늦음의 경계: 서명이 맞고 5분까지는 OK, 5분 1밀리초부터 STALE(앞뒤 모두), 서명이 틀리면 늦어도 SIGNATURE_MISMATCH다 [ASVS v5.0.0-16.3.3]', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    for (const [delta, verdict] of [
      [-(5 * 60_000 - 1), 'OK'],
      [-5 * 60_000, 'OK'],
      [-(5 * 60_000 + 1), 'STALE'],
      [5 * 60_000, 'OK'],
      [5 * 60_000 + 1, 'STALE'],
      [-10 * 60_000, 'STALE'],
    ] as const) {
      const time = at(delta);
      expect([delta, verify(sign(KEY, time), { time })]).toEqual([delta, verdict]);
    }
    const late = at(-10 * 60_000);
    expect(verify(sign('f'.repeat(64), late), { time: late })).toBe('SIGNATURE_MISMATCH');
  });
});

describe('J-T20 포트원 출금 대사', () => {
  const payout = (o = {}) => ({ payoutId: 'p1', statementId: 's1', amount: 100_000, bankCode: '004', accountLast4: '1234', status: 'COMPLETED' as const, ...o });
  const transfer = (o = {}) => ({ transferId: 't1', withdrawalType: 'WITHDRAWAL', payoutId: 'p1', amount: 100_000, bankCode: '004', accountLast4: '1234', holderName: '주식회사 피켓엔터', transferredAt: NOW, ...o });
  const accounts = new Map([['prom1', { promoterId: 'prom1', legalName: '주식회사 피켓엔터', representative: '김대표', bankCode: '004', accountLast4: '1234' }]]);

  test('금액·계좌·예금주가 맞으면 MATCHED, 다르면 MISMATCH다', () => {
    const ok = reconcilePortoneWithdrawals({ payouts: [payout()], transfers: [transfer()], accounts, promoterOfPayout: () => 'prom1' });
    expect(ok).toEqual([{ payoutId: 'p1', transferId: 't1', check: 'MATCHED', reasons: [] }]);
    const bad = reconcilePortoneWithdrawals({ payouts: [payout()], transfers: [transfer({ amount: 99_000 })], accounts, promoterOfPayout: () => 'prom1' });
    expect(bad[0]).toMatchObject({ check: 'MISMATCH', reasons: ['amount'] });
  });

  test('완료인데 출금이 없으면 MISSING, 이어지지 않는 출금은 UNLINKED다', () => {
    expect(reconcilePortoneWithdrawals({ payouts: [payout()], transfers: [], accounts, promoterOfPayout: () => 'prom1' })).toEqual([{ payoutId: 'p1', transferId: null, check: 'MISSING', reasons: ['no-withdrawal'] }]);
    const unlinked = reconcilePortoneWithdrawals({ payouts: [payout()], transfers: [transfer({ payoutId: 'other', amount: 50_000 })], accounts, promoterOfPayout: () => 'prom1' });
    expect(unlinked.map((r) => r.check)).toContain('UNLINKED');
  });

  test('예금주 표기 차이(㈜·(주)·공백)는 같게 본다', () => {
    expect(normalizeHolderName('㈜피켓엔터')).toBe(normalizeHolderName('주식회사 피켓엔터'));
    expect(normalizeHolderName('(주) 피켓 엔터')).toBe(normalizeHolderName('피켓엔터'));
    expect(normalizeHolderName('피켓엔터테인먼트')).not.toBe(normalizeHolderName('피켓엔터'));
  });
});

describe('J-T25 지급대행 잔액 원장', () => {
  test('승인−환급−수수료−지급−인출이 있어야 할 잔액이다', () => {
    expect(ledgerBalance({ approvedAmount: 1_000_000, refundedAmount: 100_000, pgFees: 30_000, paidOut: 800_000, peaketWithdrawn: 0 })).toBe(70_000);
    expect(ledgerBalance({ approvedAmount: 1_000_000, refundedAmount: 100_000, pgFees: 30_000, paidOut: 800_000, peaketWithdrawn: 70_000 })).toBe(0);
  });
});

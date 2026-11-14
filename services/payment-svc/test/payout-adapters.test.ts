// 지급대행 어댑터 순수 규칙 시험(토스 지급 웹훅 서명·포트원 출금 대사·잔액 원장, J-T6·J-T20·J-T25).
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { ledgerBalance, normalizeHolderName, reconcilePortoneWithdrawals, tossPayoutConfigured, verifyTossPayoutSignature } from '../src/modules/settlement/domain/payout-adapters.js';

const NOW = new Date('2026-11-15T00:00:00.000Z');
const BODY = JSON.stringify({ eventType: 'payout.changed', data: { payoutId: 'p1' } });
const sign = (secret: string) => `v1:${createHmac('sha256', secret).update(BODY).digest('base64')}`;

describe('J-T6 토스 지급 웹훅 서명', () => {
  test('서명 4개 중 하나가 맞으면 받고, 틀리거나 5분 넘게 늦으면 거절한다', () => {
    const header = [sign('old'), sign('current'), sign('other'), sign('extra')].join(' ');
    expect(verifyTossPayoutSignature({ signature: header, secrets: ['current'], body: BODY, transmissionTime: NOW.toISOString(), now: NOW })).toBe('OK');
    expect(verifyTossPayoutSignature({ signature: sign('nope'), secrets: ['current'], body: BODY, transmissionTime: NOW.toISOString(), now: NOW })).toBe('SIGNATURE_MISMATCH');
    expect(verifyTossPayoutSignature({ signature: sign('current'), secrets: ['current'], body: BODY, transmissionTime: new Date(NOW.getTime() - 6 * 60_000).toISOString(), now: NOW })).toBe('STALE');
  });

  test('JWE·API 키·웹훅 비밀이 다 있어야 설정이 선다', () => {
    expect(tossPayoutConfigured({})).toBeUndefined();
    expect(tossPayoutConfigured({ PEAKET_PG_TOSS_PAYOUT_API_KEY: 'k', PEAKET_PG_TOSS_PAYOUT_JWE_KEY_ID: 'id', PEAKET_PG_TOSS_PAYOUT_JWE_PUBLIC_KEY: 'pem' })).toBeUndefined();
    expect(tossPayoutConfigured({ PEAKET_PG_TOSS_PAYOUT_API_KEY: 'k', PEAKET_PG_TOSS_PAYOUT_JWE_KEY_ID: 'id', PEAKET_PG_TOSS_PAYOUT_JWE_PUBLIC_KEY: 'pem', PEAKET_PG_TOSS_PAYOUT_WEBHOOK_SECRETS: 'a,b' })).toMatchObject({ webhookSecrets: ['a', 'b'] });
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

// F-07-7 시험의 설정 값과 로그·원문 검사 도구(제품 코드를 읽지 않는다. 트레이스 시험이 SDK를 띄우기 전에 가져와도 된다).
import { Writable } from 'node:stream';
import type { TossPayoutConfig } from '../../src/modules/settlement/domain/payout-adapters.js';

export const PORTONE_SECRET = 'sim_sk_f077_portone_platform';
/** 포트원 파트너 정산 기본 계약 ID(시험 값, 코드 상수와 다르게) */
export const PORTONE_CONTRACT_ID = 'contract-f077-zero-fee';
export const INTERNAL_TOKEN = 'internal-f077-token';

/** 결제 포트원 설정 넷 + 지급대행 켜짐 표시·기본 계약(ADR-0370 결정 3, loadPortoneGatewayConfig와 같은 규칙) */
export function portoneEnv(url: string, over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PEAKET_ENV: 'ci',
    PEAKET_PG_PORTONE_URL: url,
    PEAKET_PG_PORTONE_SECRET: PORTONE_SECRET,
    PEAKET_PG_PORTONE_STORE_ID: 'store-f077',
    PEAKET_PG_PORTONE_CHANNEL_KEY: 'channel-key-f077',
    PEAKET_PG_PORTONE_WEBHOOK_SECRET: 'whsec-f077',
    PEAKET_PAYOUT_PORTONE_ENABLED: 'true',
    PEAKET_PAYOUT_PORTONE_CONTRACT_ID: PORTONE_CONTRACT_ID,
    ...over,
  };
}

/** 토스 지급대행 두 상점 설정(F-07-6 계획 §5.1(가) 모양. 보안 키는 64자 hex에서 온 32바이트) */
export const TOSS_CONFIG: TossPayoutConfig = {
  stores: {
    STANDARD: { secretKey: 'test_sk_f077_standard', securityKeys: [Buffer.from('11'.repeat(32), 'hex')] },
    ESCROW: { secretKey: 'test_sk_f077_escrow', securityKeys: [Buffer.from('22'.repeat(32), 'hex')] },
  },
};

/** 로그 줄을 모으는 목적지(계좌번호·예금주명 0건 단언용) */
export function logSink(): { stream: Writable; lines: string[]; text: () => string } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { stream, lines, text: () => lines.join('\n') };
}

/** 계좌번호 두 모양(하이픈 없음·있음)과 예금주명이 글에 하나도 없는지 */
export function leaks(text: string, accountNumber: string, holderName?: string): string[] {
  const hyphen = `${accountNumber.slice(0, 3)}-${accountNumber.slice(3, 7)}-${accountNumber.slice(7)}`;
  const out: string[] = [];
  if (text.includes(accountNumber)) out.push('accountNumber');
  if (text.includes(hyphen)) out.push('accountNumber-hyphen');
  if (holderName !== undefined && text.includes(holderName)) out.push('holderName');
  return out;
}


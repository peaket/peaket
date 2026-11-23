// J-T37 ⑥ start()의 토스 지급대행 조립을 실제 PostgreSQL로 띄워 본다(F-07-6 LCH-110, ADR-0369 결정 2·5, 시험 리뷰 TR-01 (나)(다)).
// 시험 조립(tossHarness·assembleTossPayout 직접 부르기)과 따로, 운영 시작 함수 start()를 같은 프로세스에서 띄운다(포트 0, 로그는 logDestination으로 모음).
// - 설정이 있으면: /v1/webhooks/toss의 틀린 서명 payout.changed는 400과 보안 로그 settlement_webhook_signature_invalid,
//   내부 POST /internal/v1/settlements/toss-sellers는 503이 아니라 대역 서버(PEAKET_PG_TOSS_PAYOUT_BASE_URL, PEAKET_ENV=ci)를 부른다.
// - 설정이 없으면: 정산 사건 웹훅은 400과 settlement_webhook_unconfigured이고 결제 웹훅 처리(payment-webhook-*)로 가지 않는다.
// 결제사는 부르지 않는다(대역 서버만). 반쯤 된 설정의 시작 거부는 단위 시험(settlement-toss-assembly.test.ts J-T37 ⑤)이 본다.
import 'reflect-metadata';
import { createDatabase, ensureOutboxPartitions, systemClock, type Database } from '@peaket/platform';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { start, type StartedService } from '../src/start.js';
import { signTossWebhook, startTossPayoutFake, tossWebhookBody, type TossPayoutFake } from '../test/support/toss-payout-fake.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pgc: PostgresContainer;
let admin: Database;
let fake: TossPayoutFake;
const keys = { STANDARD: { secretKey: `it_sk_std_${randomBytes(4).toString('hex')}`, hex: randomBytes(32).toString('hex') }, ESCROW: { secretKey: `it_sk_esc_${randomBytes(4).toString('hex')}`, hex: randomBytes(32).toString('hex') } };

/** 로그 줄(JSON)을 모으는 목적지 */
function lines(): { destination: Writable; read: () => Record<string, unknown>[] } {
  const out: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _e, cb) {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === '') continue;
        try {
          out.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // JSON이 아닌 줄은 건너뛴다
        }
      }
      cb();
    },
  });
  return { destination, read: () => out };
}

const baseEnv = () => ({
  PEAKET_ENV: 'ci',
  PEAKET_DATABASE_URL: pgc.url,
  PORT: '0',
  PEAKET_MANAGEMENT_PORT: '0',
  PEAKET_GRPC_HOST: '127.0.0.1',
  PEAKET_GRPC_PORT: '0',
  PEAKET_LOG_LEVEL: 'info',
});
const tossEnv = () => ({
  PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_STANDARD: keys.STANDARD.secretKey,
  PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_STANDARD: keys.STANDARD.hex,
  PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_ESCROW: keys.ESCROW.secretKey,
  PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_ESCROW: keys.ESCROW.hex,
  PEAKET_PG_TOSS_PAYOUT_BASE_URL: fake.url,
});

const postWebhook = (svc: StartedService, body: string, signature: string) =>
  fetch(`http://127.0.0.1:${svc.ports.appPort}/v1/webhooks/toss`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'tosspayments-webhook-signature': signature, 'tosspayments-webhook-transmission-time': new Date().toISOString(), 'tosspayments-webhook-transmission-id': `tx-${randomUUID()}` },
    body,
  });

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 2, applicationName: 'f076-start-admin' });
  await ensureOutboxPartitions(admin, systemClock);
  fake = await startTossPayoutFake({ STANDARD: { secretKey: keys.STANDARD.secretKey, securityKey: Buffer.from(keys.STANDARD.hex, 'hex') }, ESCROW: { secretKey: keys.ESCROW.secretKey, securityKey: Buffer.from(keys.ESCROW.hex, 'hex') } });
}, 180_000);

afterAll(async () => {
  await admin?.close();
  await fake?.close();
  pgc?.stop();
});

describe('J-T37 ⑥ start() 조립(실제 PostgreSQL)', () => {
  test('J-T37 ⑥ 토스 설정으로 띄운 start()는 정산 수신기를 조립해 틀린 서명 payout.changed를 400·settlement_webhook_signature_invalid로 막고, 셀러 등록 내부 경로가 대역 서버를 부른다 [ASVS v5.0.0-16.3.3]', async () => {
    const log = lines();
    const svc = await start({ env: { ...baseEnv(), ...tossEnv() }, logDestination: log.destination });
    try {
      const body = tossWebhookBody('payout.changed', { id: 'FPAY-START-1', status: 'COMPLETED' });
      const bad = await postWebhook(svc, body, signTossWebhook(body, new Date().toISOString(), 'f'.repeat(64)));
      expect(bad.status).toBe(400);
      expect(log.read().filter((l) => l.event === 'settlement_webhook_signature_invalid')).toHaveLength(1);
      expect(log.read().some((l) => typeof l.kind === 'string' && l.kind.startsWith('payment-webhook'))).toBe(false);
      // 셀러 등록 내부 경로는 조립된 전송으로 두 상점에 등록한다(설정 없음 503이 아니다)
      const res = await fetch(`http://127.0.0.1:${svc.ports.appPort}/internal/v1/settlements/toss-sellers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          promoterId: randomUUID(),
          businessType: 'CORPORATE',
          company: { name: '주식회사 피켓엔터', representativeName: '김대표', businessRegistrationNumber: '1234567890', email: 'settle@peaket.example', phone: '0212345678' },
          account: { bankCode: '004', accountNumber: '110123456789', holderName: '주식회사 피켓엔터' },
        }),
      });
      expect(res.status).toBe(200);
      expect(fake.calls('POST', /^\/v2\/sellers$/).map((r) => r.store).sort()).toEqual(['ESCROW', 'STANDARD']);
      expect(JSON.stringify(log.read())).not.toContain('110123456789');
      expect(JSON.stringify(log.read())).not.toContain(keys.STANDARD.hex);
    } finally {
      await svc.close();
    }
  });

  test('J-T37 ⑥ 토스 설정 없이 띄운 start()는 정산 사건 웹훅을 400·settlement_webhook_unconfigured로 막고 결제 웹훅 처리로 넘기지 않는다', async () => {
    const log = lines();
    const svc = await start({ env: baseEnv(), logDestination: log.destination });
    try {
      for (const body of [tossWebhookBody('payout.changed', { id: 'FPAY-START-2', status: 'COMPLETED' }), tossWebhookBody('seller.changed', { id: 'FSEL-START-2', status: 'APPROVED' })]) {
        expect((await postWebhook(svc, body, 'v1:x')).status).toBe(400);
      }
      expect(log.read().filter((l) => l.event === 'settlement_webhook_unconfigured')).toHaveLength(2);
      expect(log.read().some((l) => typeof l.kind === 'string' && l.kind.startsWith('payment-webhook'))).toBe(false);
      const res = await fetch(`http://127.0.0.1:${svc.ports.appPort}/internal/v1/settlements/toss-sellers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          promoterId: randomUUID(),
          businessType: 'CORPORATE',
          company: { name: '주식회사 피켓엔터', representativeName: '김대표', businessRegistrationNumber: '1234567890', email: 'settle@peaket.example', phone: '0212345678' },
          account: { bankCode: '004', accountNumber: '110123456789', holderName: '주식회사 피켓엔터' },
        }),
      });
      expect(res.status).toBe(503);
    } finally {
      await svc.close();
    }
  });
});

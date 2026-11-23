// 포트원 플랫폼 전송 어댑터 계약 시험(F-07-7 계획 §5.1(가)(나), ADR-0370 결정 1·3·8 ④, settlement §3·§5.3, guidelines §8 포트원 플랫폼 행).
// - J-T17: 예금주 조회 뒤 트레이스·로그에 계좌번호(하이픈 있음·없음)가 없고 경로 틀만 남는다.
// - J-T22 ③: 녹화한 이체 원장 응답의 칸 이름을 바꾸면 어댑터가 모양 오류(SHAPE)로 거부한다(payment P-T16과 같은 계약 시험 자리).
// - 켜짐 판정(portonePayoutConfigured)과 시작 조립(assemblePortonePlatform)을 시험 조립과 따로 부른다.
// 대역 서버는 test/support/portone-platform-fake.ts(공개 명세 모양 [가정]). 결제사는 부르지 않는다.
// SDK는 계측할 호출보다 먼저 서야 하므로 파일 맨 위에서 시작한다(services/identity-svc/test/outbound-trace.test.ts와 같은 꼴).
import { startTelemetry } from '@peaket/platform/telemetry';

type Processor = NonNullable<Parameters<typeof startTelemetry>[0]['spanProcessors']>[number];
type Ended = Parameters<Processor['onEnd']>[0];
const ended: Ended[] = [];
const memory: Processor = {
  onStart: () => {},
  onEnd: (span) => {
    ended.push(span);
  },
  forceFlush: async () => {},
  shutdown: async () => {},
};
const telemetry = startTelemetry({ serviceName: 'payment-svc', env: 'ci', spanProcessors: [memory] });

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { PortonePlatformFake } from './support/portone-platform-fake.js';
import { leaks, logSink, PORTONE_CONTRACT_ID, PORTONE_SECRET, portoneEnv } from './support/settlement-portone-env.js';

// 제품 코드는 SDK를 띄운 뒤 읽는다(identity outbound-trace 시험과 같다)
type Platform = typeof import('@peaket/platform');
type Adapters = typeof import('../src/modules/settlement/adapters/http-portone-platform-transport.js');
let createPlatformLogger: Platform['createPlatformLogger'];
let fakeClock: Platform['fakeClock'];
let ManualPortonePayoutGateway: typeof import('../src/modules/settlement/index.js')['ManualPortonePayoutGateway'];
let portonePayoutConfigured: typeof import('../src/modules/settlement/domain/payout-adapters.js')['portonePayoutConfigured'];
let HttpPortonePlatformTransport: Adapters['HttpPortonePlatformTransport'];
let PortoneTransportError: Adapters['PortoneTransportError'];
let assemblePortonePlatform: typeof import('../src/start.js')['assemblePortonePlatform'];
type PortoneTransportErrorInstance = InstanceType<Adapters['PortoneTransportError']>;

const NOW = Date.parse('2026-11-23T01:00:00.000Z');
/** 시험 계좌(하이픈 없는 14자리). 하이픈 모양 110-1234-5678901도 함께 찾는다 */
const ACCOUNT = '11012345678901';
/** PEAKET 은행 코드(토스 두 자리 표, packages/validation 허용 목록)와 포트원 Bank 열거값(payment-gateway.ts 대응표) */
const BANK = '88';
const BANK_ENUM = 'SHINHAN';
const HOLDER = '주식회사 피켓엔터';

const fake = new PortonePlatformFake(PORTONE_SECRET);

// 플랫폼 전체를 불러오므로 붐비면 기본 제한(5초)을 넘을 수 있어 준비만 60초로 둔다(packages/platform/test/telemetry.test.ts와 같다)
beforeAll(async () => {
  ({ createPlatformLogger, fakeClock } = await import('@peaket/platform'));
  ({ ManualPortonePayoutGateway } = await import('../src/modules/settlement/index.js'));
  ({ portonePayoutConfigured } = await import('../src/modules/settlement/domain/payout-adapters.js'));
  ({ HttpPortonePlatformTransport, PortoneTransportError } = await import('../src/modules/settlement/adapters/http-portone-platform-transport.js'));
  ({ assemblePortonePlatform } = await import('../src/start.js'));
  await fake.start();
}, 60_000);
afterAll(async () => {
  await fake.close();
  await telemetry.shutdown();
});
beforeEach(() => {
  fake.reset();
  ended.length = 0;
});

const transport = () => {
  const config = portonePayoutConfigured(portoneEnv(fake.url));
  if (!config) throw new Error('시험 설정이 켜짐이어야 한다');
  return new HttpPortonePlatformTransport(config, { clock: fakeClock({ now: NOW }) });
};

/** 끝난 span의 이름·속성 전체 글(흉내 서버 자신의 서버 span은 뺀다) */
const spanText = () => JSON.stringify(ended.filter((s) => s.kind !== 1).map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })));

describe('J-T39 ⑤ 포트원 지급대행 켜짐 판정(ADR-0370 결정 3)', () => {
  test('J-T39 ⑤-1 ENABLED가 없거나 true가 아니면 결제 포트원 설정이 있어도 꺼짐(undefined)이다', () => {
    const { PEAKET_PAYOUT_PORTONE_ENABLED: _enabled, ...withoutFlag } = portoneEnv(fake.url);
    expect(portonePayoutConfigured(withoutFlag)).toBeUndefined();
    expect(portonePayoutConfigured(portoneEnv(fake.url, { PEAKET_PAYOUT_PORTONE_ENABLED: 'false' }))).toBeUndefined();
    expect(portonePayoutConfigured({ PEAKET_ENV: 'ci' })).toBeUndefined();
  });

  test('J-T39 ⑤-2 ENABLED=true·계약 ID·결제 포트원 설정이 다 있으면 주소·시크릿·계약 ID를 준다', () => {
    expect(portonePayoutConfigured(portoneEnv(fake.url))).toEqual({ baseUrl: fake.url, secret: PORTONE_SECRET, contractId: PORTONE_CONTRACT_ID });
  });

  test('J-T39 ⑤-3 ENABLED=true인데 계약 ID나 결제 시크릿이 없으면 시작하지 않고, 오류 글에 환경 이름만 있고 값이 없다', () => {
    const noContract = () => portonePayoutConfigured(portoneEnv(fake.url, { PEAKET_PAYOUT_PORTONE_CONTRACT_ID: undefined }));
    expect(noContract).toThrow(/PEAKET_PAYOUT_PORTONE_CONTRACT_ID/);
    const noSecret = () =>
      portonePayoutConfigured(portoneEnv(fake.url, { PEAKET_PG_PORTONE_SECRET: undefined, PEAKET_PG_PORTONE_STORE_ID: undefined, PEAKET_PG_PORTONE_CHANNEL_KEY: undefined, PEAKET_PG_PORTONE_WEBHOOK_SECRET: undefined }));
    expect(noSecret).toThrow(/PEAKET_PG_PORTONE_SECRET/);
    for (const f of [noContract, noSecret]) {
      try {
        f();
      } catch (e) {
        expect(String(e)).not.toContain(PORTONE_SECRET);
        expect(String(e)).not.toContain(fake.url);
      }
    }
    expect.assertions(6);
  });

  test('J-T39 ⑤-4 시작 조립: 켜지면 HTTP 전송과 수기 정산건 갈래, 꺼지면 전송 없음과 지금의 수기 기록 게이트웨이다', () => {
    const logger = createPlatformLogger({ service: 'payment-svc', env: 'ci', version: 't', clock: fakeClock({ now: NOW }), level: 'info', destination: logSink().stream });
    const on = assemblePortonePlatform(portoneEnv(fake.url), { baseUrl: fake.url, clock: fakeClock({ now: NOW }), log: logger });
    expect(on.transport).toBeInstanceOf(HttpPortonePlatformTransport);
    expect(on.gateway.pg).toBe('PORTONE');
    expect(on.gateway).not.toBeInstanceOf(ManualPortonePayoutGateway);
    const off = assemblePortonePlatform({ PEAKET_ENV: 'ci' }, { clock: fakeClock({ now: NOW }), log: logger });
    expect(off.transport).toBeUndefined();
    expect(off.gateway).toBeInstanceOf(ManualPortonePayoutGateway);
  });
});

describe('포트원 플랫폼 전송 요청 모양(계약 시험)', () => {
  test('J-T17 예금주 조회는 경로 틀 span 하나이고 트레이스·로그·오류에 계좌번호(두 모양)가 0건이다 [ASVS v5.0.0-16.2.5]', async () => {
    fake.holder(BANK_ENUM, ACCOUNT, HOLDER);
    const t = transport();
    await expect(t.lookupHolder({ bankCode: BANK, accountNumber: ACCOUNT })).resolves.toEqual({ holderName: HOLDER });
    const calls = fake.calls('GET /platform/bank-accounts/{bank}/{accountNumber}/holder');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe(`PortOne ${PORTONE_SECRET}`);
    expect(calls[0]!.path).toBe(`/platform/bank-accounts/${BANK_ENUM}/${ACCOUNT}/holder`);
    const client = ended.filter((s) => s.kind === 2);
    expect(client.map((s) => [s.name, s.attributes['url.template']])).toEqual([['GET /platform/bank-accounts/{bank}/{accountNumber}/holder', '/platform/bank-accounts/{bank}/{accountNumber}/holder']]);
    expect(leaks(spanText(), ACCOUNT)).toEqual([]);
    // 없는 계좌는 null, 실패의 오류 글·쌓인 호출 기록에도 계좌번호가 없다
    await expect(t.lookupHolder({ bankCode: BANK, accountNumber: '11099999999999' })).resolves.toBeNull();
    fake.fault('GET /platform/bank-accounts/{bank}/{accountNumber}/holder', '5xx', 1);
    const err = await t.lookupHolder({ bankCode: BANK, accountNumber: ACCOUNT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortoneTransportError);
    expect(leaks(`${String(err)} ${(err as Error).stack ?? ''} ${JSON.stringify(err)}`, ACCOUNT)).toEqual([]);
    expect(leaks(spanText(), ACCOUNT)).toEqual([]);
  });

  test('J-T39 ④-1 예금주 조회의 응답 없음은 NO_RESPONSE, 5xx는 status 503, 모양 틀림은 SHAPE로 던진다', async () => {
    const t = transport();
    fake.holder(BANK_ENUM, ACCOUNT, HOLDER);
    fake.fault('GET /platform/bank-accounts/{bank}/{accountNumber}/holder', 'reset', 1);
    await expect(t.lookupHolder({ bankCode: BANK, accountNumber: ACCOUNT })).rejects.toMatchObject({ name: expect.any(String), kind: 'NO_RESPONSE' });
    fake.fault('GET /platform/bank-accounts/{bank}/{accountNumber}/holder', '5xx', 1);
    const fivexx = await t.lookupHolder({ bankCode: BANK, accountNumber: ACCOUNT }).catch((e: unknown) => e);
    expect(fivexx).toBeInstanceOf(PortoneTransportError);
    expect((fivexx as PortoneTransportErrorInstance).status).toBe(503);
    fake.fault('GET /platform/bank-accounts/{bank}/{accountNumber}/holder', 'shape', 1);
    await expect(t.lookupHolder({ bankCode: BANK, accountNumber: ACCOUNT })).rejects.toMatchObject({ kind: 'SHAPE' });
    // 장애가 걷히면 다시 이름을 준다(장애가 실제로 세 번 있었다)
    await expect(t.lookupHolder({ bankCode: BANK, accountNumber: ACCOUNT })).resolves.toEqual({ holderName: HOLDER });
    expect(fake.calls('GET /platform/bank-accounts/{bank}/{accountNumber}/holder')).toHaveLength(4);
  });

  test('J-T39 ①-1 파트너 등록·수정·조회의 경로·본문(계좌는 결제사 요청에만, 돌려준 값은 끝 4자리)', async () => {
    const t = transport();
    const partnerId = 'peaket-0b6d6a3c-1f4e-4a77-9d0e-6a1b2c3d4e5f';
    await expect(
      t.registerPartner({
        partnerId,
        contractId: PORTONE_CONTRACT_ID,
        company: { name: HOLDER, representativeName: '김대표', businessRegistrationNumber: '1234567890', email: 'pay@peaket.test', phone: '0212345678' },
        account: { bankCode: BANK, accountNumber: ACCOUNT, holderName: HOLDER },
      }),
    ).resolves.toEqual({ partnerId });
    const reg = fake.calls('POST /platform/partners');
    expect(reg).toHaveLength(1);
    // 본문은 값까지 본다(TR-06): 파트너 ID·상호·연락처·계좌(포트원 Bank 열거값·KRW)·기본 계약·사업자 정보
    expect(reg[0]!.body).toEqual({
      id: partnerId,
      name: HOLDER,
      contact: { name: '김대표', email: 'pay@peaket.test', phoneNumber: '0212345678' },
      account: { bank: BANK_ENUM, currency: 'KRW', number: ACCOUNT, holder: HOLDER },
      defaultContractId: PORTONE_CONTRACT_ID,
      type: { business: { companyName: HOLDER, representativeName: '김대표', businessRegistrationNumber: '1234567890' } },
    });
    await t.updatePartnerAccount(partnerId, { bankCode: '06', accountNumber: '06476543210987', holderName: HOLDER });
    expect(fake.calls('PATCH /platform/partners/{id}').map((c) => [c.path, c.body])).toEqual([[`/platform/partners/${partnerId}`, { account: expect.objectContaining({ bank: 'KOOKMIN', number: '06476543210987', holder: HOLDER }) }]]);
    const got = await t.getPartner(partnerId);
    expect(got).toEqual({ partnerId, bankCode: '06', accountLast4: '0987', holderName: HOLDER, scheduled: null });
    expect(JSON.stringify(got)).not.toContain('06476543210987');
    fake.partners.get(partnerId)!.scheduled = { bank: 'WOORI', number: '10011112222333', holder: '김대표' };
    expect((await t.getPartner(partnerId)).scheduled).toEqual({ bankCode: '20', accountLast4: '2333', holderName: '김대표' });
    expect(fake.calls('GET /platform/partners/{id}/schedule')).toHaveLength(2);
  });

  test('J-T41 ①-1 수기 정산건: 아이디 = 정산서 ID, 같은 아이디는 조회로 확인해 created false, 금액이 다르면 REJECTED', async () => {
    const t = transport();
    const input = { transferId: '01937b2e-5d0a-7c11-8a2b-3c4d5e6f7a8b', partnerId: 'peaket-a', amount: 12_193_000, settlementDate: '2026-11-27' };
    await expect(t.createManualTransfer(input)).resolves.toEqual({ transferId: input.transferId, created: true });
    expect(fake.calls('POST /platform/transfers/manual')[0]!.body).toEqual({ id: input.transferId, partnerId: 'peaket-a', settlementAmount: 12_193_000, settlementDate: '2026-11-27' });
    await expect(t.createManualTransfer(input)).resolves.toEqual({ transferId: input.transferId, created: false });
    expect(fake.calls('GET /platform/transfers/{id}')).toHaveLength(1);
    await expect(t.createManualTransfer({ ...input, amount: 12_193_001 })).rejects.toMatchObject({ kind: 'REJECTED' });
    await expect(t.createManualTransfer({ ...input, settlementDate: '2026-11-30' })).rejects.toMatchObject({ kind: 'REJECTED' });
    await expect(t.getManualTransfer(input.transferId)).resolves.toEqual({ transferId: input.transferId, amount: 12_193_000, settlementDate: '2026-11-27', status: 'SCHEDULED' });
    await expect(t.getManualTransfer('missing-transfer')).resolves.toBeNull();
    await t.cancelManualTransfer(input.transferId);
    expect(fake.transfers.get(input.transferId)!.status).toBe('CANCELLED');
    expect(fake.calls('DELETE /platform/transfers/{id}')).toHaveLength(1);
  });

  test('J-T41 ③-1 지급 내역은 일괄 지급 ID로 거르고 상태·완료 시각·실패 코드를 옮긴다', async () => {
    const t = transport();
    fake.payouts.push(
      { id: 'po-1', bulkPayoutId: 'bulk-77', transferId: 'tr-1', status: 'SUCCEEDED', completedAt: '2026-11-27T02:10:00.000Z', failureCode: null },
      { id: 'po-2', bulkPayoutId: 'bulk-77', transferId: 'tr-2', status: 'STOPPED', completedAt: null, failureCode: 'ACCOUNT_CLOSED' },
      { id: 'po-3', bulkPayoutId: 'bulk-other', transferId: 'tr-3', status: 'SUCCEEDED', completedAt: '2026-11-27T02:10:00.000Z', failureCode: null },
    );
    await expect(t.listPayouts({ bulkPayoutId: 'bulk-77' })).resolves.toEqual([
      { payoutId: 'po-1', transferId: 'tr-1', status: 'SUCCEEDED', completedAt: new Date('2026-11-27T02:10:00.000Z'), failureCode: null },
      { payoutId: 'po-2', transferId: 'tr-2', status: 'STOPPED', completedAt: null, failureCode: 'ACCOUNT_CLOSED' },
    ]);
    expect(fake.calls('GET /platform/payouts')[0]!.query).toEqual({ bulkPayoutId: 'bulk-77' });
  });

  test('J-T20 ①-1 이체 원장은 기간으로 읽고 받는 계좌를 끝 4자리로만 돌려준다(계좌번호 전체 0건) [ASVS v5.0.0-16.2.5]', async () => {
    const t = transport();
    fake.accountTransfers.push(
      { id: 'at-1', type: 'WITHDRAWAL', withdrawalType: 'PAYOUT', payoutId: 'po-1', amount: 12_193_000, bank: BANK_ENUM, accountNumber: ACCOUNT, holderName: HOLDER, balance: 87_807_000, tradedAt: '2026-11-27T02:11:00.000Z' },
      { id: 'at-2', type: 'DEPOSIT', withdrawalType: null, payoutId: null, amount: 50_000_000, bank: null, accountNumber: null, holderName: null, balance: 137_807_000, tradedAt: '2026-11-27T03:00:00.000Z' },
      { id: 'at-old', type: 'WITHDRAWAL', withdrawalType: 'PAYOUT', payoutId: 'po-0', amount: 1, bank: BANK_ENUM, accountNumber: ACCOUNT, holderName: HOLDER, balance: 1, tradedAt: '2026-11-20T00:00:00.000Z' },
    );
    const from = new Date('2026-11-27T00:00:00.000Z');
    const to = new Date('2026-11-27T04:00:00.000Z');
    const rows = await t.listAccountTransfers({ from, to });
    expect(rows).toEqual([
      { transferId: 'at-1', type: 'WITHDRAWAL', withdrawalType: 'PAYOUT', payoutId: 'po-1', amount: 12_193_000, bankCode: BANK, accountLast4: '8901', holderName: HOLDER, balance: 87_807_000, transferredAt: new Date('2026-11-27T02:11:00.000Z') },
      { transferId: 'at-2', type: 'DEPOSIT', withdrawalType: null, payoutId: null, amount: 50_000_000, bankCode: null, accountLast4: null, holderName: null, balance: 137_807_000, transferredAt: new Date('2026-11-27T03:00:00.000Z') },
    ]);
    expect(leaks(JSON.stringify(rows), ACCOUNT)).toEqual([]);
    expect(fake.calls('GET /platform/account-transfers')[0]!.query).toEqual({ from: from.toISOString(), until: to.toISOString() });
  });

  test('J-T22 ③ 녹화한 이체 원장 응답의 칸 이름(amount·tradedAt)을 바꾸면 SHAPE로 거부하고 일부만 돌려주지 않는다', async () => {
    const t = transport();
    fake.accountTransfers.push({ id: 'at-1', type: 'WITHDRAWAL', withdrawalType: 'PAYOUT', payoutId: 'po-1', amount: 12_193_000, bank: BANK_ENUM, accountNumber: ACCOUNT, holderName: HOLDER, balance: 1, tradedAt: '2026-11-27T02:11:00.000Z' });
    const window = { from: new Date('2026-11-27T00:00:00.000Z'), to: new Date('2026-11-27T04:00:00.000Z') };
    fake.fault('GET /platform/account-transfers', 'shape', 1);
    const err = await t.listAccountTransfers(window).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortoneTransportError);
    expect((err as PortoneTransportErrorInstance).kind).toBe('SHAPE');
    expect(leaks(String(err), ACCOUNT, HOLDER)).toEqual([]);
    // 같은 녹화 응답이 원래 칸 이름이면 받는다(대역이 실제로 칸을 바꿨다는 대조)
    await expect(t.listAccountTransfers(window)).resolves.toHaveLength(1);
  });

  test('J-T21 정산 내역 조회는 정산일로 읽어 파트너·수기 정산건·금액을 준다', async () => {
    const t = transport();
    fake.partnerSettlements.set('2026-11-27', [{ partnerId: 'peaket-a', transferId: 'tr-1', settlementAmount: 12_193_000 }]);
    await expect(t.listPartnerSettlements('2026-11-27')).resolves.toEqual([{ partnerId: 'peaket-a', transferId: 'tr-1', amount: 12_193_000 }]);
    await expect(t.listPartnerSettlements('2026-11-30')).resolves.toEqual([]);
    expect(fake.calls('GET /platform/partner-settlements').map((c) => c.query)).toEqual([{ settlementDate: '2026-11-27' }, { settlementDate: '2026-11-30' }]);
  });
});

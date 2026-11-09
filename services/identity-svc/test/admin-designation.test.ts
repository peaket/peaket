// 관리 계정 지정(docs/features/identity.md §6 '관리 계정 지정의 첫 구현', BUILD_ORDER BOT-151, ADR-0171 결정 7).
// 시험: I-T66의 identity 쪽(대상 규칙, 함께 두지 않음, 90일 냉각, 역할 변경·삭제 때 거두기, 조회). 메모리 저장소로 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { AdminAccountInputError, AdminAccountNotFound, ManageAdminAccounts } from '../src/modules/admin/application/manage-admin-accounts.js';

const D = 24 * 60 * 60_000;
const CMD = '0190f3a1-7c2e-7a00-8000-00000000d001';
const CMD2 = '0190f3a1-7c2e-7a00-8000-00000000d002';
const LEAD = '0190f3a1-7c2e-7a00-8000-00000000d003';
const AGENT = '0190f3a1-7c2e-7a00-8000-00000000d004';
const OPR = '0190f3a1-7c2e-7a00-8000-00000000d005';
let n = 0;
const rid = () => `dz-${++n}`;

function harness() {
  const clock = fakeClock({ now: Date.parse('2026-11-05T15:00:00Z') });
  const store = new MemoryAdminAccountStore();
  for (const [id, role, email] of [
    [CMD, 'commander', 'c1@peaket.example'],
    [CMD2, 'commander', 'c2@peaket.example'],
    [LEAD, 'cs_lead', 'lead@peaket.example'],
    [AGENT, 'cs_agent', 'agent@peaket.example'],
    [OPR, 'operator', 'opr@peaket.example'],
  ] as const)
    store.create({ id, role, email, status: 'ACTIVE', now: clock.now() });
  const manage = new ManageAdminAccounts(store, clock);
  const give = (actedBy: string, accountId: string, kind: 'ACCESS_REVIEWER' | 'PSEUDONYM_HANDLER' | 'FRAUD_INVESTIGATOR') => manage.designate({ requestId: rid(), actedBy, accountId, kind, basis: '지정서 2026-11' });
  const take = (actedBy: string, accountId: string, kind: 'ACCESS_REVIEWER' | 'PSEUDONYM_HANDLER' | 'FRAUD_INVESTIGATOR') => manage.revokeDesignation({ requestId: rid(), actedBy, accountId, kind });
  return { clock, store, manage, give, take };
}

describe('지정 주기(I-T66의 identity 쪽)', () => {
  test('I-T66①②③⑥_조사관은cs_lead·commander에게주고_cs_agent·operator는NOT_ELIGIBLE이며_가명정보취급자는commander만이다', async () => {
    const t = harness();
    expect(await t.give(CMD, LEAD, 'FRAUD_INVESTIGATOR')).toMatchObject({ result: 'OK', account: { designations: ['FRAUD_INVESTIGATOR'] } });
    expect((await t.give(CMD, CMD2, 'FRAUD_INVESTIGATOR')).result).toBe('OK');
    expect((await t.give(CMD, AGENT, 'FRAUD_INVESTIGATOR')).result).toBe('DESIGNATION_TARGET_NOT_ELIGIBLE');
    expect((await t.give(CMD, OPR, 'FRAUD_INVESTIGATOR')).result).toBe('DESIGNATION_TARGET_NOT_ELIGIBLE');
    expect((await t.give(CMD, LEAD, 'PSEUDONYM_HANDLER')).result).toBe('DESIGNATION_TARGET_NOT_COMMANDER');
    expect((await t.give(CMD, LEAD, 'FRAUD_INVESTIGATOR')).result).toBe('DESIGNATION_EXISTS');
    expect(await t.manage.designationsOf(LEAD)).toEqual({ kinds: ['FRAUD_INVESTIGATOR'], recentlyRevoked: [] });
  });

  test('I-T66④⑤_조사관과가명정보취급자는함께두지않고_거둔뒤90일안에도다른쪽을주지않는다', async () => {
    const t = harness();
    expect((await t.give(CMD, CMD2, 'PSEUDONYM_HANDLER')).result).toBe('OK');
    expect((await t.give(CMD, CMD2, 'FRAUD_INVESTIGATOR')).result).toBe('DESIGNATION_CONFLICT');
    expect((await t.give(CMD, CMD2, 'ACCESS_REVIEWER')).result).toBe('OK');
    expect((await t.take(CMD, CMD2, 'PSEUDONYM_HANDLER')).result).toBe('OK');
    // 이미 거둔 지정을 다시 거두면 OK
    expect((await t.take(CMD, CMD2, 'PSEUDONYM_HANDLER')).result).toBe('OK');
    t.clock.advance(89 * D);
    expect((await t.give(CMD, CMD2, 'FRAUD_INVESTIGATOR')).result).toBe('DESIGNATION_CONFLICT');
    const seen = await t.manage.designationsOf(CMD2);
    expect(seen).toEqual({ kinds: ['ACCESS_REVIEWER'], recentlyRevoked: [{ kind: 'PSEUDONYM_HANDLER', revokedAt: t.clock.now() - 89 * D }] });
    t.clock.advance(2 * D);
    expect((await t.give(CMD, CMD2, 'FRAUD_INVESTIGATOR')).result).toBe('OK');
    expect((await t.manage.designationsOf(CMD2)).recentlyRevoked).toEqual([]);
  });

  test('요청자는활성commander여야하고_자기계정은SELF_TARGET·없는대상은NOT_FOUND·활성아닌대상은NOT_ELIGIBLE·근거꼴은입력오류다', async () => {
    const t = harness();
    expect((await t.give(OPR, LEAD, 'FRAUD_INVESTIGATOR')).result).toBe('ROLE_NOT_ALLOWED');
    expect((await t.give(CMD, CMD, 'ACCESS_REVIEWER')).result).toBe('SELF_TARGET');
    await expect(t.give(CMD, '0190f3a1-7c2e-7a00-8000-00000000d0ff', 'ACCESS_REVIEWER')).rejects.toBeInstanceOf(AdminAccountNotFound);
    t.store.remove(LEAD);
    expect((await t.give(CMD, LEAD, 'FRAUD_INVESTIGATOR')).result).toBe('DESIGNATION_TARGET_NOT_ELIGIBLE');
    await expect(t.manage.designate({ requestId: rid(), actedBy: CMD, accountId: CMD2, kind: 'ACCESS_REVIEWER', basis: '   ' })).rejects.toBeInstanceOf(AdminAccountInputError);
    await expect(t.manage.designate({ requestId: rid(), actedBy: CMD, accountId: CMD2, kind: 'ACCESS_REVIEWER', basis: 'x'.repeat(201) })).rejects.toBeInstanceOf(AdminAccountInputError);
  });
});

describe('역할 변경·삭제와 함께 거두기', () => {
  test('I-T66⑦_cs_lead를cs_agent로낮추면같은트랜잭션에서조사관지정을거두고_commander를operator로바꾸면모든지정을거두며_삭제도거둔다', async () => {
    const t = harness();
    await t.give(CMD, LEAD, 'FRAUD_INVESTIGATOR');
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: CMD, accountId: LEAD, role: 'cs_agent', expectedVersion: 1 })).account).toMatchObject({ role: 'cs_agent', designations: [] });
    expect((await t.manage.designationsOf(LEAD)).recentlyRevoked).toEqual([{ kind: 'FRAUD_INVESTIGATOR', revokedAt: t.clock.now() }]);
    await t.give(CMD, CMD2, 'ACCESS_REVIEWER');
    await t.give(CMD, CMD2, 'FRAUD_INVESTIGATOR');
    // commander → cs_lead는 조사관만 남는다
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: CMD, accountId: CMD2, role: 'cs_lead', expectedVersion: 1, approvalId: 'appr-9' })).account!.designations).toEqual(['FRAUD_INVESTIGATOR']);
    expect((await t.manage.remove({ requestId: rid(), actedBy: CMD, accountId: CMD2 })).result).toBe('OK');
    expect((await t.manage.designationsOf(CMD2)).kinds).toEqual([]);
  });

  test('재초대로INVITED가된계정은조회에서살아있는지정을돌려주지않는다', async () => {
    const t = harness();
    await t.give(CMD, CMD2, 'ACCESS_REVIEWER');
    expect((await t.manage.reinvite({ requestId: rid(), actedBy: CMD, accountId: CMD2, reason: 'CREDENTIAL_LOST' })).result).toBe('OK');
    expect((await t.manage.designationsOf(CMD2)).kinds).toEqual([]);
    expect(await t.manage.designationsOf('0190f3a1-7c2e-7a00-8000-00000000d0fe')).toEqual({ kinds: [], recentlyRevoked: [] });
  });
});

describe('재검토(2026-11-05)', () => {
  test('자기지정은거둘수있다(openapi DELETE …/designations/{kind}: 자기 지정도 거둘 수 있다)', async () => {
    const t = harness();
    expect((await t.give(CMD2, CMD, 'ACCESS_REVIEWER')).result).toBe('OK');
    expect((await t.take(CMD, CMD, 'ACCESS_REVIEWER')).result).toBe('OK');
    expect((await t.manage.designationsOf(CMD)).kinds).toEqual([]);
  });

  test('활성이아닌대상은종류에맞는422결과다(활성 commander·cs_lead가 아님)', async () => {
    const t = harness();
    t.store.remove(LEAD);
    t.store.remove(CMD2);
    expect((await t.give(CMD, LEAD, 'FRAUD_INVESTIGATOR')).result).toBe('DESIGNATION_TARGET_NOT_ELIGIBLE');
    expect((await t.give(CMD, CMD2, 'ACCESS_REVIEWER')).result).toBe('DESIGNATION_TARGET_NOT_COMMANDER');
  });

  test('I-T66⑤_조사관이있는계정에가명정보취급자는CONFLICT이고_냉각은거둔때부터90일까지다(경계)', async () => {
    const t = harness();
    expect((await t.give(CMD, CMD2, 'FRAUD_INVESTIGATOR')).result).toBe('OK');
    expect((await t.give(CMD, CMD2, 'PSEUDONYM_HANDLER')).result).toBe('DESIGNATION_CONFLICT');
    await t.take(CMD, CMD2, 'FRAUD_INVESTIGATOR');
    t.clock.advance(90 * D - 1);
    expect((await t.give(CMD, CMD2, 'PSEUDONYM_HANDLER')).result).toBe('DESIGNATION_CONFLICT');
    t.clock.advance(1);
    expect((await t.give(CMD, CMD2, 'PSEUDONYM_HANDLER')).result).toBe('OK');
  });

  test('삭제·commander→operator변경은실제로지정을거둔다(거둔 기록이 남는다)', async () => {
    const t = harness();
    await t.give(CMD, CMD2, 'ACCESS_REVIEWER');
    await t.give(CMD, CMD2, 'FRAUD_INVESTIGATOR');
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: CMD, accountId: CMD2, role: 'operator', expectedVersion: 1, approvalId: 'appr-1' })).account!.designations).toEqual([]);
    expect((await t.manage.designationsOf(CMD2)).recentlyRevoked.map((r) => r.kind).sort()).toEqual(['ACCESS_REVIEWER', 'FRAUD_INVESTIGATOR']);
    const c3 = '0190f3a1-7c2e-7a00-8000-00000000d006';
    t.store.create({ id: c3, role: 'cs_lead', email: 'c3@peaket.example', status: 'ACTIVE', now: t.clock.now() });
    await t.give(CMD, c3, 'FRAUD_INVESTIGATOR');
    expect((await t.manage.remove({ requestId: rid(), actedBy: CMD, accountId: c3 })).result).toBe('OK');
    expect((await t.manage.designationsOf(c3)).recentlyRevoked).toEqual([{ kind: 'FRAUD_INVESTIGATOR', revokedAt: t.clock.now() }]);
  });

  test('근거는코드포인트로센다(이모지 200자는 받는다)', async () => {
    const t = harness();
    expect((await t.manage.designate({ requestId: rid(), actedBy: CMD, accountId: CMD2, kind: 'ACCESS_REVIEWER', basis: '📄'.repeat(200) })).result).toBe('OK');
    await expect(t.manage.designate({ requestId: rid(), actedBy: CMD, accountId: CMD2, kind: 'PSEUDONYM_HANDLER', basis: '📄'.repeat(201) })).rejects.toBeInstanceOf(AdminAccountInputError);
  });
});

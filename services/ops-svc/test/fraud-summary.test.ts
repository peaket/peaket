// F-04-19 부정 예매 사건 집계 시험(동결 로컬, LCH-330).
// 정본: docs/features/analytics.md §3.2·§5.2·§6.3·§11(A-T24), docs/features/forensic-replay.md §6.6(FX-T17),
// docs/security/asvs/forensic-replay.md 8.2.3·16.2.5.
// 기준 트리에서는 모듈이 없어 단언으로 실패한다. 파일이 있는데 안쪽 import가 깨지면 오류를 다시 던진다.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const MODULE_PATH = '../src/modules/investigations/domain/fraud-summary.ts';
const EVENT = '0194b240-0000-7000-8000-000000000201';
const OTHER_EVENT = '0194b240-0000-7000-8000-000000000202';
let seq = 0;
const id = () => `0194b240-2000-7000-8000-${String(++seq).padStart(12, '0')}`;

async function load(rel: string): Promise<Record<string, any> | null> {
  const url = new URL(rel, import.meta.url);
  if (!existsSync(fileURLToPath(url))) return null;
  return (await import(/* @vite-ignore */ url.href)) as Record<string, any>;
}
const moduleOf = async () => {
  const mod = await load(MODULE_PATH);
  expect(mod, `${MODULE_PATH}가 아직 없다`).not.toBeNull();
  return mod;
};

const member = (accountId: string, o: Record<string, unknown> = {}) => ({
  accountId,
  ticketCount: 1,
  signals: ['LINK_GRAPH'],
  addedBy: 'SYSTEM',
  removedAtMs: null,
  appealResult: 'NOT_REQUESTED',
  appealDueAtMs: null,
  lockExpiresAtMs: null,
  objectionResult: 'NONE',
  actionNotifiedAtMs: null,
  ...o,
});

const caseOf = (o: Record<string, unknown> = {}) => ({
  caseId: id(),
  eventId: EVENT,
  clusterId: id(),
  status: 'ACTIONED',
  reasonCategory: 'MACRO_BOT',
  assigneeId: id(),
  cancelDeadlineAtMs: 0,
  appealDueAtMs: null,
  approvalId: null,
  investigatorOpinion: null,
  outcomeLabel: null,
  version: 1,
  createdAtMs: 0,
  closedAtMs: 1,
  members: [member(id())],
  events: [],
  ...o,
});

const keys = ['actionedAccounts', 'actionedTickets', 'appealAcceptedAccounts', 'appealRequestedAccounts', 'caseCount', 'eventId', 'objectionAcceptedAccounts', 'reasonCategory'];

describe('F-04-19 부정 예매 사건 집계', () => {
  test('A-T24 ① [ASVS v5.0.0-8.2.3] 사건 셋의 집계가 회차×사유 범주별 수로 나온다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const macro = [
      member(id(), { actionNotifiedAtMs: 10, ticketCount: 4 }),
      member(id(), { appealRequestedAtMs: 5, appealResult: 'ACCEPTED' }),
      ...Array.from({ length: 6 }, () => member(id())),
    ];
    const bypass = [member(id(), { signals: ['POST_MATCH'] }), member(id()), member(id(), { objectionResult: 'ACCEPTED', actionNotifiedAtMs: 20, ticketCount: 2 })];
    const rows = m.fraudSummaryRows([
      caseOf({ members: macro, reasonCategory: 'MACRO_BOT' }),
      caseOf({ members: macro, reasonCategory: 'MACRO_BOT' }),
      caseOf({ members: bypass, reasonCategory: 'QUEUE_BYPASS' }),
    ]);
    const macroRow = rows.find((r: any) => r.reasonCategory === 'MACRO_BOT');
    expect(macroRow).toMatchObject({
      eventId: EVENT,
      caseCount: 2,
      appealRequestedAccounts: 1,
      appealAcceptedAccounts: 1,
      objectionAcceptedAccounts: 0,
      actionedAccounts: 1,
      actionedTickets: 4,
    });
    const other = rows.find((r: any) => r.reasonCategory === 'OTHER');
    expect(other).toMatchObject({
      eventId: EVENT,
      caseCount: 1,
      objectionAcceptedAccounts: 1,
      actionedAccounts: 1,
      actionedTickets: 2,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => Object.keys(r).sort().join(',') === keys.join(','))).toBe(true);
  });

  test('A-T24 ② 계정 3개 칸은 OTHER로 합치고 8개 칸은 그대로 둔다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const big = Array.from({ length: 8 }, (_, n) => member(`big-${n}`, n === 0 ? { actionNotifiedAtMs: 1, ticketCount: 5 } : {}));
    const small = Array.from({ length: 3 }, (_, n) => member(`small-${n}`, n === 0 ? { appealRequestedAtMs: 1, appealResult: 'ACCEPTED' } : {}));
    const rows = m.fraudSummaryRows([
      caseOf({ members: big, reasonCategory: 'MACRO_BOT' }),
      caseOf({ members: small, reasonCategory: 'QUEUE_BYPASS' }),
      caseOf({ members: small, reasonCategory: 'CAPTCHA_BYPASS' }),
    ]);
    expect(rows.map((r: any) => r.reasonCategory)).toEqual(['MACRO_BOT', 'OTHER']);
    expect(rows[0].caseCount).toBe(1);
    expect(rows[0].actionedTickets).toBe(5);
    // 작은 칸 둘을 합쳐도 계정 집합은 합집합으로 다시 센다(같은 계정 3개를 두 번 세지 않는다).
    expect(rows[1].caseCount).toBe(2);
    expect(rows[1].appealRequestedAccounts).toBe(1);
    expect(rows[1].appealAcceptedAccounts).toBe(1);
    expect(rows[1].actionedAccounts).toBe(0);
  });

  test('A-T24 ③ [ASVS v5.0.0-16.2.5] 출력에는 계정·사건 ID·시각 칸이 없고 JSONEachRow도 수만 담는다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const rows = m.fraudSummaryRows([
      caseOf({ members: Array.from({ length: 8 }, () => member(id())), reasonCategory: 'MACRO_BOT' }),
      caseOf({ eventId: OTHER_EVENT, members: Array.from({ length: 5 }, () => member(id())), reasonCategory: 'ACCOUNT_LENDING' }),
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(keys);
      const text = JSON.stringify(row);
      for (const bad of ['accountId', 'caseId', 'clusterId', 'atMs', 'time', 'member', 'deviceRef', 'contactRef']) expect(text, bad).not.toContain(bad);
    }
    const lines = m.fraudSummaryJsonLines(rows);
    expect(lines.endsWith('\n')).toBe(true);
    const parsed = lines.trim().split('\n').map((l: string) => JSON.parse(l));
    expect(parsed).toEqual(rows);
    expect(m.fraudSummaryJsonLines([])).toBe('');
  });

  test('A-T24 ④ 지표 32는 분자·분모를 함께 내고 분모 0이면 null이다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const rows = [
      { eventId: EVENT, reasonCategory: 'MACRO_BOT', caseCount: 1, appealRequestedAccounts: 8, appealAcceptedAccounts: 3, objectionAcceptedAccounts: 0, actionedAccounts: 1, actionedTickets: 2 },
      { eventId: EVENT, reasonCategory: 'OTHER', caseCount: 1, appealRequestedAccounts: 2, appealAcceptedAccounts: 1, objectionAcceptedAccounts: 0, actionedAccounts: 0, actionedTickets: 0 },
    ];
    expect(m.fraudAppealAcceptance(rows)).toEqual({ numerator: 4, denominator: 10, rate: 0.4 });
    expect(m.fraudAppealAcceptance([{ ...rows[0], appealRequestedAccounts: 0, appealAcceptedAccounts: 0 }])).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(m.fraudAppealAcceptance([])).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(m.FRAUD_SUMMARY_MIN_CELL).toBe(5);
  });

  test('FX-T17 ③ 요약은 회차·사유 범주 집계만 넘기고 사람 단위 행을 만들지 않는다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const rows = m.fraudSummaryRows([
      caseOf({ eventId: EVENT, reasonCategory: 'LIMIT_EVASION', members: Array.from({ length: 5 }, () => member(id())) }),
      caseOf({ eventId: OTHER_EVENT, reasonCategory: 'ACCOUNT_LENDING', members: Array.from({ length: 6 }, () => member(id())) }),
    ]);
    expect(rows.map((r: any) => `${r.eventId}/${r.reasonCategory}`)).toEqual([
      `${EVENT}/LIMIT_EVASION`,
      `${OTHER_EVENT}/ACCOUNT_LENDING`,
    ]);
    for (const row of rows) {
      expect(Array.isArray(row.members)).toBe(false);
      expect(row.member).toBeUndefined();
      expect(row.accountId).toBeUndefined();
      expect(row.caseId).toBeUndefined();
    }
  });
});

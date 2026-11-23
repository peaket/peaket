// F-01-7 A2·A3: 저장소 Alertmanager 설정의 경로별 묶기·억제·OpsApprovalPending 경로와 '런북 없음' 문구를
// 실제 Alertmanager(Docker)와 가짜 수신기로 본다(V-T54 ③④⑤⑥, docs/verification.md:648, docs/observability.md:432~442·:355~357).
// 계획 docs/review/plans/F-01-7.md §6. F-01-6의 도우미(alertmanager.ts)를 그대로 쓴다(고치지 않는다).
// 기다림은 수신기가 기대한 것을 받을 때까지 다시 보는 것이다(고정 대기 없음, 상한 2분). 묶음 대기 5초는 [가정]이라 단언하지 않는다.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { closeReceivers, namesAt, pushAlerts, secretsFor, startAlertmanager, startReceivers, type Alertmanager, type Receivers } from './alertmanager.js';
import { until } from './observability-stores.js';

const T = 180_000;
const WAIT = 120_000;

let rcv: Receivers | undefined;
let am: Alertmanager | undefined;

beforeAll(async () => {
  rcv = await startReceivers();
  am = await startAlertmanager({ secrets: secretsFor(rcv) });
}, 240_000);

afterAll(async () => {
  am?.stop();
  await closeReceivers(rcv);
});

/** Slack 수신기가 받은 몸 가운데 candidates의 이름이 든 것(한 몸에 여럿이 들 수 있다) */
function slackMessages(candidates: readonly string[]) {
  return rcv!['slack-ops'].received.filter((m) => candidates.some((c) => m.raw.includes(c)));
}

/** 한 몸에 든 후보 이름들(정렬) */
const namesIn = (raw: string, candidates: readonly string[]) => candidates.filter((c) => raw.includes(c)).sort();

/** Alertmanager /api/v2/alerts의 경보 하나 */
interface AmAlert {
  labels: Record<string, string>;
  fingerprint: string;
  status: { state: string; inhibitedBy: string[] | null };
}

async function alerts(): Promise<AmAlert[]> {
  const res = await fetch(`${am!.url}/api/v2/alerts`);
  expect(res.status).toBe(200);
  return (await res.json()) as AmAlert[];
}

const annotations = (name: string) => ({ summary: `${name} 요약`, runbook_url: `https://runbooks.peaket.test/${name}`, dashboard_url: `https://grafana.peaket.test/d/${name}` });

test(
  'V-T54 ③ 같은 회차·여정의 온세일 경보는 한 알림으로, 다른 회차는 따로 온다',
  async () => {
    const A = 'VtfiveFourGroupOnsaleSlow';
    const B = 'VtfiveFourGroupPaymentCause';
    const C = 'VtfiveFourGroupOtherEvent';
    const F1 = 'VtfiveFourGroupFlowOne';
    const F2 = 'VtfiveFourGroupFlowTwo';
    const names = [A, B, C, F1, F2] as const;
    expect(
      await pushAlerts(am!, [
        { labels: { alertname: A, severity: 'sev2', kind: 'slo', event_id: 'e1', journey: 'hold' }, annotations: annotations(A) },
        { labels: { alertname: B, severity: 'sev2', kind: 'slo', event_id: 'e1', journey: 'hold' }, annotations: annotations(B) },
        { labels: { alertname: C, severity: 'sev2', kind: 'slo', event_id: 'e2', journey: 'hold' }, annotations: annotations(C) },
        { labels: { alertname: F1, severity: 'sev2', kind: 'flow' }, annotations: annotations(F1) },
        { labels: { alertname: F2, severity: 'sev2', kind: 'flow' }, annotations: annotations(F2) },
      ]),
    ).toBe(5);
    await until('Slack에 세 묶음 도착', WAIT, async () => slackMessages(names).map((m) => namesIn(m.raw, names)), (groups) => groups.length >= 3, { id: am!.id, url: () => am!.url, logs: am!.logs, stop: am!.stop });

    const groups = slackMessages(names)
      .map((m) => namesIn(m.raw, names))
      .filter((g) => g.length > 0)
      .sort((a, b) => a.join(',').localeCompare(b.join(',')));
    // 같은 회차·여정(e1/hold) 둘은 한 몸, 다른 회차(e2)는 따로, 회차 라벨 없는 flow 둘은 한 몸
    expect(groups).toEqual([[A, B], [C], [F1, F2]]);
    // 같은 회차·여정의 둘이 서로 다른 몸으로 새지 않는다
    expect(groups.filter((g) => g.includes(A))).toHaveLength(1);
    expect(groups.find((g) => g.includes(A))).toEqual([A, B]);
  },
  T,
);

test(
  'V-T54 ④ 예산 SEV1은 같은 회차·여정의 SEV2만 누르고 눌린 경보는 목록에 남는다',
  async () => {
    const BURN = 'VtfiveFourBudgetBurn';
    const INHIBITED = 'VtfiveFourInhibitedSevTwo';
    const OTHER_EVENT = 'VtfiveFourOtherEventSevTwo';
    const OTHER_JOURNEY = 'VtfiveFourOtherJourneySevTwo';
    expect(
      await pushAlerts(am!, [
        { labels: { alertname: BURN, severity: 'sev1', kind: 'slo', event_id: 'e1', journey: 'hold' }, annotations: annotations(BURN) },
        { labels: { alertname: INHIBITED, severity: 'sev2', kind: 'slo', event_id: 'e1', journey: 'hold' }, annotations: annotations(INHIBITED) },
        { labels: { alertname: OTHER_EVENT, severity: 'sev2', kind: 'slo', event_id: 'e2', journey: 'hold' }, annotations: annotations(OTHER_EVENT) },
        { labels: { alertname: OTHER_JOURNEY, severity: 'sev2', kind: 'slo', event_id: 'e1', journey: 'payment_accept' }, annotations: annotations(OTHER_JOURNEY) },
      ]),
    ).toBe(4);
    // 눌리지 않는 SEV2 둘이 Slack에 닿을 때까지 기다린다(고정 대기 없음)
    await until(
      '다른 회차·여정의 SEV2 도착',
      WAIT,
      async () => namesAt(rcv!['slack-ops'], [OTHER_EVENT, OTHER_JOURNEY]),
      (got) => got.includes(OTHER_EVENT) && got.includes(OTHER_JOURNEY),
      { id: am!.id, url: () => am!.url, logs: am!.logs, stop: am!.stop },
    );
    // 눌린 SEV2는 Slack에 0건이고, 경보 목록에는 suppressed·inhibitedBy=SEV1 지문으로 남는다
    const list = await alerts();
    const source = list.find((a) => a.labels.alertname === BURN);
    const suppressed = list.find((a) => a.labels.alertname === INHIBITED);
    expect(source).toBeDefined();
    expect(suppressed).toBeDefined();
    expect(suppressed!.status.state).toBe('suppressed');
    expect(suppressed!.status.inhibitedBy ?? []).toContain(source!.fingerprint);
    expect(namesAt(rcv!['slack-ops'], [INHIBITED])).toEqual([]);

    // 회차·여정 라벨이 없는 SEV1은 라벨 없는 SEV2를 누르지 않는다(빈 라벨끼리 같다고 보는 함정)
    const PLAIN_BURN = 'VtfiveFourPlainBudgetBurn';
    const PLAIN_SEV2 = 'VtfiveFourPlainSevTwo';
    expect(
      await pushAlerts(am!, [
        { labels: { alertname: PLAIN_BURN, severity: 'sev1', kind: 'slo' }, annotations: annotations(PLAIN_BURN) },
        { labels: { alertname: PLAIN_SEV2, severity: 'sev2', kind: 'slo' }, annotations: annotations(PLAIN_SEV2) },
      ]),
    ).toBe(2);
    await until('라벨 없는 SEV2 도착', WAIT, async () => namesAt(rcv!['slack-ops'], [PLAIN_SEV2]), (got) => got.includes(PLAIN_SEV2), { id: am!.id, url: () => am!.url, logs: am!.logs, stop: am!.stop });
  },
  T,
);

test(
  'V-T54 ⑤ 런북 주석이 빈 경보도 그대로 가고 문구에 런북 없음이 붙는다',
  async () => {
    const EMPTY = 'VtfiveFourNoRunbook';
    const SET = 'VtfiveFourWithRunbook';
    const RUNBOOK = 'https://runbooks.peaket.test/vt54-with-runbook';
    expect(
      await pushAlerts(am!, [
        { labels: { alertname: EMPTY, severity: 'sev2', kind: 'slo', event_id: 'e5', journey: 'hold' }, annotations: { summary: `${EMPTY} 요약` } },
        { labels: { alertname: SET, severity: 'sev2', kind: 'slo', event_id: 'e6', journey: 'hold' }, annotations: { summary: `${SET} 요약`, runbook_url: RUNBOOK } },
      ]),
    ).toBe(2);
    await until(
      '런북 빈 경보와 있는 경보 도착',
      WAIT,
      async () => ({ empty: namesAt(rcv!['slack-ops'], [EMPTY]), set: namesAt(rcv!['slack-ops'], [SET]) }),
      (s) => s.empty.includes(EMPTY) && s.set.includes(SET),
      { id: am!.id, url: () => am!.url, logs: am!.logs, stop: am!.stop },
    );
    const emptyBody = slackMessages([EMPTY]).map((m) => m.raw).join('\n');
    const setBody = slackMessages([SET]).map((m) => m.raw).join('\n');
    expect(emptyBody).toContain('런북 없음');
    expect(emptyBody).not.toContain(RUNBOOK);
    expect(setBody).toContain(RUNBOOK);
    expect(setBody).not.toContain('런북 없음');
  },
  T,
);

test(
  'V-T54 ⑥ OpsApprovalPending은 온콜 호출로만 간다',
  async () => {
    const APPROVAL = 'OpsApprovalPending';
    const COMPANION = 'VtfiveFourApprovalCompanion';
    expect(
      await pushAlerts(am!, [
        { labels: { alertname: APPROVAL, severity: 'none', kind: 'control' }, annotations: { summary: '2인 승인 대기' } },
        { labels: { alertname: COMPANION, severity: 'sev2', kind: 'slo', event_id: 'e7', journey: 'hold' }, annotations: annotations(COMPANION) },
      ]),
    ).toBe(2);
    await until(
      '승인 대기는 IRM, 짝 SEV2는 Slack',
      WAIT,
      async () => ({ irm: namesAt(rcv!['irm-oncall'], [APPROVAL]), slack: namesAt(rcv!['slack-ops'], [COMPANION]) }),
      (s) => s.irm.includes(APPROVAL) && s.slack.includes(COMPANION),
      { id: am!.id, url: () => am!.url, logs: am!.logs, stop: am!.stop },
    );
    // 같은 때 넣은 SEV2가 Slack에 닿은 뒤에도 승인 대기는 다른 받는 곳에 0건
    expect(namesAt(rcv!['irm-oncall'], [APPROVAL])).toEqual([APPROVAL]);
    expect(namesAt(rcv!['slack-ops'], [APPROVAL])).toEqual([]);
    expect(namesAt(rcv!['github-issues'], [APPROVAL])).toEqual([]);
    expect(namesAt(rcv!['evidence-collector'], [APPROVAL])).toEqual([]);
  },
  T,
);

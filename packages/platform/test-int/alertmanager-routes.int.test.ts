// 경보 보내는 길: 받는 곳별 경로와 Slack 문구 가림(V-T53 ①⑤, docs/verification.md V-T53, docs/observability.md §5 '경보 보내는 길'·심각도별 채널 표,
// ADR-0032, ADR-0139 결정 4). 계획 docs/review/plans/F-01-6.md §6.
// 저장소의 Alertmanager 설정·문구 틀을 실제 Alertmanager(Docker)에 싣고, 받는 곳 다섯을 이 프로세스의 가짜 수신기로 둔다(바깥 계정 없음).
// 경보는 Alertmanager API v2로 넣고, 받는 곳마다 '와야 할 것'과 '오면 안 되는 것 0건'을 정확한 집합으로 본다.
// 기다림은 수신기가 기대한 것을 받을 때까지 다시 보는 것이다(고정 대기 없음, 상한 2분). 묶음 대기 같은 [가정] 시간 값은 단언하지 않는다.
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  closeReceivers,
  EVIDENCE_TOKEN,
  namesAt,
  pushAlerts,
  receiversByAlert,
  RECEIVERS,
  RELAY_TOKEN,
  secretsFor,
  startAlertmanager,
  startReceivers,
  webhookAlertNames,
  type Alertmanager,
  type Receivers,
} from './alertmanager.js';
import { until } from './observability-stores.js';

const T = 180_000;
const WAIT = 120_000;

// V-T53 ①의 경보 여섯(이름은 서로의 부분 글이 아니게 골랐다: Slack은 원문에 든 이름 글로 센다)
const SEV1 = 'VtfiveThreeSevOnePage';
const SEV2_CAUSE = 'VtfiveThreeSevTwoCause';
const SEV2_SLO = 'VtfiveThreeSevTwoBudget';
const SEV3 = 'VtfiveThreeSevThreeTicket';
const NO_SEV = 'VtfiveThreeNoSeverity';
const UNKNOWN_SEV = 'VtfiveThreeUnknownSeverity';
const ROUTE_ALERTS = [SEV1, SEV2_CAUSE, SEV2_SLO, SEV3, NO_SEV, UNKNOWN_SEV] as const;

// V-T53 ⑤: 목록 밖 라벨·description 주석에 넣는 이용자 식별값 꼴(정본 V-T53 ⑤: 이메일·전화번호·계정 ID)
const PII_SLACK = 'VtfiveThreePiiSlack';
const ACCOUNT_ID = 'acct-7f3a';
const EMAIL = 'kim@example.com';
const PHONE = '010-1234-5678';
const DESCRIPTION_MARK = 'vt53-description-mark-4e1b';
const SUMMARY = 'vt53 summary 9c2d payment latency';

const annotations = (name: string) => ({
  summary: `${name} summary`,
  runbook_url: `https://runbooks.peaket.test/${name}`,
  dashboard_url: `https://grafana.peaket.test/d/${name}`,
});

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

test(
  'V-T53 ① 경보가 심각도대로 IRM·Slack·티켓·증거 수집기로 간다',
  async () => {
    const r = rcv!;
    const pushed = await pushAlerts(am!, [
      { labels: { alertname: SEV1, severity: 'sev1', kind: 'budget' }, annotations: annotations(SEV1) },
      { labels: { alertname: SEV2_CAUSE, severity: 'sev2', kind: 'cause', dependency: 'orders-db' }, annotations: annotations(SEV2_CAUSE) },
      { labels: { alertname: SEV2_SLO, severity: 'sev2', kind: 'slo' }, annotations: annotations(SEV2_SLO) },
      { labels: { alertname: SEV3, severity: 'sev3', kind: 'hygiene' }, annotations: annotations(SEV3) },
      { labels: { alertname: NO_SEV, kind: 'flow' }, annotations: annotations(NO_SEV) },
      { labels: { alertname: UNKNOWN_SEV, severity: 'sev9', kind: 'flow' }, annotations: annotations(UNKNOWN_SEV) },
    ]);
    expect(pushed).toBe(6);

    // 정본(V-T53 ①, observability.md §5 경로): SEV1 → IRM·Slack, SEV2 → Slack, SEV3 → 티켓, 심각도 없음·모르는 값 → Slack,
    // 증거 수집기 → SEV1과 kind cause인 SEV2
    const expected: Record<string, string[]> = {
      'irm-oncall': [SEV1],
      'slack-ops': [NO_SEV, SEV1, SEV2_SLO, SEV2_CAUSE, UNKNOWN_SEV].sort(),
      'github-issues': [SEV3],
      'evidence-collector': [SEV1, SEV2_CAUSE].sort(),
      deadman: [],
    };
    const snapshot = () => Object.fromEntries(RECEIVERS.map((n) => [n, namesAt(r[n], ROUTE_ALERTS)]));
    const covered = (s: Record<string, string[]>) => Object.entries(expected).every(([n, want]) => want.every((w) => s[n]!.includes(w)));
    await until('받는 곳마다 기대한 경보 도착', WAIT, async () => snapshot(), covered, { id: am!.id, url: () => am!.url, logs: am!.logs, stop: am!.stop });

    // 받는 곳마다 정확히 같은 집합(오면 안 되는 것 0건)
    expect(snapshot()).toEqual(expected);
    // 넣은 경보가 실제로 나갔다(빈 수신이 통과로 새지 않게)
    for (const n of ['irm-oncall', 'slack-ops', 'github-issues', 'evidence-collector'] as const) expect(r[n].received.length).toBeGreaterThan(0);
    expect(r.deadman.received).toEqual([]);

    // Alertmanager가 묶음마다 고른 받는 곳도 같다(continue 경로 포함)
    const byAlert = await receiversByAlert(am!);
    expect(Object.fromEntries(ROUTE_ALERTS.map((a) => [a, byAlert[a]]))).toEqual({
      [SEV1]: ['evidence-collector', 'irm-oncall', 'slack-ops'],
      [SEV2_CAUSE]: ['evidence-collector', 'slack-ops'],
      [SEV2_SLO]: ['slack-ops'],
      [SEV3]: ['github-issues'],
      [NO_SEV]: ['slack-ops'],
      [UNKNOWN_SEV]: ['slack-ops'],
    });

    // 티켓 중계·증거 수집기 요청은 그 토큰 파일 값을 Bearer로 싣는다. 토큰을 서로 섞지 않는다
    expect([...new Set(r['github-issues'].received.map((x) => x.authorization))]).toEqual([`Bearer ${RELAY_TOKEN}`]);
    expect([...new Set(r['evidence-collector'].received.map((x) => x.authorization))]).toEqual([`Bearer ${EVIDENCE_TOKEN}`]);
    for (const n of ['irm-oncall', 'slack-ops'] as const) {
      for (const x of r[n].received) {
        expect(x.raw).not.toContain(RELAY_TOKEN);
        expect(x.raw).not.toContain(EVIDENCE_TOKEN);
        expect(x.authorization ?? '').not.toContain(RELAY_TOKEN);
        expect(x.authorization ?? '').not.toContain(EVIDENCE_TOKEN);
      }
    }
    // 웹훅 받는 곳은 Alertmanager 웹훅 판 4 몸을 받는다
    for (const n of ['irm-oncall', 'github-issues', 'evidence-collector'] as const) for (const x of r[n].received) expect(() => webhookAlertNames(x)).not.toThrow();
  },
  T,
);

test(
  'V-T53 ⑤ [ASVS v5.0.0-14.2.3] Slack 문구에 이용자 식별값이 없다',
  async () => {
    const slack = rcv!['slack-ops'];
    expect(
      await pushAlerts(am!, [
        {
          labels: { alertname: PII_SLACK, severity: 'sev2', kind: 'slo', account_id: ACCOUNT_ID },
          annotations: {
            summary: SUMMARY,
            description: `${DESCRIPTION_MARK} 문의자 ${EMAIL} 연락처 ${PHONE}`,
            runbook_url: `https://runbooks.peaket.test/${PII_SLACK}`,
            dashboard_url: `https://grafana.peaket.test/d/${PII_SLACK}`,
          },
        },
      ]),
    ).toBe(1);

    const mine = () => slack.received.filter((x) => x.raw.includes(PII_SLACK));
    await until('Slack 문구 도착', WAIT, async () => mine().length, (n) => n > 0, { id: am!.id, url: () => am!.url, logs: am!.logs, stop: am!.stop });

    const raw = mine()
      .map((x) => x.raw)
      .join('\n');
    // 싣는 칸(summary)은 있다: 빈 문구가 통과로 새지 않게
    expect(raw).toContain(SUMMARY);
    // 목록 밖 라벨 값, description 주석(표지와 안의 값)은 원문 어디에도 없다
    expect(raw).not.toContain(ACCOUNT_ID);
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain(PHONE);
    expect(raw).not.toContain(DESCRIPTION_MARK);
    // 목록 밖 라벨 이름도 싣지 않는다(라벨 전부를 늘어놓는 문구가 아니다)
    expect(raw).not.toContain('account_id');
  },
  T,
);

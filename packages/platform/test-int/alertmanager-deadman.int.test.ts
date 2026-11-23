// 데드맨: 늘 울리는 규칙 Watchdog이 데드맨 핑으로만 간다(V-T53 ②, docs/verification.md V-T53, docs/observability.md §5 '경보 보내는 길' 데드맨·§10 데드맨 스위치).
// 계획 docs/review/plans/F-01-6.md §6.
// Docker 네트워크 하나에 저장소 규칙 rules/watchdog.yaml의 spec을 규칙 파일로 실은 실제 Prometheus와, 저장소 설정의 실제 Alertmanager를 띄운다.
// Prometheus가 규칙을 평가해 Alertmanager로 보내고, Alertmanager가 받는 곳 다섯(이 프로세스의 가짜 수신기)으로 나눈다.
// Healthchecks가 '핑 두 번 빠지면 울림'을 보는 것은 바깥 서비스 몫이라 보지 않는다(G-11). 핑 주기 1분은 [가정]이라 단언하지 않는다.
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  ALERTMANAGER_ALIAS,
  closeReceivers,
  namesAt,
  pushAlerts,
  receiversByAlert,
  secretsFor,
  startAlertmanager,
  startReceivers,
  webhookAlertNames,
  type Alertmanager,
  type Receivers,
} from './alertmanager.js';
import { createNetwork, parseYaml, PROMETHEUS_IMAGE, readRepo, startContainer, stringifyYaml, until, type Container, type Network } from './observability-stores.js';

const WATCHDOG = 'Watchdog';
const SEV1 = 'VtfiveThreeDeadmanSevOne';

let net: Network | undefined;
let rcv: Receivers | undefined;
let am: Alertmanager | undefined;
let prom: Container | undefined;

beforeAll(async () => {
  // 저장소 규칙(PrometheusRule)의 spec을 Prometheus 규칙 파일로 바꾼다. 없으면 여기서 던진다(구현 전 트리의 실패)
  const rule = parseYaml(readRepo('deploy/platform/observability/rules/watchdog.yaml')) as { kind?: string; spec?: { groups?: unknown[] } };
  if (rule.kind !== 'PrometheusRule' || !Array.isArray(rule.spec?.groups)) throw new Error('rules/watchdog.yaml은 spec.groups가 있는 PrometheusRule이어야 한다');
  net = createNetwork();
  rcv = await startReceivers();
  am = await startAlertmanager({ secrets: secretsFor(rcv), network: net });
  // 전역 평가 간격은 저장소 묶음 간격(30초)과 다른 값으로 둔다: 묶음의 interval이 실제로 읽혔는지 /api/v1/rules로 본다
  const promConfig = [
    'global:',
    '  scrape_interval: 1m',
    '  evaluation_interval: 1m',
    'rule_files: [/etc/peaket-watchdog.rules.yml]',
    'alerting:',
    '  alertmanagers:',
    `    - static_configs: [{ targets: ['${ALERTMANAGER_ALIAS}:9093'] }]`,
    '',
  ].join('\n');
  prom = startContainer({
    image: PROMETHEUS_IMAGE,
    network: net,
    ports: [9090],
    files: { '/etc/peaket-prom.yml': promConfig, '/etc/peaket-watchdog.rules.yml': stringifyYaml({ groups: rule.spec.groups }) },
    args: ['--config.file=/etc/peaket-prom.yml', '--storage.tsdb.path=/prometheus'],
  });
  await until('Prometheus 준비', 120_000, async () => (await fetch(`${prom!.url(9090)}/-/ready`)).status, (s) => s === 200, prom);
}, 300_000);
afterAll(async () => {
  prom?.stop();
  am?.stop();
  await closeReceivers(rcv);
  net?.remove();
});

test(
  'V-T53 ② Watchdog은 데드맨 핑으로만 간다',
  async () => {
    const r = rcv!;

    // Prometheus가 저장소 규칙을 그대로 읽었다: 묶음 watchdog, 평가 간격 30초(observability.md §4 '그 밖의 규칙 평가 간격'),
    // 경보 Watchdog 하나, 라벨 severity none·kind control(§5 데드맨)
    const rules = (await (await fetch(`${prom!.url(9090)}/api/v1/rules`)).json()) as {
      data: { groups: Array<{ name: string; interval: number; rules: Array<{ name: string; type: string; labels: Record<string, string> }> }> };
    };
    const groups = rules.data.groups.map((g) => ({ name: g.name, interval: g.interval, rules: g.rules.map((x) => ({ name: x.name, type: x.type, severity: x.labels.severity, kind: x.labels.kind })) }));
    expect(groups).toEqual([{ name: 'watchdog', interval: 30, rules: [{ name: WATCHDOG, type: 'alerting', severity: 'none', kind: 'control' }] }]);

    // 같은 Alertmanager에 SEV1 하나: 데드맨으로 새지 않는지 본다
    expect(await pushAlerts(am!, [{ labels: { alertname: SEV1, severity: 'sev1', kind: 'budget' }, annotations: { summary: `${SEV1} summary` } }])).toBe(1);

    const names = [WATCHDOG, SEV1] as const;
    const amAsContainer = { id: am!.id, url: () => am!.url, logs: () => `${am!.logs()}\n--- Prometheus ---\n${prom!.logs()}`, stop: am!.stop };
    await until(
      '데드맨에 Watchdog, Slack에 SEV1 도착',
      120_000,
      async () => ({ deadman: namesAt(r.deadman, names), slack: namesAt(r['slack-ops'], names) }),
      (s) => s.deadman.includes(WATCHDOG) && s.slack.includes(SEV1),
      amAsContainer,
    );

    // 데드맨 수신기: 받은 몸이 하나 이상이고, 몸에 든 경보는 모두 Watchdog이다
    expect(r.deadman.received.length).toBeGreaterThan(0);
    const deadmanAlerts = r.deadman.received.flatMap(webhookAlertNames);
    expect(deadmanAlerts.length).toBeGreaterThan(0);
    expect([...new Set(deadmanAlerts)]).toEqual([WATCHDOG]);

    // 그 밖의 받는 곳에는 Watchdog이 하나도 가지 않는다(Slack은 원문 글, 웹훅은 몸의 경보)
    for (const n of ['irm-oncall', 'github-issues', 'evidence-collector'] as const) expect(r[n].received.flatMap(webhookAlertNames)).not.toContain(WATCHDOG);
    for (const x of r['slack-ops'].received) expect(x.raw).not.toContain(WATCHDOG);
    // SEV1은 데드맨으로 가지 않고 Slack에 간다
    expect(namesAt(r.deadman, [SEV1])).toEqual([]);
    expect(namesAt(r['slack-ops'], [SEV1])).toEqual([SEV1]);

    // Alertmanager가 고른 받는 곳: Watchdog은 데드맨 하나뿐
    const byAlert = await receiversByAlert(am!);
    expect(byAlert[WATCHDOG]).toEqual(['deadman']);
    expect(byAlert[SEV1]).not.toContain('deadman');
  },
  240_000,
);

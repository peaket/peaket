// 경보 보내는 길 통합 시험 도우미(V-T53 ①②⑤, 계획 docs/review/plans/F-01-6.md §5·§6). observability-stores.ts와 같은 방식(라이브러리 없이 docker 명령).
// 설정은 저장소 원천을 그대로 쓴다: deploy/platform/observability/alertmanager/alertmanager.yaml과 templates/peaket.tmpl.
// 비밀 파일 일곱(docs/observability.md §5 '경보 보내는 길', 계획 §3 '받는 곳과 비밀')에는 시험 안 가짜 수신기 주소와 시험 토큰을 넣는다.
// 실제 바깥 계정(IRM·Slack·Healthchecks·GitHub)은 쓰지 않는다. 받는 곳은 모두 이 프로세스의 node:http 수신기다.
// 파일은 docker create → docker cp → docker start로 넣는다(Windows에서 붙인 폴더 경로가 바뀌는 문제를 피한다, F-01-4 꼴).
// 정리는 이 도우미가 띄운 컨테이너 ID만 지운다(docker rm -f -v <id>).
// Alertmanager 이미지는 판과 다이제스트로 고정한다(2026-11-23 Docker Hub prom/alertmanager 태그 v0.35.0의 목록 다이제스트).
// 구현 담당은 같은 값을 deploy/platform/observability/alertmanager/README.md에 적는다(계획 §4 A1).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepo, until, type Network } from './observability-stores.js';

export const ALERTMANAGER_IMAGE = 'prom/alertmanager:v0.35.0@sha256:e638797febd034838eca8b98cdbd46f951e9bf7f178777aa8669167406a9946c';
/** Prometheus가 경보를 보내는 Alertmanager의 네트워크 별칭(V-T53 ②) */
export const ALERTMANAGER_ALIAS = 'peaket-am';

/** 받는 곳 다섯(docs/observability.md §5 '경보 보내는 길' 받는 곳 다섯) */
export const RECEIVERS = ['irm-oncall', 'slack-ops', 'github-issues', 'deadman', 'evidence-collector'] as const;
export type ReceiverName = (typeof RECEIVERS)[number];

/** 비밀 파일 일곱의 이름(계획 §3 '받는 곳과 비밀'). 컨테이너 안 /etc/alertmanager/secrets/<이름> */
export const SECRET_FILES = [
  'irm-oncall-url',
  'slack-ops-url',
  'alert-issue-relay-url',
  'alert-issue-relay-token',
  'healthchecks-ping-url',
  'evidence-collector-url',
  'evidence-collector-token',
] as const;

/** 시험 토큰(이 값이 그 받는 곳 요청의 Authorization에 실려야 한다) */
export const RELAY_TOKEN = 'vt53-relay-6b1f0e2a9c47d385';
export const EVIDENCE_TOKEN = 'vt53-evidence-2d8a51c7e0f94b36';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
const quiet = (args: string[]) => {
  try {
    docker(args);
  } catch {
    // 이미 없다
  }
};

export interface Received {
  path: string;
  authorization: string | undefined;
  headers: IncomingHttpHeaders;
  /** 받은 몸의 원문(바이트를 UTF-8로 읽은 글). 값 찾기는 분해한 칸이 아니라 이 원문에서 한다 */
  raw: string;
}

export interface FakeReceiver {
  name: ReceiverName;
  /** 컨테이너에서 닿는 주소 */
  containerUrl: string;
  received: Received[];
  close(): Promise<void>;
}

// 컨테이너 안에서 host.docker.internal(= --add-host host-gateway)로 닿게 붙인다. Linux(CI)에서는 다리 주소로 오므로 0.0.0.0,
// Docker Desktop(Windows·macOS)은 127.0.0.1로도 닿는다(tools/web-checks/lib/serve.mjs와 같은 판단)
const BIND = process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1';

/** 받는 곳 하나의 가짜 수신기: 몸을 모두 모으고 200 ok로 답한다(Slack 수신 웹훅도 200 'ok'로 답한다) */
export async function startReceiver(name: ReceiverName): Promise<FakeReceiver> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', authorization: req.headers.authorization, headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, BIND, r));
  const port = (server.address() as AddressInfo).port;
  return {
    name,
    containerUrl: `http://host.docker.internal:${port}/${name}`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type Receivers = Record<ReceiverName, FakeReceiver>;
export async function startReceivers(): Promise<Receivers> {
  const out = {} as Receivers;
  for (const n of RECEIVERS) out[n] = await startReceiver(n);
  return out;
}
export const closeReceivers = async (r: Partial<Receivers> | undefined) => {
  for (const x of Object.values(r ?? {})) await x?.close();
};

/** 받는 곳 → 비밀 파일 값(주소는 가짜 수신기, 토큰은 시험 토큰) */
export function secretsFor(r: Receivers): Record<(typeof SECRET_FILES)[number], string> {
  return {
    'irm-oncall-url': r['irm-oncall'].containerUrl,
    'slack-ops-url': r['slack-ops'].containerUrl,
    'alert-issue-relay-url': r['github-issues'].containerUrl,
    'alert-issue-relay-token': RELAY_TOKEN,
    'healthchecks-ping-url': r.deadman.containerUrl,
    'evidence-collector-url': r['evidence-collector'].containerUrl,
    'evidence-collector-token': EVIDENCE_TOKEN,
  };
}

export interface Alertmanager {
  id: string;
  url: string;
  logs(): string;
  stop(): void;
}

/**
 * 저장소 설정으로 Alertmanager를 띄운다(HTTP 9093). 설정·문구 틀·비밀 파일을 컨테이너의 /etc/alertmanager 아래에 넣는다.
 * 저장소에 설정 파일이 없으면 여기서 던진다(구현 전 트리의 실패)
 */
export async function startAlertmanager(o: { secrets: Record<string, string>; network?: Network }): Promise<Alertmanager> {
  const config = readRepo('deploy/platform/observability/alertmanager/alertmanager.yaml');
  const template = readRepo('deploy/platform/observability/alertmanager/templates/peaket.tmpl');
  const net = o.network ? ['--network', o.network.name, '--network-alias', ALERTMANAGER_ALIAS] : [];
  const id = docker([
    'create',
    '--add-host=host.docker.internal:host-gateway',
    ...net,
    '-p',
    '127.0.0.1::9093',
    ALERTMANAGER_IMAGE,
    '--config.file=/etc/alertmanager/alertmanager.yml',
    '--storage.path=/alertmanager',
    // 한 대만 띄운다(무리 짓기 끔)
    '--cluster.listen-address=',
  ]);
  const stop = () => quiet(['rm', '-f', '-v', id]);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'peaket-am-it-'));
    try {
      writeFileSync(join(dir, 'alertmanager.yml'), config);
      mkdirSync(join(dir, 'templates'));
      writeFileSync(join(dir, 'templates', 'peaket.tmpl'), template);
      mkdirSync(join(dir, 'secrets'));
      for (const [name, value] of Object.entries(o.secrets)) writeFileSync(join(dir, 'secrets', name), value);
      docker(['cp', join(dir, 'alertmanager.yml'), `${id}:/etc/alertmanager/alertmanager.yml`]);
      // 없는 대상 폴더로 폴더를 넣으면 그 이름으로 만들고 안의 파일을 넣는다(docker cp 규칙)
      docker(['cp', join(dir, 'templates'), `${id}:/etc/alertmanager/templates`]);
      docker(['cp', join(dir, 'secrets'), `${id}:/etc/alertmanager/secrets`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    docker(['start', id]);
  } catch (err) {
    stop();
    throw err;
  }
  const line = docker(['port', id, '9093/tcp']).split('\n')[0]!;
  const am: Alertmanager = {
    id,
    url: `http://127.0.0.1:${Number(line.slice(line.lastIndexOf(':') + 1))}`,
    logs: () => {
      const r = spawnSync('docker', ['logs', '--tail', '80', id], { encoding: 'utf8', timeout: 30_000 });
      return `${r.stdout}${r.stderr}`;
    },
    stop,
  };
  try {
    await until('Alertmanager 준비', 120_000, async () => (await fetch(`${am.url}/-/ready`)).status, (s) => s === 200, { id, url: () => am.url, logs: am.logs, stop });
  } catch (err) {
    stop();
    throw err;
  }
  return am;
}

export interface PushAlert {
  labels: Record<string, string>;
  annotations?: Record<string, string>;
}

/** Alertmanager API v2로 발생 경보를 넣는다(넣은 수를 돌려준다). 200이 아니면 던진다 */
export async function pushAlerts(am: Alertmanager, alerts: PushAlert[]): Promise<number> {
  const res = await fetch(`${am.url}/api/v2/alerts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(alerts.map((a) => ({ labels: a.labels, annotations: a.annotations ?? {} }))),
  });
  if (res.status !== 200) throw new Error(`경보 넣기 ${res.status}: ${await res.text()}`);
  return alerts.length;
}

/** Alertmanager가 지금 가진 묶음에서 경보 이름 → 그 경보가 든 받는 곳 이름들(정렬) */
export async function receiversByAlert(am: Alertmanager): Promise<Record<string, string[]>> {
  const res = await fetch(`${am.url}/api/v2/alerts/groups`);
  const groups = (await res.json()) as Array<{ receiver: { name: string }; alerts: Array<{ labels: Record<string, string> }> }>;
  const out: Record<string, Set<string>> = {};
  for (const g of groups) for (const a of g.alerts) (out[a.labels.alertname ?? ''] ??= new Set()).add(g.receiver.name);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/** 웹훅 몸(Alertmanager 웹훅 판 4)에 든 경보 이름들. JSON이 아니면 던진다 */
export function webhookAlertNames(r: Received): string[] {
  const body = JSON.parse(r.raw) as { version?: string; alerts?: Array<{ labels?: Record<string, string> }> };
  if (body.version !== '4') throw new Error(`웹훅 판이 4가 아니다: ${r.raw.slice(0, 200)}`);
  return (body.alerts ?? []).map((a) => a.labels?.alertname ?? '');
}

/** 받는 곳 하나가 받은 경보 이름(웹훅은 몸의 경보, Slack은 원문에 이름 글이 든 것) 가운데 candidates에 든 것 */
export function namesAt(rcv: FakeReceiver, candidates: readonly string[]): string[] {
  const got = new Set<string>();
  for (const r of rcv.received) {
    if (rcv.name === 'slack-ops') {
      for (const c of candidates) if (r.raw.includes(c)) got.add(c);
    } else {
      for (const n of webhookAlertNames(r)) if (candidates.includes(n)) got.add(n);
    }
  }
  return [...got].sort();
}

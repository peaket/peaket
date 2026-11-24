// 통합 시험용 OTel 수집기 컨테이너(containers.ts와 같은 방식: 라이브러리 없이 docker 명령). Docker 엔진이 떠 있어야 한다.
// 설정은 저장소의 운영 판 위에 로컬 판을 겹쳐 읽는다(docs/observability.md §1 '설정 원천과 로컬 확인', 계획 docs/review/plans/F-01-3.md §5):
//   게이트웨이 --config gateway.yaml --config generated/tail-sampling.yaml --config generated/pii-masking.yaml --config local/gateway.yaml
//   에이전트   --config agent.yaml --config local/agent.yaml
// 설정 폴더 deploy/platform/observability/collector/를 컨테이너의 /etc/otelcol에 읽기 전용으로 붙인다.
// 로컬 게이트웨이는 결과를 /var/lib/otelcol/out/traces.json·logs.json(JSON 줄)에 쓴다. 붙인 폴더는 컨테이너의 루트 아닌 사용자가 쓸 수 있게
// 권한을 열고, 결과 파일은 docker cp로 꺼낸다(리눅스에서 컨테이너 사용자가 만든 파일을 시험 프로세스가 못 읽는 일을 피한다).
// 이 파일은 node 기본 모듈만 읽는다: V-T30 ② 시험이 OTel SDK보다 먼저 읽기 때문이다(계측할 node:http를 먼저 읽으면 안 된다).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 수집기 이미지(contrib 공식 이미지, 판과 다이제스트 고정, docs/devops.md §4.4). 2026-11-23에 고른 최신 안정 판 0.165.0(2026-11-07 게시)의
 * 다중 플랫폼 목록 다이제스트. 구현 담당이 같은 값을 deploy/platform/observability/collector/README.md에 적는다(계획 §4 P5)
 */
export const COLLECTOR_IMAGE = 'otel/opentelemetry-collector-contrib:0.165.0@sha256:e40d61f10c9a617cca1ffd1be4d7e2b3a4b0f0001798ff07e58cabe82e618cea';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const COLLECTOR_DIR = join(REPO, 'deploy', 'platform', 'observability', 'collector');
const IN_CONTAINER = '/etc/otelcol';
const OUT_DIR = '/var/lib/otelcol/out';

/** 로컬 에이전트가 찾는 게이트웨이 별칭(계획 §5). 로그는 첫째로만 간다 */
export const GATEWAY_ALIASES = ['peaket-gw-0', 'peaket-gw-1'] as const;

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
const slash = (p: string) => p.replace(/\\/g, '/');

/** OTLP/JSON 결과 한 줄(파일 내보내기). 필요한 칸만 적는다 */
export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
}
export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes?: OtlpKeyValue[];
  status?: { code?: number };
}
export interface OtlpLogRecord {
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
  traceId?: string;
}
export interface TraceLine {
  resourceSpans?: { resource?: { attributes?: OtlpKeyValue[] }; scopeSpans?: { spans?: OtlpSpan[] }[] }[];
}
export interface LogLine {
  resourceLogs?: { resource?: { attributes?: OtlpKeyValue[] }; scopeLogs?: { logRecords?: OtlpLogRecord[] }[] }[];
}

/** 결과 파일에서 꺼낸 것: 원문 바이트(개인정보 찾기)와 읽은 span·로그 */
export interface CollectorOutput {
  tracesRaw: string;
  logsRaw: string;
  spans: { span: OtlpSpan; resource: OtlpKeyValue[] }[];
  logs: { record: OtlpLogRecord; resource: OtlpKeyValue[] }[];
}

export interface CollectorContainer {
  id: string;
  /** OTLP/HTTP 받는 곳(호스트 쪽), 예 http://127.0.0.1:49153 */
  otlpHttp: string;
  /** 자체 지표(호스트 쪽) http://127.0.0.1:<port>/metrics */
  metricsUrl: string;
  /** 게이트웨이만: 결과 파일을 docker cp로 꺼내 읽는다(아직 없으면 빈 결과) */
  output(): CollectorOutput;
  /** 자체 지표 글(Prometheus 형식) */
  metrics(): Promise<string>;
  /** 컨테이너 로그(실패했을 때 까닭을 보여 주려고) */
  logs(): string;
  stop(): void;
}

export const attr = (list: OtlpKeyValue[] | undefined, key: string): OtlpAnyValue | undefined => list?.find((a) => a.key === key)?.value;

function hostPort(id: string, containerPort: number): string {
  // 'docker port'는 '127.0.0.1:49153' 꼴(여러 줄이면 첫 줄)
  const line = docker(['port', id, `${containerPort}/tcp`]).split('\n')[0]!.trim();
  return line.slice(line.lastIndexOf(':') + 1);
}

function running(id: string): boolean {
  try {
    return docker(['inspect', '-f', '{{.State.Running}}', id]) === 'true';
  } catch {
    return false;
  }
}

/** 조건이 맞을 때까지 당겨 본다(고정 대기 없음). 시간 안에 맞지 않으면 마지막 까닭으로 실패한다 */
export async function pollUntil<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, o: { timeoutMs: number; intervalMs?: number }): Promise<T> {
  const end = Date.now() + o.timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`${what}: ${o.timeoutMs}ms 안에 맞지 않았다${last ? ` (${String(last)})` : ''}`);
    await new Promise((r) => setTimeout(r, o.intervalMs ?? 250));
  }
}

function readLines<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

export function parseOutput(tracesRaw: string, logsRaw: string): CollectorOutput {
  const spans: CollectorOutput['spans'] = [];
  for (const line of readLines<TraceLine>(tracesRaw))
    for (const rs of line.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const span of ss.spans ?? []) spans.push({ span, resource: rs.resource?.attributes ?? [] });
  const logs: CollectorOutput['logs'] = [];
  for (const line of readLines<LogLine>(logsRaw))
    for (const rl of line.resourceLogs ?? []) for (const sl of rl.scopeLogs ?? []) for (const record of sl.logRecords ?? []) logs.push({ record, resource: rl.resource?.attributes ?? [] });
  return { tracesRaw, logsRaw, spans, logs };
}

interface StartOptions {
  role: 'gateway' | 'agent';
  network?: string;
  alias?: string;
  /** 에이전트만: /var/log/pods로 붙일 호스트 폴더 */
  podLogsDir?: string;
  /** 마지막에 겹쳐 읽을 덧판(--config). 시험이 로컬 판의 내보내기를 Loki로 바꿀 때 쓴다 */
  extraConfig?: string;
  /** 컨테이너 환경 변수(예 PEAKET_CLUSTER) */
  env?: Record<string, string>;
}

function configArgs(role: StartOptions['role']): string[] {
  const files = role === 'gateway' ? ['gateway.yaml', 'generated/tail-sampling.yaml', 'generated/pii-masking.yaml', 'local/gateway.yaml'] : ['agent.yaml', 'local/agent.yaml'];
  for (const f of files) if (!existsSync(join(COLLECTOR_DIR, f))) throw new Error(`수집기 설정 파일이 없다: deploy/platform/observability/collector/${f}`);
  return files.flatMap((f) => ['--config', `${IN_CONTAINER}/${f}`]);
}

async function startCollector(o: StartOptions): Promise<CollectorContainer> {
  const config = configArgs(o.role);
  const outHost = mkdtempSync(join(tmpdir(), `peaket-otelcol-${o.role}-`));
  // 이미지는 루트가 아닌 사용자로 돈다. 리눅스에서 mkdtemp의 0700 폴더면 파일 내보내기가 쓰지 못한다(containers.ts의 Kafka 인증서와 같은 까닭). 시험용 빈 폴더다
  chmodSync(outHost, 0o777);
  // 덧판은 결과 폴더(컨테이너에 붙인다)에 써서 마지막 --config로 읽게 한다
  if (o.extraConfig !== undefined) {
    writeFileSync(join(outHost, 'extra.yaml'), o.extraConfig);
    config.push('--config', `${OUT_DIR}/extra.yaml`);
  }
  const env = Object.entries(o.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const args = ['run', '-d', '--memory', '1g', ...env, '-p', '127.0.0.1::4318', '-p', '127.0.0.1::8888', '-v', `${slash(COLLECTOR_DIR)}:${IN_CONTAINER}:ro`, '-v', `${slash(outHost)}:${OUT_DIR}`];
  if (o.podLogsDir) args.push('-v', `${slash(o.podLogsDir)}:/var/log/pods:ro`);
  if (o.network) args.push('--network', o.network);
  if (o.alias) args.push('--network-alias', o.alias);
  const id = docker([...args, COLLECTOR_IMAGE, ...config]);
  const copyDir = mkdtempSync(join(tmpdir(), `peaket-otelcol-copy-`));
  const stop = () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 없다
    }
    rmSync(copyDir, { recursive: true, force: true });
    rmSync(outHost, { recursive: true, force: true });
  };
  const logs = () => {
    try {
      return execFileSync('docker', ['logs', '--tail', '80', id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    } catch (err) {
      return String(err);
    }
  };
  const copyOut = (name: string): string => {
    const dest = join(copyDir, name);
    rmSync(dest, { force: true });
    try {
      docker(['cp', `${id}:${OUT_DIR}/${name}`, slash(dest)]);
    } catch {
      return '';
    }
    return existsSync(dest) ? readFileSync(dest, 'utf8') : '';
  };
  try {
    // 설정 오류로 곧바로 끝난 수집기는 포트가 없다. 그때는 수집기 로그를 까닭으로 보여 준다
    const portOf = (p: number) => {
      try {
        return hostPort(id, p);
      } catch {
        throw new Error(`${o.role} 수집기가 뜨지 못했다(포트 ${p} 없음):\n${logs()}`);
      }
    };
    const otlpHttp = `http://127.0.0.1:${portOf(4318)}`;
    const metricsUrl = `http://127.0.0.1:${portOf(8888)}/metrics`;
    // 자체 지표가 답하고 OTLP/HTTP가 빈 요청을 받을 때까지(수집기가 뜨지 못하고 끝나면 바로 실패한다)
    await pollUntil(
      `${o.role} 수집기 준비`,
      async () => {
        if (!running(id)) throw new Error(`수집기가 끝났다:\n${logs()}`);
        const m = await fetch(metricsUrl);
        if (m.status !== 200) return undefined;
        const r = await fetch(`${otlpHttp}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"resourceSpans":[]}' });
        return r.status === 200 ? true : undefined;
      },
      { timeoutMs: 90_000, intervalMs: 300 },
    ).catch((err: unknown) => {
      throw new Error(`${String(err)}\n${logs()}`);
    });
    return {
      id,
      otlpHttp,
      metricsUrl,
      output: () => parseOutput(copyOut('traces.json'), copyOut('logs.json')),
      metrics: async () => (await fetch(metricsUrl)).text(),
      logs,
      stop,
    };
  } catch (err) {
    stop();
    throw err;
  }
}

export const startGateway = (o: { network?: string; alias?: string; extraConfig?: string; env?: Record<string, string> } = {}) => startCollector({ role: 'gateway', ...o });
export const startAgent = (o: { network: string; podLogsDir: string }) => startCollector({ role: 'agent', ...o });

/** 시험마다 새 Docker 네트워크(별칭이 다른 시험과 섞이지 않게) */
export function createNetwork(): { name: string; remove(): void } {
  const name = `peaket-it-otel-${process.pid}-${Date.now().toString(36)}`;
  docker(['network', 'create', name]);
  return {
    name,
    remove: () => {
      try {
        docker(['network', 'rm', name]);
      } catch {
        // 이미 없다
      }
    },
  };
}

/** 에이전트의 filelog가 읽는 /var/log/pods 꼴 폴더(호스트). 줄은 수집기가 뜬 뒤 writeCri로 쓴다 */
export function podLogs(o: { namespace: string; pod: string; uid: string; container: string }): { dir: string; writeCri(lines: string[]): void; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-pods-'));
  chmodSync(dir, 0o755);
  const containerDir = join(dir, `${o.namespace}_${o.pod}_${o.uid}`, o.container);
  return {
    dir,
    writeCri(lines) {
      mkdirSync(containerDir, { recursive: true });
      chmodSync(join(dir, `${o.namespace}_${o.pod}_${o.uid}`), 0o755);
      chmodSync(containerDir, 0o755);
      // CRI 꼴: <RFC3339Nano 시각> <stdout|stderr> <F|P> <본문>
      const at = '2026-11-23T05:00:00.000000000Z';
      const file = join(containerDir, '0.log');
      writeFileSync(file, lines.map((l) => `${at} stdout F ${l}\n`).join(''));
      chmodSync(file, 0o644);
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Prometheus 글에서 이름이 name으로 시작하는(같은 이름의 _total 포함) 표본의 합. 라벨 조건을 주면 그 라벨 값이 같은 것만. 표본이 없으면 undefined */
export function metricSum(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  let sum: number | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!m || (m[1] !== name && m[1] !== `${name}_total`)) continue;
    const lab = m[2] ?? '';
    if (!Object.entries(labels).every(([k, v]) => lab.includes(`${k}="${v}"`))) continue;
    sum = (sum ?? 0) + Number(m[3]);
  }
  return sum;
}

/** OTLP/JSON 값 만들기 */
export const str = (key: string, v: string): OtlpKeyValue => ({ key, value: { stringValue: v } });
export const bool = (key: string, v: boolean): OtlpKeyValue => ({ key, value: { boolValue: v } });

/** OTLP/HTTP JSON으로 보낸다. 받지 않으면(2xx가 아니면) 실패한다 */
export async function postOtlp(base: string, signal: 'traces' | 'logs', body: unknown): Promise<void> {
  const res = await fetch(`${base}/v1/${signal}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`OTLP ${signal} 보내기 실패 ${res.status}: ${text}`);
}

/** 시험이 고르는 trace ID(32자리 16진수)·span ID(16자리). 숫자열 개인정보 꼴과 겹치지 않게 a~f로 채운다 */
export const traceIdOf = (n: number) => `abcdef${n.toString(16).padStart(8, '0')}`.padEnd(32, 'e');
export const spanIdOf = (trace: number, n: number) => `fa${trace.toString(16).padStart(6, '0')}${n.toString(16).padStart(4, '0')}`.padEnd(16, 'c');

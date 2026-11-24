// 관측 저장소 통합 시험 도우미(V-T30 ④, V-T50 ③④⑤, 계획 docs/review/plans/F-01-4.md §6). containers.ts·postgres.ts와 같은 방식(라이브러리 없이 docker 명령).
// 설정은 저장소 원천을 그대로 쓴다: Loki·Tempo는 node tools/ci/observability-stores.mjs --render <loki|tempo>로 겹친 로컬 판,
// postgres_exporter는 deploy/platform/observability/exporters/postgres-exporter.yaml의 image·args. 설정 파일은 임시 파일에 써서
// docker create → docker cp → docker start로 넣는다(Windows에서 붙인 폴더 경로가 바뀌는 문제를 피한다).
// 정리는 이 도우미가 띄운 컨테이너 ID와 만든 네트워크 이름만 지운다(docker rm -f -v <id>).
// 이미지는 판과 다이제스트로 고정한다(2026-11-23 Docker Hub에서 받은 것). Prometheus는 deploy/local/observability.yaml과 같은 판이다.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { POSTGRES_IMAGE } from './postgres.js';
export const LOKI_IMAGE = 'grafana/loki:3.7.10@sha256:b43c257ccfc925d4a50b8717cac61a3b51df8c48d01847936057e5c4075a24a7';
export const TEMPO_IMAGE = 'grafana/tempo:3.1.1@sha256:64e2fbd56d9c2b3412a4b430a58ea59e91a670b1e75f920a0c702213ad145044';
export const PROMETHEUS_IMAGE = 'prom/prometheus:v3.14.0@sha256:e906cef998316bbe319f98711e1b4d8613ad37e14b08ff831d7036e77b7464f9';
export const POSTGRES_EXPORTER_IMAGE = 'prometheuscommunity/postgres-exporter:v0.21.1@sha256:3b8e05a84282cd1199ad2fb6c66f362738bf4c68c1547d8f4226a34a7dd6d8d7';
/** 로컬 판 Tempo가 원격 쓰기로 보내는 Prometheus의 네트워크 별칭(계획 §5) */
export const PROMETHEUS_ALIAS = 'peaket-prom';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STORES_TOOL = join(REPO, 'tools', 'ci', 'observability-stores.mjs');

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
const quiet = (args: string[]) => {
  try {
    docker(args);
  } catch {
    // 이미 없다
  }
};

/** 저장소 뿌리 기준 글 파일 */
export const readRepo = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/** 겹친 로컬 판 설정(--render). 도구가 0으로 끝나지 않으면 던진다 */
export function renderConfig(store: 'loki' | 'tempo'): string {
  const r = spawnSync(process.execPath, [STORES_TOOL, '--render', store], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`observability-stores.mjs --render ${store}이 ${r.status}로 끝났다: ${r.stderr || r.error?.message}`);
  return r.stdout;
}

/** 저장소의 yaml 패키지로 YAML ↔ 값(이 패키지는 yaml에 기대지 않는다. 뿌리 개발 의존성을 자식 프로세스로 쓴다) */
function yamlChild(code: string, input: string): string {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { parse, stringify } from 'yaml'; let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => process.stdout.write(${code}));`], { cwd: REPO, input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`YAML 변환 실패: ${r.stderr}`);
  return r.stdout;
}
export const parseYaml = (text: string): unknown => JSON.parse(yamlChild('JSON.stringify(parse(s))', text));
export const stringifyYaml = (value: unknown): string => yamlChild('stringify(JSON.parse(s))', JSON.stringify(value));

export interface Network {
  name: string;
  remove(): void;
}
export function createNetwork(): Network {
  const name = `peaket-obs-it-${randomBytes(4).toString('hex')}`;
  docker(['network', 'create', name]);
  return { name, remove: () => quiet(['network', 'rm', name]) };
}

export interface Container {
  id: string;
  /** 호스트에서 닿는 주소(http://127.0.0.1:<열린 포트>) */
  url(port: number): string;
  logs(): string;
  stop(): void;
}

interface StartOptions {
  image: string;
  network?: Network;
  alias?: string;
  ports: number[];
  env?: Record<string, string>;
  args?: string[];
  /** docker run에 더할 플래그(예 --add-host=host.docker.internal:host-gateway). 이미지 앞에 온다 */
  runArgs?: string[];
  /** 컨테이너 안 경로 → 넣을 글 */
  files?: Record<string, string>;
}

export function startContainer(o: StartOptions): Container {
  const net = o.network ? ['--network', o.network.name, ...(o.alias ? ['--network-alias', o.alias] : [])] : [];
  const env = Object.entries(o.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const ports = o.ports.flatMap((p) => ['-p', `127.0.0.1::${p}`]);
  const id = docker(['create', ...net, ...env, ...(o.runArgs ?? []), ...ports, o.image, ...(o.args ?? [])]);
  const stop = () => quiet(['rm', '-f', '-v', id]);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'peaket-obs-it-'));
    try {
      for (const [target, text] of Object.entries(o.files ?? {})) {
        const file = join(dir, target.replace(/[^a-z0-9.]/gi, '_'));
        writeFileSync(file, text);
        docker(['cp', file, `${id}:${target}`]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    docker(['start', id]);
  } catch (err) {
    stop();
    throw err;
  }
  const mapped = new Map<number, number>();
  for (const p of o.ports) {
    const line = docker(['port', id, `${p}/tcp`]).split('\n')[0]!;
    mapped.set(p, Number(line.slice(line.lastIndexOf(':') + 1)));
  }
  return {
    id,
    url: (p) => `http://127.0.0.1:${mapped.get(p)}`,
    logs: () => {
      const r = spawnSync('docker', ['logs', '--tail', '60', id], { encoding: 'utf8', timeout: 300_000 });
      return `${r.stdout}${r.stderr}`;
    },
    stop,
  };
}

/** 조건이 맞을 때까지 다시 본다(고정 대기 대신). 시간 안에 맞지 않으면 마지막 값과 함께 던진다 */
export async function until<T>(what: string, ms: number, probe: () => Promise<T>, ok: (v: T) => boolean, c?: Container): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  let lastErr: unknown;
  for (;;) {
    try {
      last = await probe();
      if (ok(last)) return last;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > end) {
      throw new Error(`${what}: ${ms / 1000}초 안에 되지 않았다. 마지막 값 ${JSON.stringify(last)} ${lastErr ? String(lastErr) : ''}${c ? `\n--- 컨테이너 기록 ---\n${c.logs()}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const ready = (c: Container, port: number, path: string, what: string) =>
  until(`${what} 준비`, 120_000, async () => (await fetch(`${c.url(port)}${path}`)).status, (s) => s === 200, c);

/** 로컬 판 Loki(HTTP 3100). configText는 --render loki 결과나 그것을 고친 글. alias를 주면 같은 네트워크의 다른 컨테이너가 그 이름으로 찾는다 */
export async function startLoki(configText: string, network?: Network, alias?: string): Promise<Container> {
  const c = startContainer({ image: LOKI_IMAGE, network, ...(alias ? { alias } : {}), ports: [3100], files: { '/etc/peaket-loki.yaml': configText }, args: ['-config.file=/etc/peaket-loki.yaml'] });
  try {
    await ready(c, 3100, '/ready', 'Loki');
  } catch (err) {
    c.stop();
    throw err;
  }
  return c;
}

/** 로컬 판 Tempo(OTLP HTTP 4318, HTTP 3200) */
export async function startTempo(configText: string, network: Network): Promise<Container> {
  const c = startContainer({ image: TEMPO_IMAGE, network, ports: [4318, 3200], files: { '/etc/peaket-tempo.yaml': configText }, args: ['-config.file=/etc/peaket-tempo.yaml'] });
  try {
    await ready(c, 3200, '/ready', 'Tempo');
  } catch (err) {
    c.stop();
    throw err;
  }
  return c;
}

/** 원격 쓰기를 받는 Prometheus(별칭 peaket-prom, HTTP 9090). 긁기 설정은 이미지 기본값 */
export async function startPrometheus(network: Network): Promise<Container> {
  const c = startContainer({
    image: PROMETHEUS_IMAGE,
    network,
    alias: PROMETHEUS_ALIAS,
    ports: [9090],
    args: ['--config.file=/etc/prometheus/prometheus.yml', '--storage.tsdb.path=/prometheus', '--web.enable-remote-write-receiver'],
  });
  try {
    await ready(c, 9090, '/-/ready', 'Prometheus');
  } catch (err) {
    c.stop();
    throw err;
  }
  return c;
}

/** Prometheus 즉시 질의 결과: [{ metric, value }] */
export async function promQuery(prom: Container, query: string): Promise<{ metric: Record<string, string>; value: number }[]> {
  const res = await fetch(`${prom.url(9090)}/api/v1/query?query=${encodeURIComponent(query)}`);
  const body = (await res.json()) as { status: string; data: { result: { metric: Record<string, string>; value: [number, string] }[] } };
  if (body.status !== 'success') throw new Error(`질의 실패: ${query}: ${JSON.stringify(body)}`);
  return body.data.result.map((r) => ({ metric: r.metric, value: Number(r.value[1]) }));
}

/** Prometheus 형식 노출 글에서 한 지표의 모든 표본 값의 합(시계열이 없으면 0) */
export function sumMetric(text: string, name: string): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = new RegExp(`^${name}(\\{[^}]*\\})?\\s+(\\S+)`).exec(line);
    if (m) sum += Number(m[2]);
  }
  return sum;
}

/** OTLP 속성 꼴 */
export const otlpAttrs = (o: Record<string, string>) => Object.entries(o).map(([key, v]) => ({ key, value: { stringValue: v } }));

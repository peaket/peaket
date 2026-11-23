// 통합 시험용 실제 Prometheus 컨테이너(F-03-3). 지표는 promtool tsdb create-blocks-from openmetrics로 지난 시각에 미리 채운다
// (test-int/ops-live.int.test.ts의 startPrometheus와 같은 방식). 쿼리 문법(abs·max·비율)은 진짜 Prometheus가 계산하므로, 시험은 원시 시계열만 정한다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PROMETHEUS_IMAGE = 'prom/prometheus:v3.14.0';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

/** OpenMetrics 글 만들기: 이름(가족)마다 TYPE 줄 하나와 그 가족의 시계열을 이어 쓴다. 한 시계열의 표본은 한 번에 시각 차례로 준다 */
export class OpenMetrics {
  readonly #families = new Map<string, string[]>();

  #family(name: string, type: 'gauge' | 'counter'): string[] {
    let f = this.#families.get(name);
    if (!f) {
      f = [`# TYPE ${name} ${type}`];
      this.#families.set(name, f);
    }
    return f;
  }

  /** gauge 시계열(라벨 글, 표본 [초, 값]). NaN도 쓴다 */
  gauge(name: string, labels: string, samples: readonly (readonly [number, number])[]): this {
    const f = this.#family(name, 'gauge');
    for (const [t, v] of samples) f.push(`${name}{${labels}} ${Number.isNaN(v) ? 'NaN' : String(v)} ${t}`);
    return this;
  }

  /** counter 시계열(표본 이름에 _total을 붙인다) */
  counter(name: string, labels: string, samples: readonly (readonly [number, number])[]): this {
    const f = this.#family(name, 'counter');
    for (const [t, v] of samples) f.push(`${name}_total{${labels}} ${String(v)} ${t}`);
    return this;
  }

  text(): string {
    return `${[...this.#families.values()].flat().join('\n')}\n# EOF\n`;
  }
}

export interface PrometheusContainer {
  url: string;
  stop(): void;
}

/**
 * 채운 지표로 Prometheus를 띄운다. ready(url)이 참이 될 때까지 기다린다(시작 조건, 시간 아님)
 * @param metrics OpenMetrics 글
 * @param ready 채운 지표가 질의되는지 보는 함수
 */
export async function startPrometheus(metrics: string, ready: (url: string) => Promise<boolean>): Promise<PrometheusContainer> {
  const prefix = process.env.PEAKET_TEST_CONTAINER_PREFIX;
  const name = prefix ? `${prefix}prom-${Math.random().toString(36).slice(2, 8)}` : undefined;
  // 지표 파일은 명령줄에 싣기에 커서(Windows 명령줄 상한) 만든 컨테이너에 docker cp로 넣은 뒤 시작한다
  const dir = mkdtempSync(join(tmpdir(), 'ops-f033-prom-'));
  const file = join(dir, 'm.om');
  writeFileSync(file, metrics);
  const script = 'promtool tsdb create-blocks-from openmetrics /tmp/m.om /prometheus >/dev/null && exec prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus --storage.tsdb.retention.time=3650d';
  const id = docker(['create', '--rm', ...(name ? ['--name', name] : []), '-p', '127.0.0.1::9090', '--entrypoint', 'sh', PROMETHEUS_IMAGE, '-c', script]);
  const stop = () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 멈췄다
    }
  };
  try {
    docker(['cp', file, `${id}:/tmp/m.om`]);
    docker(['start', id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const mapped = docker(['port', id, '9090/tcp']).split('\n')[0]!;
  const url = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      if (await ready(url)) break;
    } catch {
      // 아직 뜨는 중
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error('Prometheus가 채운 지표를 내지 않았다');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, stop };
}

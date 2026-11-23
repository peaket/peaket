// 증거 수집기 시험 도우미(기능 F-01-1, OPS-030, 시험 D-T51). 단위 시험(test/)과 통합 시험(test-int/)이 함께 쓴다.
// 가짜는 둘뿐이다: 진단 증거 저장소(바이트를 모으는 짝 가짜, 진짜 s3EvidenceStore의 putBytes는 packages/platform D-T52 ②가 본다)와 시계(fakeClock).
// 수집기의 경보 고르기·간격·뜨기는 가짜로 바꾸지 않는다.
import { Writable } from 'node:stream';
import type { EvidenceBytesStore } from '@peaket/platform';
import type { EvidenceCollectorApp } from '../src/collector-app.js';

/** 웹훅 공유 토큰(시험 값. 로그에 이 글자가 나오면 안 된다) */
export const TOKEN = 'ev-right-7f3c9a1d2b5e';
export const WRONG_TOKEN = 'ev-wrong-0c4e8b6a95d1';

export interface StoredObject {
  body: Uint8Array;
  contentType: string;
}

/**
 * 진단 증거 저장소의 짝 가짜: EvidenceBytesStore를 implements하고 올린 바이트를 키별로 모은다.
 * 파일 경로로 올리는 put은 포트에 없지만, 수집기가 그 길을 쓰는지 보려고 부르면 적어 둔다(D-T51 ⑤)
 */
export class MemoryBytesStore implements EvidenceBytesStore {
  readonly objects = new Map<string, StoredObject>();
  readonly filePuts: string[] = [];
  async putBytes(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: Uint8Array.from(body), contentType });
  }
  async put(key: string, _file: string): Promise<void> {
    this.filePuts.push(key);
  }
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
  text(key: string): string {
    const o = this.objects.get(key);
    if (!o) throw new Error(`올린 객체가 없다: ${key}`);
    return Buffer.from(o.body).toString('utf8');
  }
  json(key: string): unknown {
    return JSON.parse(this.text(key)) as unknown;
  }
  /** 대상 하나의 manifest.json 키들 */
  manifests(target: string): string[] {
    return this.keys().filter((k) => k.startsWith(`evidence-collector/${target}/`) && k.endsWith('/manifest.json'));
  }
  /** 모든 객체 본문을 이어 붙인 글자 */
  allText(): string {
    return this.keys()
      .map((k) => this.text(k))
      .join('\n');
  }
}

/** 서비스 로거 목적지: 모은 바이트 전체와 JSON 줄 */
export function logSink(): { stream: Writable; text: () => string; lines: () => Record<string, unknown>[] } {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  const lines = () =>
    text
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { stream, text: () => text, lines };
}

export interface AlertInput {
  status?: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  fingerprint?: string;
}

let seq = 0;
/** Alertmanager 기본 웹훅 본문(판 4) */
export function webhook(alerts: AlertInput[], status: 'firing' | 'resolved' = 'firing'): Record<string, unknown> {
  return {
    version: '4',
    groupKey: '{}:{alertname="evidence-test"}',
    truncatedAlerts: 0,
    status,
    receiver: 'evidence-collector',
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: 'http://alertmanager.observability.svc:9093',
    alerts: alerts.map((a) => ({
      status: a.status ?? 'firing',
      labels: a.labels,
      annotations: a.annotations ?? { summary: '시험 경보' },
      startsAt: '2026-11-23T01:59:00.000Z',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'http://prometheus.observability.svc:9090/graph',
      fingerprint: a.fingerprint ?? `f${(++seq).toString(16).padStart(15, '0')}`,
    })),
  };
}

/** 원인 SEV2 경보(그 의존성을 뜨는 경보) */
export const causeSev2 = (dependency: string, extra: Partial<AlertInput> = {}): AlertInput => ({
  labels: { alertname: 'DependencySaturated', severity: 'sev2', kind: 'cause', dependency },
  ...extra,
});

export async function send(
  app: EvidenceCollectorApp,
  body: Record<string, unknown>,
  token: string | null = TOKEN,
): Promise<{ statusCode: number; contentType: string; json: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await app.service.http.inject({ method: 'POST', url: '/internal/v1/alerts', headers, payload: JSON.stringify(body) });
  let json: unknown = null;
  try {
    json = JSON.parse(res.payload) as unknown;
  } catch {
    json = null;
  }
  return { statusCode: res.statusCode, contentType: String(res.headers['content-type'] ?? ''), json };
}

export async function metricsText(app: EvidenceCollectorApp): Promise<string> {
  const res = await app.service.management.inject({ method: 'GET', url: '/metrics' });
  return res.payload;
}

/** Prometheus 글자 꼴에서 이름·라벨이 맞는 한 줄의 값. 그런 줄이 없으면 0(카운터를 아직 올리지 않음) */
export function metric(text: string, name: string, labels: Record<string, string>): number {
  for (const line of text.split('\n')) {
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m || m[1] !== name) continue;
    const got = Object.fromEntries([...(m[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]]));
    if (Object.entries(labels).every(([k, v]) => got[k] === v)) return Number(m[3]);
  }
  return 0;
}

/** 시험 환경 값. targets는 [이름, 종류, 접속 주소] */
export function envFor(targets: Array<[name: string, kind: 'postgres' | 'redis', url: string]>, token: string = TOKEN): Record<string, string> {
  const env: Record<string, string> = { PEAKET_ENV: 'ci', PEAKET_EVIDENCE_WEBHOOK_TOKEN: token };
  const list = targets.map(([name, kind], i) => ({ name, kind, urlEnv: `EV_TARGET_${i}_URL` }));
  env.PEAKET_EVIDENCE_TARGETS = JSON.stringify(list);
  targets.forEach(([, , url], i) => {
    env[`EV_TARGET_${i}_URL`] = url;
  });
  return env;
}

/** 객체 이름 꼴(observability.md §5 '진단 증거' 올리기): evidence-collector/<대상>/<UTC 밀리초 시각>/<파일> */
export const KEY_SHAPE = (target: string) => new RegExp(`^evidence-collector/${target}/\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z/[a-z-]+\\.(json|txt)$`);

export interface Manifest {
  target: string;
  kind: string;
  collectedAt: string;
  alerts: Array<{ fingerprint: string; alertname: string; severity?: string; kind?: string; dependency?: string }>;
  files: string[];
  errors: Array<{ file?: string; code: string }>;
}

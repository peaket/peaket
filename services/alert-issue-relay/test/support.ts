// 티켓 중계 시험 도우미(기능 F-01-6, OPS-110, 시험 V-T53 ④⑤⑥). 계획 docs/review/plans/F-01-6.md §5 '중계가 부르는 GitHub 경로'.
// 가짜는 둘뿐이다: GitHub REST API(이 프로세스의 node:http, 계획 §5의 경로만 흉내 낸다)와 시계(@peaket/platform fakeClock).
// 중계의 경보 고르기·지문 확인·가림·재시도 판단은 가짜로 바꾸지 않는다. 실제 GitHub 계정·토큰은 쓰지 않는다.
// 가짜 GitHub는 실제 GitHub의 규칙 가운데 중계가 기대는 것을 지킨다(docs.github.com REST 'Authenticating as a GitHub App',
// 'List repository issues', 2026-11 확인): 앱 JWT는 RS256이고 iss가 앱 ID, exp는 지금부터 10분 안. 설치 토큰은 1시간 뒤 만료.
// 이슈 목록의 state 기본값은 open, labels는 준 것을 모두 가진 이슈만, 차례는 만든 때의 역순, per_page 기본 30·최대 100.
import { createPublicKey, generateKeyPairSync, randomBytes, verify, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { AlertIssueRelayApp } from '../src/relay-app.js';

/** 웹훅 공유 토큰(시험 값. 로그에 이 글자가 나오면 안 된다) */
export const TOKEN = 'relay-right-3e9b7c1a5d20f846';
export const WRONG_TOKEN = 'relay-wrong-8a04d6f2c19e7b35';
export const APP_ID = '424242';
export const INSTALLATION_ID = '7777001';
export const OWNER = 'peaket-test';
export const REPO_NAME = 'ops-alerts';
export const ALERT_LABEL = 'peaket-alert';
/** 가짜 GitHub가 내주는 설치 토큰의 앞머리(로그에 나오면 안 된다) */
export const INSTALL_TOKEN_PREFIX = 'ghs_vt53fake';

/** 시험마다 새로 만드는 앱 키(개인 키 PEM 파일과 공개 키) */
export interface AppKey {
  dir: string;
  privateKeyFile: string;
  privateKeyPem: string;
  publicKey: KeyObject;
  remove(): void;
}
export function makeAppKey(): AppKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const dir = mkdtempSync(join(tmpdir(), 'peaket-relay-test-'));
  const privateKeyFile = join(dir, 'github-app.pem');
  writeFileSync(privateKeyFile, privateKeyPem);
  return { dir, privateKeyFile, privateKeyPem, publicKey: createPublicKey(privateKey), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  /** 몸 원문 */
  raw: string;
  status: number;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  comments: string[];
}

type FailKind = 'token' | 'list' | 'create' | 'comment' | 'close';

/** 가짜 GitHub REST API */
export class FakeGitHub {
  readonly requests: RecordedRequest[] = [];
  readonly issues: FakeIssue[] = [];
  readonly issuedTokens: string[] = [];
  /** JWT가 틀려 거절한 수 */
  jwtRejected = 0;
  url = '';
  private readonly valid = new Map<string, number>();
  private readonly failures: Array<{ kind: FailKind; status: number }> = [];
  private server: Server | undefined;
  private next = 1;

  constructor(private readonly o: { publicKey: KeyObject; now: () => number }) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://fake-github');
        const rec: RecordedRequest = {
          method: req.method ?? '',
          path: u.pathname,
          query: Object.fromEntries(u.searchParams),
          headers: req.headers,
          raw: Buffer.concat(chunks).toString('utf8'),
          status: 0,
        };
        const [status, body] = this.handle(rec);
        rec.status = status;
        this.requests.push(rec);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** 다음 그 종류의 호출 하나를 status로 실패시킨다 */
  failNext(kind: FailKind, status: number): void {
    this.failures.push({ kind, status });
  }

  /** 내준 설치 토큰을 모두 무르게 한다(다음 호출은 401) */
  revokeTokens(): void {
    this.valid.clear();
  }

  /** 미리 있는 이슈를 만든다(번호는 만든 차례) */
  seed(i: { title?: string; body: string; labels?: string[]; state?: 'open' | 'closed' }): FakeIssue {
    const issue: FakeIssue = { number: this.next++, title: i.title ?? 'seeded', body: i.body, labels: i.labels ?? [ALERT_LABEL], state: i.state ?? 'open', comments: [] };
    this.issues.push(issue);
    return issue;
  }

  /** 쓰기 호출(이슈 만들기·댓글·고치기) */
  writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== 'GET' && !r.path.startsWith('/app/'));
  }
  tokenRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.startsWith('/app/'));
  }
  /** 받은 모든 몸과 경로·쿼리의 원문 */
  allText(): string {
    return this.requests.map((r) => `${r.method} ${r.path} ${JSON.stringify(r.query)}\n${r.raw}`).join('\n');
  }
  /** 이 지문의 표시 줄이 든 이슈들 */
  issuesFor(fingerprint: string): FakeIssue[] {
    return this.issues.filter((i) => i.body.split(/\r?\n/).some((l) => l.trim() === `peaket-alert-fingerprint: ${fingerprint}`));
  }

  private failing(kind: FailKind): number | undefined {
    const i = this.failures.findIndex((f) => f.kind === kind);
    if (i < 0) return undefined;
    return this.failures.splice(i, 1)[0]!.status;
  }

  private nowSec(): number {
    return Math.floor(this.o.now() / 1000);
  }

  private verifyJwt(auth: string | undefined): boolean {
    const m = /^Bearer (.+)$/.exec(auth ?? '');
    if (!m) return false;
    const parts = m[1]!.split('.');
    if (parts.length !== 3) return false;
    try {
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: string };
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { iss?: unknown; iat?: unknown; exp?: unknown };
      if (header.alg !== 'RS256') return false;
      if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), this.o.publicKey, Buffer.from(parts[2]!, 'base64url'))) return false;
      if (String(payload.iss) !== APP_ID) return false;
      if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return false;
      const now = this.nowSec();
      // GitHub 규칙: iat는 지금보다 뒤가 아니고, exp는 지금 뒤이며 10분을 넘지 않는다
      return payload.iat <= now && payload.exp > now && payload.exp - now <= 600;
    } catch {
      return false;
    }
  }

  private tokenOk(auth: string | undefined): boolean {
    const m = /^(?:Bearer|token) (.+)$/.exec(auth ?? '');
    if (!m) return false;
    const exp = this.valid.get(m[1]!);
    return exp !== undefined && this.o.now() < exp;
  }

  private handle(r: RecordedRequest): [number, unknown] {
    const repoBase = `/repos/${OWNER}/${REPO_NAME}`;
    if (r.method === 'POST' && r.path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      const f = this.failing('token');
      if (f) return [f, { message: 'fake failure' }];
      if (!this.verifyJwt(r.headers.authorization)) {
        this.jwtRejected++;
        return [401, { message: 'A JSON web token could not be decoded' }];
      }
      const token = `${INSTALL_TOKEN_PREFIX}_${this.issuedTokens.length + 1}_${randomBytes(6).toString('hex')}`;
      const exp = this.o.now() + 3600_000;
      this.valid.set(token, exp);
      this.issuedTokens.push(token);
      return [201, { token, expires_at: new Date(exp).toISOString(), permissions: { issues: 'write' } }];
    }
    if (!r.path.startsWith(`${repoBase}/issues`)) return [404, { message: 'Not Found' }];
    if (!this.tokenOk(r.headers.authorization)) return [401, { message: 'Bad credentials' }];

    if (r.method === 'GET' && r.path === `${repoBase}/issues`) {
      const f = this.failing('list');
      if (f) return [f, { message: 'fake failure' }];
      const state = r.query.state ?? 'open';
      const want = (r.query.labels ?? '').split(',').filter(Boolean);
      const perPage = Math.min(Number(r.query.per_page ?? 30), 100);
      const page = Number(r.query.page ?? 1);
      const list = this.issues
        .filter((i) => state === 'all' || i.state === state)
        .filter((i) => want.every((l) => i.labels.includes(l)))
        .sort((a, b) => b.number - a.number);
      return [200, list.slice((page - 1) * perPage, page * perPage).map((i) => this.view(i))];
    }
    if (r.method === 'POST' && r.path === `${repoBase}/issues`) {
      const f = this.failing('create');
      if (f) return [f, { message: 'fake failure' }];
      const b = JSON.parse(r.raw) as { title?: string; body?: string; labels?: string[] };
      if (typeof b.title !== 'string' || b.title === '') return [422, { message: 'Validation Failed' }];
      const issue = this.seed({ title: b.title, body: b.body ?? '', labels: b.labels ?? [] });
      return [201, this.view(issue)];
    }
    const m = /^\/issues\/(\d+)(\/comments)?$/.exec(r.path.slice(repoBase.length));
    const issue = m ? this.issues.find((i) => i.number === Number(m[1])) : undefined;
    if (!m || !issue) return [404, { message: 'Not Found' }];
    if (r.method === 'POST' && m[2]) {
      const f = this.failing('comment');
      if (f) return [f, { message: 'fake failure' }];
      const b = JSON.parse(r.raw) as { body?: string };
      issue.comments.push(b.body ?? '');
      return [201, { id: issue.comments.length, body: b.body }];
    }
    if (r.method === 'PATCH' && !m[2]) {
      const f = this.failing('close');
      if (f) return [f, { message: 'fake failure' }];
      const b = JSON.parse(r.raw) as { state?: string };
      if (b.state === 'closed' || b.state === 'open') issue.state = b.state;
      return [200, this.view(issue)];
    }
    return [404, { message: 'Not Found' }];
  }

  private view(i: FakeIssue): Record<string, unknown> {
    return { number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map((name) => ({ name })) };
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
  fingerprint: string;
}

/** Alertmanager 기본 웹훅 본문(판 4) */
export function webhook(alerts: AlertInput[]): Record<string, unknown> {
  const status = alerts.some((a) => (a.status ?? 'firing') === 'firing') ? 'firing' : 'resolved';
  return {
    version: '4',
    groupKey: '{}:{alertname="vt53"}',
    truncatedAlerts: 0,
    status,
    receiver: 'github-issues',
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: 'http://alertmanager.observability.svc:9093',
    alerts: alerts.map((a) => ({
      status: a.status ?? 'firing',
      labels: a.labels,
      annotations: a.annotations ?? { summary: '시험 경보' },
      startsAt: '2026-11-30T23:50:00.000Z',
      endsAt: (a.status ?? 'firing') === 'resolved' ? '2026-12-01T00:10:00.000Z' : '0001-01-01T00:00:00Z',
      generatorURL: 'http://prometheus.observability.svc:9090/graph',
      fingerprint: a.fingerprint,
    })),
  };
}

export async function send(app: AlertIssueRelayApp, body: unknown, token: string | null = TOKEN): Promise<{ statusCode: number; contentType: string; json: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await app.service.http.inject({ method: 'POST', url: '/v1/alerts', headers, payload: typeof body === 'string' ? body : JSON.stringify(body) });
  let json: unknown = null;
  try {
    json = JSON.parse(res.payload) as unknown;
  } catch {
    json = null;
  }
  return { statusCode: res.statusCode, contentType: String(res.headers['content-type'] ?? ''), json };
}

export async function metricsText(app: AlertIssueRelayApp): Promise<string> {
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

/** 시험 환경 값(계획 §5 '환경 값' 여섯과 서비스 공통 PEAKET_ENV) */
export function envFor(github: FakeGitHub, key: AppKey): Record<string, string> {
  return {
    PEAKET_ENV: 'ci',
    PEAKET_ALERT_RELAY_TOKEN: TOKEN,
    PEAKET_GITHUB_API_URL: github.url,
    PEAKET_GITHUB_APP_ID: APP_ID,
    PEAKET_GITHUB_INSTALLATION_ID: INSTALLATION_ID,
    PEAKET_GITHUB_PRIVATE_KEY_FILE: key.privateKeyFile,
    PEAKET_GITHUB_REPOSITORY: `${OWNER}/${REPO_NAME}`,
  };
}

/** 계획 §5 '환경 값'(모두 필수) */
export const REQUIRED_ENV = [
  'PEAKET_ALERT_RELAY_TOKEN',
  'PEAKET_GITHUB_API_URL',
  'PEAKET_GITHUB_APP_ID',
  'PEAKET_GITHUB_INSTALLATION_ID',
  'PEAKET_GITHUB_PRIVATE_KEY_FILE',
  'PEAKET_GITHUB_REPOSITORY',
] as const;

/** 티켓 본문의 지문 표시 줄(observability.md §5 티켓 중계) */
export const fingerprintLine = (fp: string) => `peaket-alert-fingerprint: ${fp}`;

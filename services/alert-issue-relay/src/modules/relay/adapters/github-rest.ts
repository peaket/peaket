// GitHub Issues 어댑터(티켓 중계의 바깥 호출). 정본: docs/observability.md §5 '경보 보내는 길' 티켓 중계,
// 계획 docs/review/plans/F-01-6.md §3 '티켓 중계'·§5 '중계가 부르는 GitHub 경로'.
// - GitHub 앱 JWT(RS256, iat 60초 전·exp 9분 뒤)로 설치 토큰을 받고, 만료 5분 전까지 다시 쓴다. 401이면 버리고 한 번 다시 받는다.
// - 모든 요청에 Accept: application/vnd.github+json·X-GitHub-Api-Version: 2022-11-28을 싣는다.
// - 실패(무응답·5xx·4xx)는 GitHubUnavailable로 올려 웹훅이 502로 답하게 한다.
import { sign } from 'node:crypto';
import { type Clock, createExternalHttpClient, type ExternalHttpClient, maskPiiText } from '@peaket/platform';
import { ALERT_LABEL, hasFingerprint, issueBody, issueTitle, type AlertInput, type IssueRef } from '../domain/alert.js';
import { GitHubUnavailable, type GitHubIssuesPort } from '../domain/github-issues.js';

const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';
const TOKEN_REFRESH_BEFORE_MS = 5 * 60 * 1000;

interface Token {
  value: string;
  expiresAt: number;
}

interface IssueView {
  number?: unknown;
  state?: unknown;
  body?: unknown;
  labels?: unknown;
}

const labelNames = (labels: unknown): string[] =>
  (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : typeof l === 'object' && l !== null && typeof (l as { name?: unknown }).name === 'string' ? (l as { name: string }).name : ''));

export interface GitHubRestOptions {
  apiUrl: string;
  appId: string;
  installationId: string;
  privateKey: import('node:crypto').KeyObject;
  owner: string;
  repository: string;
  clock: Clock;
  fetch?: typeof fetch;
}

export class GitHubRest implements GitHubIssuesPort {
  readonly #o: GitHubRestOptions;
  readonly #client: ExternalHttpClient;
  #token: Token | undefined;

  constructor(o: GitHubRestOptions) {
    this.#o = o;
    this.#client = createExternalHttpClient({
      provider: 'github',
      baseUrl: o.apiUrl,
      timeoutCapMs: 15_000,
      clock: o.clock,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
  }

  async findOpen(fingerprint: string): Promise<IssueRef | null> {
    for (let page = 1; ; page++) {
      const res = await this.#request('GET', '/repos/{owner}/{name}/issues', { owner: this.#o.owner, name: this.#o.repository }, { state: 'open', labels: ALERT_LABEL, per_page: 100, page });
      const list = (await res.json()) as unknown;
      if (!Array.isArray(list)) throw new GitHubUnavailable('GitHub 이슈 목록 응답이 배열이 아니다');
      for (const raw of list) {
        const issue = raw as IssueView;
        if (typeof issue.number !== 'number') continue;
        if (issue.state !== 'open') continue;
        if (!labelNames(issue.labels).includes(ALERT_LABEL)) continue;
        if (hasFingerprint(typeof issue.body === 'string' ? issue.body : undefined, fingerprint)) return { number: issue.number };
      }
      if (list.length < 100) return null;
    }
  }

  async create(alert: AlertInput): Promise<IssueRef> {
    const res = await this.#request(
      'POST',
      '/repos/{owner}/{name}/issues',
      { owner: this.#o.owner, name: this.#o.repository },
      undefined,
      { title: issueTitle(alert, maskPiiText), body: issueBody(alert, maskPiiText), labels: [ALERT_LABEL] },
    );
    const issue = (await res.json()) as IssueView;
    if (typeof issue.number !== 'number') throw new GitHubUnavailable('GitHub 이슈 만들기 응답에 번호가 없다');
    return { number: issue.number };
  }

  async comment(issue: IssueRef, body: string): Promise<void> {
    await this.#request('POST', '/repos/{owner}/{name}/issues/{number}/comments', { owner: this.#o.owner, name: this.#o.repository, number: issue.number }, undefined, { body });
  }

  async close(issue: IssueRef): Promise<void> {
    await this.#request('PATCH', '/repos/{owner}/{name}/issues/{number}', { owner: this.#o.owner, name: this.#o.repository, number: issue.number }, undefined, { state: 'closed' });
  }

  async #request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    params: Record<string, string | number>,
    query: Record<string, string | number | undefined> | undefined,
    body?: unknown,
    retried = false,
  ): Promise<Response> {
    const token = await this.#installationToken();
    const headers: Record<string, string> = { accept: ACCEPT, 'x-github-api-version': API_VERSION, authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.#client.request({
      method,
      path,
      params,
      ...(query ? { query } : {}),
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 && !retried) {
      this.#token = undefined;
      return this.#request(method, path, params, query, body, true);
    }
    if (!res.ok) throw new GitHubUnavailable(`GitHub ${method} ${path} → ${res.status}`);
    return res;
  }

  async #installationToken(): Promise<string> {
    const now = this.#o.clock.now();
    if (this.#token && now < this.#token.expiresAt - TOKEN_REFRESH_BEFORE_MS) return this.#token.value;
    const res = await this.#client.request({
      method: 'POST',
      path: '/app/installations/{installationId}/access_tokens',
      params: { installationId: this.#o.installationId },
      headers: { accept: ACCEPT, 'x-github-api-version': API_VERSION, authorization: `Bearer ${this.#jwt(now)}` },
    });
    if (!res.ok) throw new GitHubUnavailable(`GitHub 설치 토큰 → ${res.status}`);
    const parsed = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof parsed.token !== 'string' || typeof parsed.expires_at !== 'string') throw new GitHubUnavailable('GitHub 설치 토큰 응답이 이상하다');
    const expiresAt = Date.parse(parsed.expires_at);
    if (!Number.isFinite(expiresAt)) throw new GitHubUnavailable('GitHub 설치 토큰 만료 시각이 이상하다');
    this.#token = { value: parsed.token, expiresAt };
    return parsed.token;
  }

  /** GitHub 앱 JWT(RS256). iat는 60초 전, exp는 9분 뒤(10분을 넘지 않는다) */
  #jwt(nowMs: number): string {
    const now = Math.floor(nowMs / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.#o.appId })).toString('base64url');
    const data = `${header}.${payload}`;
    const signature = sign('RSA-SHA256', Buffer.from(data), this.#o.privateKey).toString('base64url');
    return `${data}.${signature}`;
  }
}

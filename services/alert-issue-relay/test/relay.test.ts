// 티켓 중계 시험(기능 F-01-6, OPS-110, 시험 V-T53 ④⑤⑥). 계획 docs/review/plans/F-01-6.md §3 '티켓 중계'·§5·§6.
// 정본: docs/observability.md §5 '경보 보내는 길'(티켓 중계: sev3만, 지문마다 열린 티켓 하나, 해제 때 댓글과 닫기, 실패하면 502,
// 토큰이 없거나 틀리면 401과 보안 사건 로그·지표, 결과 지표), 같은 절 '문구에 싣는 것'(싣는 칸, 2차 마스킹 꼴),
// docs/verification.md V-T53 ④⑤⑥, docs/security/asvs/delivery.md 14.2.3·16.3.3.
// 웹훅(HTTP inject) → 고르기·지문 확인·가림 → GitHub 호출까지 부르는 쪽을 통째로 본다. 가짜는 GitHub API와 시계뿐이다(support.ts).
// real-time: 중계는 GitHub를 주소(PEAKET_GITHUB_API_URL)로만 받는다(계획 §5). 그래서 가짜 GitHub는 127.0.0.1의 실제 node:http 수신기다. Docker는 쓰지 않는다 F-01-6
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock, type FakeClock } from '@peaket/platform';
import { buildAlertIssueRelay, type AlertIssueRelayApp } from '../src/relay-app.js';
import {
  ALERT_LABEL,
  type AppKey,
  envFor,
  FakeGitHub,
  fingerprintLine,
  INSTALL_TOKEN_PREFIX,
  logSink,
  makeAppKey,
  metric,
  metricsText,
  REQUIRED_ENV,
  send,
  TOKEN,
  webhook,
  WRONG_TOKEN,
} from './support.js';

// 실제 시각과 멀리 떨어진 시험 시각(중계가 주입한 시계 대신 벽시계로 JWT를 만들면 가짜 GitHub가 거절한다)
const START = '2026-12-01T00:00:00.000Z';
// 2차 마스킹의 가림 표시 원천(docs/observability.md §7 '2차 마스킹 정규식 원천')
const MASK = (JSON.parse(readFileSync(new URL('../../../packages/platform/src/pii-patterns.json', import.meta.url), 'utf8')) as { mask: string }).mask;
const T = { timeout: 30_000 };

interface Harness {
  app: AlertIssueRelayApp;
  github: FakeGitHub;
  clock: FakeClock;
  logs: ReturnType<typeof logSink>;
  key: AppKey;
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function harness(): Promise<Harness> {
  const clock = fakeClock({ now: Date.parse(START), monotonic: 5_000_000 });
  const key = makeAppKey();
  cleanups.push(() => key.remove());
  const github = new FakeGitHub({ publicKey: key.publicKey, now: () => clock.now() });
  await github.start();
  cleanups.push(() => github.close());
  const logs = logSink();
  const app = await buildAlertIssueRelay({ env: envFor(github, key), clock, logDestination: logs.stream });
  cleanups.push(() => app.service.close());
  return { app, github, clock, logs, key };
}

const sev3 = (fingerprint: string, alertname = 'VtfiveThreeTicket', extra: { labels?: Record<string, string>; annotations?: Record<string, string>; status?: 'firing' | 'resolved' } = {}) => ({
  fingerprint,
  status: extra.status,
  labels: { alertname, severity: 'sev3', kind: 'hygiene', ...extra.labels },
  annotations: extra.annotations ?? { summary: `${alertname} 요약`, runbook_url: `https://runbooks.peaket.test/${alertname}`, dashboard_url: `https://grafana.peaket.test/d/${alertname}` },
});

async function deliver(h: Harness, body: unknown, token: string | null = TOKEN) {
  const r = await send(h.app, body, token);
  await h.app.idle();
  return r;
}

const decisions = async (h: Harness) => {
  const m = await metricsText(h.app);
  return Object.fromEntries(['created', 'duplicate', 'closed', 'ignored'].map((d) => [d, metric(m, 'alert_relay_alerts_total', { decision: d })]));
};

describe('V-T53 티켓 중계', () => {
  test('V-T53 ④ 같은 SEV3는 티켓 하나만 열리고 해제 때 닫힌다', T, async () => {
    const h = await harness();
    const fp = 'a1b2c3d4e5f60718';

    // 첫 발생: 티켓 하나
    const first = await deliver(h, webhook([sev3(fp)]));
    expect(first.statusCode).toBe(202);
    expect(first.json).toEqual({ accepted: 1 });
    expect(h.github.issues).toHaveLength(1);
    const issue = h.github.issues[0]!;
    expect(issue.state).toBe('open');
    expect(issue.labels).toContain(ALERT_LABEL);
    expect(issue.title).toContain('VtfiveThreeTicket');
    expect(h.github.issuesFor(fp).map((i) => i.number)).toEqual([issue.number]);

    // 같은 지문 다시: 새 티켓 없음
    const again = await deliver(h, webhook([sev3(fp)]));
    expect(again.statusCode).toBe(202);
    expect(again.json).toEqual({ accepted: 1 });
    expect(h.github.issues).toHaveLength(1);
    expect(await decisions(h)).toEqual({ created: 1, duplicate: 1, closed: 0, ignored: 0 });

    // SEV1·SEV2는 GitHub를 부르지 않는다
    const before = h.github.requests.length;
    const others = await deliver(
      h,
      webhook([
        { fingerprint: 'b000000000000001', labels: { alertname: 'VtfiveThreePage', severity: 'sev1', kind: 'budget' } },
        { fingerprint: 'b000000000000002', labels: { alertname: 'VtfiveThreeSlack', severity: 'sev2', kind: 'slo' } },
      ]),
    );
    expect(others.statusCode).toBe(202);
    expect(others.json).toEqual({ accepted: 2 });
    expect(h.github.requests.length).toBe(before);
    expect(await decisions(h)).toEqual({ created: 1, duplicate: 1, closed: 0, ignored: 2 });

    // 해제: 그 티켓에 댓글 하나와 닫기 하나
    const resolved = await deliver(h, webhook([sev3(fp, 'VtfiveThreeTicket', { status: 'resolved' })]));
    expect(resolved.statusCode).toBe(202);
    expect(issue.state).toBe('closed');
    expect(issue.comments).toHaveLength(1);
    const writes = h.github.writes().map((r) => `${r.method} ${r.path}`);
    expect(writes).toEqual(['POST /repos/peaket-test/ops-alerts/issues', `POST /repos/peaket-test/ops-alerts/issues/${issue.number}/comments`, `PATCH /repos/peaket-test/ops-alerts/issues/${issue.number}`]);
    expect(JSON.parse(h.github.writes().at(-1)!.raw)).toEqual({ state: 'closed' });
    expect(await decisions(h)).toEqual({ created: 1, duplicate: 1, closed: 1, ignored: 2 });

    // 열린 티켓이 없는 해제는 세기만 한다
    const writesBefore = h.github.writes().length;
    expect((await deliver(h, webhook([sev3(fp, 'VtfiveThreeTicket', { status: 'resolved' })]))).statusCode).toBe(202);
    expect(h.github.writes().length).toBe(writesBefore);
    expect(await decisions(h)).toEqual({ created: 1, duplicate: 1, closed: 1, ignored: 3 });

    // 설치 토큰은 한 번 받아 다시 쓴다
    expect(h.github.tokenRequests().map((r) => r.status)).toEqual([201]);
    // 모든 GitHub 호출은 GitHub REST 머리를 싣는다(계획 §5)
    for (const r of h.github.requests) {
      expect(r.headers.accept).toBe('application/vnd.github+json');
      expect(r.headers['x-github-api-version']).toBe('2022-11-28');
    }
    // 이슈 목록은 열린 경보 티켓만, 쪽 크기 100으로 읽는다
    const lists = h.github.requests.filter((r) => r.method === 'GET');
    expect(lists.length).toBeGreaterThan(0);
    for (const r of lists) expect({ state: r.query.state, labels: r.query.labels, per_page: r.query.per_page }).toEqual({ state: 'open', labels: ALERT_LABEL, per_page: '100' });

    // 설치 토큰이 1시간 뒤 만료되면 새로 받는다(만료된 토큰으로 쓰지 않는다)
    h.clock.advance(61 * 60 * 1000);
    expect((await deliver(h, webhook([sev3('c0ffee0000000001', 'VtfiveThreeLater')])))).toMatchObject({ statusCode: 202 });
    expect(h.github.issuesFor('c0ffee0000000001')).toHaveLength(1);
    expect(h.github.tokenRequests().filter((r) => r.status === 201)).toHaveLength(2);
    expect(h.github.jwtRejected).toBe(0);
  });

  test('V-T53 ④ 열린 티켓이 100건·101건이어도 같은 지문을 찾고 라벨·상태·지문 줄이 다른 티켓은 겹침으로 보지 않는다', T, async () => {
    const h = await harness();
    // 목록은 만든 차례의 역순이라 가장 먼저 만든 티켓이 마지막 쪽에 간다
    const onPage2 = 'f00000000000page2';
    h.github.seed({ body: `요약\n\n${fingerprintLine(onPage2)}\n` });
    for (let i = 0; i < 100; i++) h.github.seed({ body: `filler\n${fingerprintLine(`e${String(i).padStart(15, '0')}`)}` });
    // 열린 경보 티켓 101건: 둘째 쪽의 지문
    expect(h.github.issues.filter((i) => i.state === 'open' && i.labels.includes(ALERT_LABEL))).toHaveLength(101);
    expect((await deliver(h, webhook([sev3(onPage2)]))).statusCode).toBe(202);
    expect(h.github.issuesFor(onPage2)).toHaveLength(1);
    expect(h.github.writes()).toEqual([]);
    expect(await decisions(h)).toEqual({ created: 0, duplicate: 1, closed: 0, ignored: 0 });
    // 쪽을 끝까지 읽었다(1쪽·2쪽)
    expect(h.github.requests.filter((r) => r.method === 'GET').map((r) => r.query.page ?? '1')).toEqual(expect.arrayContaining(['1', '2']));

    // 첫 쪽 맨 끝(100번째)의 지문
    const lastOnPage1 = `e${String(0).padStart(15, '0')}`;
    expect((await deliver(h, webhook([sev3(lastOnPage1)]))).statusCode).toBe(202);
    expect(h.github.writes()).toEqual([]);

    // 겹침이 아닌 것: 경보 라벨이 없는 티켓, 닫힌 티켓, 지문 줄이 더 긴 티켓
    const noLabel = 'd000000000nolabel';
    const closed = 'd0000000000closed';
    const longer = 'd0000000000prefix';
    h.github.seed({ body: fingerprintLine(noLabel), labels: ['bug'] });
    h.github.seed({ body: fingerprintLine(closed), state: 'closed' });
    h.github.seed({ body: fingerprintLine(`${longer}0`) });
    for (const fp of [noLabel, closed, longer]) expect((await deliver(h, webhook([sev3(fp)]))).statusCode).toBe(202);
    for (const fp of [noLabel, closed, longer]) {
      const created = h.github.issues.filter((i) => i.labels.includes(ALERT_LABEL) && i.state === 'open' && i.body.split(/\r?\n/).some((l) => l.trim() === fingerprintLine(fp)));
      expect(created, fp).toHaveLength(1);
    }
    expect(await decisions(h)).toEqual({ created: 3, duplicate: 2, closed: 0, ignored: 0 });
  });

  test('V-T53 ④ 같은 지문을 동시에 두 번 받아도 티켓은 하나다', T, async () => {
    const h = await harness();
    const fp = '5a5a5a5a5a5a5a5a';
    const [a, b] = await Promise.all([send(h.app, webhook([sev3(fp)])), send(h.app, webhook([sev3(fp)]))]);
    await h.app.idle();
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(h.github.issuesFor(fp)).toHaveLength(1);
    expect(await decisions(h)).toEqual({ created: 1, duplicate: 1, closed: 0, ignored: 0 });
  });

  test('V-T53 ④ GitHub가 실패하면 502로 답해 다시 받게 한다', T, async () => {
    const h = await harness();
    const fp = '0e0e0e0e0e0e0e0e';
    const body = webhook([sev3(fp)]);

    // 이슈 만들기 500 → 502 Problem, 티켓 없음
    h.github.failNext('create', 500);
    const failed = await deliver(h, body);
    expect(failed.statusCode).toBe(502);
    expect(failed.contentType).toMatch(/^application\/problem\+json/);
    expect(h.github.issuesFor(fp)).toEqual([]);

    // Alertmanager가 같은 몸을 다시 보낸다 → 티켓 하나
    const retried = await deliver(h, body);
    expect(retried.statusCode).toBe(202);
    expect(h.github.issuesFor(fp)).toHaveLength(1);

    // 목록 읽기 503도 502이고, 다시 보내면 겹치지 않는다(이미 열린 티켓)
    h.github.failNext('list', 503);
    expect((await deliver(h, body)).statusCode).toBe(502);
    expect((await deliver(h, body)).statusCode).toBe(202);
    expect(h.github.issuesFor(fp)).toHaveLength(1);

    // 설치 토큰 받기가 실패해도 502
    const fp2 = '0f0f0f0f0f0f0f0f';
    h.github.revokeTokens();
    h.github.failNext('token', 500);
    expect((await deliver(h, webhook([sev3(fp2)]))).statusCode).toBe(502);
    expect(h.github.issuesFor(fp2)).toEqual([]);
    expect((await deliver(h, webhook([sev3(fp2)]))).statusCode).toBe(202);
    expect(h.github.issuesFor(fp2)).toHaveLength(1);

    // 설치 토큰이 무르게 되면(401) 버리고 한 번 다시 받아 성공한다
    const fp3 = '0d0d0d0d0d0d0d0d';
    const tokensBefore = h.github.issuedTokens.length;
    h.github.revokeTokens();
    expect((await deliver(h, webhook([sev3(fp3)]))).statusCode).toBe(202);
    expect(h.github.issuesFor(fp3)).toHaveLength(1);
    expect(h.github.issuedTokens.length).toBe(tokensBefore + 1);
    expect(h.github.requests.some((r) => r.status === 401 && !r.path.startsWith('/app/'))).toBe(true);
    expect(h.github.jwtRejected).toBe(0);
  });

  test('V-T53 ④ 환경 값이 하나라도 없으면 듣기 전에 시작이 실패한다', T, async () => {
    const clock = fakeClock({ now: Date.parse(START) });
    const key = makeAppKey();
    cleanups.push(() => key.remove());
    const github = new FakeGitHub({ publicKey: key.publicKey, now: () => clock.now() });
    await github.start();
    cleanups.push(() => github.close());
    const full = envFor(github, key);

    // 다 있으면 만들어진다(아래 거절이 늘 던지는 결함이 아님을 본다)
    const ok = await buildAlertIssueRelay({ env: full, clock, logDestination: logSink().stream });
    await ok.service.close();

    for (const name of REQUIRED_ENV) {
      const env: Record<string, string | undefined> = { ...full };
      delete env[name];
      await expect(buildAlertIssueRelay({ env, clock, logDestination: logSink().stream }), `${name} 없음`).rejects.toThrow();
      await expect(buildAlertIssueRelay({ env: { ...full, [name]: '' }, clock, logDestination: logSink().stream }), `${name} 빈 값`).rejects.toThrow();
    }
    // 키 파일을 읽지 못한다
    await expect(buildAlertIssueRelay({ env: { ...full, PEAKET_GITHUB_PRIVATE_KEY_FILE: `${key.dir}/missing.pem` }, clock, logDestination: logSink().stream })).rejects.toThrow();
    // 시작하지 못한 판은 GitHub를 부르지 않았다
    expect(github.requests).toEqual([]);
  });

  test('V-T53 ④ 몸이 Alertmanager 웹훅 꼴이 아니면 400이고 GitHub를 부르지 않는다', T, async () => {
    const h = await harness();
    for (const bad of ['{"version":"4"', JSON.stringify({ version: '4' }), JSON.stringify({ version: '4', alerts: [{ status: 'firing', labels: { alertname: 'x', severity: 'sev3' } }] })]) {
      const r = await deliver(h, bad);
      expect(r.statusCode, bad).toBe(400);
      expect(r.contentType).toMatch(/^application\/problem\+json/);
    }
    expect(h.github.requests).toEqual([]);
  });

  test('V-T53 ⑤ [ASVS v5.0.0-14.2.3] 티켓 본문에 목록 밖 칸과 개인정보 꼴이 없다', T, async () => {
    const h = await harness();
    const ACCOUNT_ID = 'acct-7f3a';
    const EMAIL = 'kim@example.com';
    const PHONE = '010-1234-5678';
    const DESCRIPTION_MARK = 'vt53-description-mark-4e1b';
    const RUNBOOK = 'https://runbooks.peaket.test/vt53-pii';
    const fpA = '7a7a7a7a7a7a7a7a';
    const fpB = '7b7b7b7b7b7b7b7b';

    // 목록 밖 라벨과 description 주석에 식별값
    expect(
      (
        await deliver(
          h,
          webhook([
            sev3(fpA, 'VtfiveThreePiiLabel', {
              labels: { account_id: ACCOUNT_ID },
              annotations: { summary: '결제 승인 지연 표지', description: `${DESCRIPTION_MARK} ${EMAIL} ${PHONE}`, runbook_url: RUNBOOK, dashboard_url: 'https://grafana.peaket.test/d/vt53' },
            }),
          ]),
        )
      ).statusCode,
    ).toBe(202);
    // 싣는 칸(summary) 속 이메일
    expect((await deliver(h, webhook([sev3(fpB, 'VtfiveThreePiiSummary', { annotations: { summary: `문의 ${EMAIL} 처리 지연`, runbook_url: RUNBOOK } })]))).statusCode).toBe(202);
    // 해제 댓글도 같은 원문 검사에 든다
    expect((await deliver(h, webhook([sev3(fpA, 'VtfiveThreePiiLabel', { status: 'resolved', labels: { account_id: ACCOUNT_ID }, annotations: { summary: '결제 승인 지연 표지', description: `${DESCRIPTION_MARK} ${EMAIL} ${PHONE}`, runbook_url: RUNBOOK } })]))).statusCode).toBe(202);

    expect(h.github.issues).toHaveLength(2);
    const sent = h.github.writes().map((r) => r.raw).join('\n');
    // 빈 글이 통과로 새지 않게: 싣는 칸·지문 줄·가림 표시는 있다
    expect(sent).toContain('결제 승인 지연 표지');
    expect(sent).toContain(RUNBOOK);
    expect(sent).toContain(fingerprintLine(fpA));
    expect(sent).toContain(fingerprintLine(fpB));
    expect(sent).toContain(MASK);
    // 원문 바이트 어디에도(제목·본문·댓글, 경로·쿼리까지) 넣은 값이 없다
    const all = h.github.allText();
    expect(all).not.toContain(ACCOUNT_ID);
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain(PHONE);
    expect(all).not.toContain(DESCRIPTION_MARK);
    expect(all).not.toContain('account_id');
    // 이메일이 든 summary의 나머지 글은 남는다(가림이 칸을 통째로 지우지 않는다)
    const b = h.github.issuesFor(fpB)[0]!;
    expect(b.body).toContain(`문의 ${MASK} 처리 지연`);
  });

  test('V-T53 ⑥ [ASVS v5.0.0-16.3.3] 토큰이 없거나 틀리면 401이고 GitHub를 부르지 않는다', T, async () => {
    const h = await harness();
    const body = webhook([sev3('9e9e9e9e9e9e9e9e')]);

    const missing = await deliver(h, body, null);
    const mismatch = await deliver(h, body, WRONG_TOKEN);
    for (const r of [missing, mismatch]) {
      expect(r.statusCode).toBe(401);
      expect(r.contentType).toMatch(/^application\/problem\+json/);
    }
    expect(h.github.requests).toEqual([]);

    const rejected = h.logs.lines().filter((l) => l.event === 'alert_relay_rejected');
    expect(rejected.map((l) => l.reason).sort()).toEqual(['mismatch', 'missing']);
    let m = await metricsText(h.app);
    expect(metric(m, 'alert_relay_rejected_total', { reason: 'missing' })).toBe(1);
    expect(metric(m, 'alert_relay_rejected_total', { reason: 'mismatch' })).toBe(1);
    expect(await decisions(h)).toEqual({ created: 0, duplicate: 0, closed: 0, ignored: 0 });

    // 맞는 토큰은 받는다(가드가 늘 거절하는 결함을 잡는다). 거절 수는 그대로
    expect((await deliver(h, body, TOKEN)).statusCode).toBe(202);
    expect(h.github.issues).toHaveLength(1);
    m = await metricsText(h.app);
    expect(metric(m, 'alert_relay_rejected_total', { reason: 'missing' })).toBe(1);
    expect(metric(m, 'alert_relay_rejected_total', { reason: 'mismatch' })).toBe(1);

    // 모은 로그와 지표 어디에도 받은 토큰(틀린 것·맞는 것), 설치 토큰, 앱 개인 키가 없다
    const text = h.logs.text();
    for (const secret of [WRONG_TOKEN, TOKEN, INSTALL_TOKEN_PREFIX, 'BEGIN RSA PRIVATE KEY', h.key.privateKeyPem.split('\n')[1]!]) {
      expect(text).not.toContain(secret);
      expect(m).not.toContain(secret);
    }
  });
});

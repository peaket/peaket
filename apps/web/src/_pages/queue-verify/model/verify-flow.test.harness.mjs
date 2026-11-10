// SCR-009 흐름 시험의 공용 틀(가짜 시계·타이머·위젯·가짜 queue-svc). 시험 파일이 아니다(node --test의 기본 이름 틀 *.test.mjs에 맞지 않는다. 이름의 .test.는 화면 린트가 Node 전용 파일로 보게 한다).
// 가짜 서버는 identity-svc의 재통과 기록도 흉내 낸다: 재통과 전 제출은 REVERIFY_REQUIRED(서버가 trust-svc를 부르지 않는다, ADR-0259 결정 1),
// 시험이 h.reverify()로 본인확인을 마치면 그 뒤 제출부터 next에 넣은 응답(없으면 PASSED)을 쓴다. 새로고침(흐름을 새로 만듦)을 넘어 상태를 이어 간다.
import { register } from 'node:module';

register('../../../shared/lib/test-ts-resolve.mjs', import.meta.url);
export const { createVerifyFlow, TOKEN_MAX_AGE_MS, AUTO_RETRY_MAX } = await import('./verify-flow.ts');

export const NOW = 1_800_000_000_000;
export const RECEIVED = '2026-11-10T03:00:00.000Z';
export const apiError = (status, type, retryAfter = null, extensions = {}) => Object.assign(new Error(type), { status, type, retryAfter, date: null, extensions });
export const memory = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
export const queueRecord = (extra = {}) => JSON.stringify({ preverifyToken: 'pv', ticket: { queueTicket: 'qt-1', seq: 1234, generation: 1, segment: 1 }, savedAt: NOW - 60_000, ...extra });

/** 가짜 queue-svc: 상태 읽기·제출·이의·입장 확정. next에 넣은 제출 응답(응답이나 {throw})은 재통과 뒤 제출에 차례로 쓴다 */
export function fakeServer(o = {}) {
  const s = {
    state: o.state ?? 'VERIFYING',
    reason: o.reason === undefined ? 'RAPID_REQUESTS' : o.reason,
    appeal: o.appeal ?? null,
    passedVia: o.passedVia ?? null,
    graceUntil: o.graceUntil ?? null,
    /** identity-svc 쪽: 추가 검증을 시작한 뒤 같은 사람의 재통과가 있는가 */
    reverified: o.reverified ?? false,
    reads: 0,
    submits: [],
    admits: [],
    next: [],
    readNext: [],
    admitReply: o.admitReply ?? { status: 200, body: { status: 'NOT_YET', retryAfterMs: 5000 } },
  };
  s.read = async () => {
    s.reads++;
    const q = s.readNext.shift();
    if (q?.throw) throw q.throw;
    if (q) return q;
    return { state: s.state, verificationReason: s.reason, passedVia: s.passedVia, graceUntil: s.graceUntil, appeal: s.appeal };
  };
  s.submit = async (body, now) => {
    s.submits.push({ at: now, body });
    if ('appeal' in body) {
      const q = s.next[0]?.appeal ? s.next.shift() : undefined;
      if (q?.throw) throw q.throw;
      if (q) return q;
      s.appeal ??= { appealId: '11111111-1111-4111-8111-111111111111', receivedAt: RECEIVED, text: body.appeal };
      return { status: 202, body: { appealId: s.appeal.appealId, receivedAt: s.appeal.receivedAt } };
    }
    if (s.state === 'PASSED') return { status: 200, body: { result: 'PASSED', queueNumber: 1234, graceUntil: s.graceUntil } };
    // 재통과 확인을 먼저 묻는다: 없으면 trust-svc를 부르지 않고 REVERIFY_REQUIRED
    if (!s.reverified) return { status: 200, body: { result: 'REVERIFY_REQUIRED' } };
    const q = s.next.shift();
    if (q?.throw) throw q.throw;
    if (q) {
      if (q.body?.result === 'PASSED') Object.assign(s, { state: 'PASSED', passedVia: 'CHALLENGE', graceUntil: q.body.graceUntil ?? null });
      return q;
    }
    Object.assign(s, { state: 'PASSED', passedVia: 'CHALLENGE' });
    return { status: 200, body: { result: 'PASSED', queueNumber: 1234, graceUntil: s.graceUntil } };
  };
  s.admit = async (body) => {
    s.admits.push(body);
    const r = s.admitReply;
    if (r.throw) throw r.throw;
    return r;
  };
  /** 사람 확인 토큰 제출만 */
  s.challenges = () => s.submits.filter((x) => 'challengeToken' in x.body);
  s.appeals = () => s.submits.filter((x) => 'appeal' in x.body);
  return s;
}

export function harness(o = {}) {
  let now = o.now ?? NOW;
  let visible = true;
  const timers = new Map();
  let seq = 0;
  const vis = new Set();
  const server = o.server ?? fakeServer();
  const local = o.local ?? memory({ 'peaket.queue.e1': queueRecord() });
  const session = o.session ?? memory();
  const navs = [];
  const views = [];
  const checks = [];
  let tokenSeq = 0;
  const human = o.human ?? (() => `hc-${++tokenSeq}`);
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const make = () =>
    createVerifyFlow({
      eventId: o.eventId ?? 'e1',
      now: () => now,
      random: () => 0.5,
      setTimer: (fn, ms) => {
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
      visible: () => visible,
      onVisible: (cb) => {
        vis.add(cb);
        return () => vis.delete(cb);
      },
      humanCheck: async () => {
        checks.push(now);
        return human();
      },
      read: () => server.read(now),
      submit: (body) => server.submit(body, now),
      admit: (body) => server.admit(body, now),
      deviceId: () => 'AAAAAAAAAAAAAAAAAAAAAA',
      local,
      session,
      navigate: (u) => navs.push(u),
      onChange: (v) => views.push(v),
      ...(o.tokenMaxAgeMs !== undefined ? { tokenMaxAgeMs: o.tokenMaxAgeMs } : {}),
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      ...(o.autoRetries !== undefined ? { autoRetries: o.autoRetries } : {}),
      leaveAfterMs: o.leaveAfterMs ?? 1000,
    });
  const h = {
    f: make(),
    server,
    local,
    session,
    navs,
    views,
    checks,
    last: () => views[views.length - 1],
    flush,
    get now() {
      return now;
    },
    /** 시계를 ms만큼 옮기며 그 사이의 타이머를 차례로 부른다 */
    async run(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    setVisible(v) {
      visible = v;
      if (v) for (const cb of [...vis]) cb();
    },
    /** ③ 본인확인을 마침: identity-svc에 재통과가 남고, 화면 기관 창이 success를 알린다 */
    async reverify() {
      server.reverified = true;
      h.f.reverified();
      await flush();
    },
    /** 새로고침: 앞 흐름을 버리고 같은 서버·저장소로 새 흐름을 만든다 */
    reload() {
      h.f.dispose();
      h.f = make();
    },
  };
  return h;
}

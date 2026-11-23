// 명령 화면 시험(F-03-4)이 함께 쓰는 가짜 관제 REST와 고정 자료(시험 전용). 이름이 *.test.mjs로 끝나지 않아 node --test가 시험 파일로 돌리지 않는다.
// - 전역 fetch 자리에 끼워 REST 경계에서만 답한다. 받은 요청의 메서드·경로·쿼리·머리·본문을 적는다(재인증 토큰·멱등 키를 센다).
// - 응답 모양은 계약(docs/api/openapi.yaml CommandState·CommandDryRun·AdminReauthDone, 문제 응답 application/problem+json)을 따른다.
//   ops-svc 실제 응답과의 짝은 계획 T13~T16(실제 서버 화면 시험)이 같은 흐름으로 본다.

export const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
export const C1 = '6f1c1b5e-1d2a-4f3b-9c4d-5e6f7a8b9c0d';
export const C2 = '7a2d2c6f-2e3b-4a4c-8d5e-6f7a8b9c0d1e';
export const AT = '2026-11-23T11:15:00.000Z';

/** 문제 응답(application/problem+json). type은 주소 꼴(api-client가 끝 경로만 읽는다) */
export const problem = (status, type, extra = {}) =>
  new Response(JSON.stringify({ type: `https://problems.peaket.example/${type}`, title: '서버 원문 제목<b>', status, ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...(extra.retryAfter ? { 'retry-after': String(extra.retryAfter) } : {}) },
  });

export const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 대기 중인 Promise·I/O 차례를 비운다(시간이 아니라 일 차례만 돌린다) */
export const drain = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
};

/**
 * 가짜 관제 REST. on(method, path, handler)로 처리기를 끼우고, 처리기가 배열이면 차례대로 답한다(마지막 것을 되풀이).
 * 처리기는 (req) => Response | Promise<Response>. 없는 경로는 404 not-found.
 */
export function fakeRest() {
  const requests = [];
  const handlers = new Map();
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers ?? undefined).entries());
    const raw = typeof init.body === 'string' ? init.body : undefined;
    let body;
    if (raw !== undefined) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const req = { method, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), headers, body, raw, url: url.href };
    requests.push(req);
    const key = `${method} ${url.pathname}`;
    const h = handlers.get(key);
    if (!h) return problem(404, 'not-found');
    if (Array.isArray(h)) {
      const i = Math.min(h.calls, h.list.length - 1);
      h.calls += 1;
      return h.list[i](req);
    }
    return h(req);
  };
  return {
    requests,
    on(method, path, handler) {
      handlers.set(`${method} ${path}`, Array.isArray(handler) ? Object.assign([], { list: handler, calls: 0 }) : handler);
    },
    /** 경로가 path이고 메서드가 method인 요청 */
    sent(method, path) {
      return requests.filter((r) => r.method === method && (path instanceof RegExp ? path.test(r.path) : r.path === path));
    },
    install() {
      globalThis.fetch = fetchImpl;
    },
  };
}

/** 재인증 1단계에 바로 DONE(패스키까지 확인한 토큰)으로 답하는 처리기. 토큰마다 새 값(jti 한 번)을 준다 */
export function reauthServer(api, { factors = ['password', 'totp', 'passkey'] } = {}) {
  const issued = [];
  api.on('POST', '/v1/ops/auth/reauthentications', () => {
    const token = `reauth.${issued.length + 1}.${'x'.repeat(16)}`;
    issued.push(token);
    return json(200, { next: 'DONE', reauthToken: token, factors, expiresInSeconds: 300 });
  });
  return issued;
}

/** openapi CommandDryRun 판 1. 명령 1(목표 4,000 → 5,200)의 센 값·예측 값은 ops-svc domain/dry-run.ts의 식 이름·넣은 값 이름과 같은 꼴이다 */
export function dryRunAdmissionUp(over = {}) {
  return {
    version: 1,
    approvalMode: 'ONE',
    reauthRequired: false,
    counted: [
      { key: 'currentTarget', value: 4000, source: 'admission-ctrl', measuredAt: AT },
      { key: 'slotsUsed', value: 3900, source: 'admission-ctrl', measuredAt: AT },
      { key: 'soonAdmitted', value: 260, source: 'queue-redis', measuredAt: AT },
      { key: 'admitRatio', value: 0.5, source: 'queue-redis', measuredAt: AT },
      { key: 'avgDwellSeconds', value: 200, source: 'purchase-db', measuredAt: AT },
      { key: 'servingRateCap', value: 940, source: 'admission-ctrl', measuredAt: AT },
    ],
    predicted: [
      { key: 'vacancy', value: 940, formula: 'targetNew − slotsUsed − soonAdmitted − inFlight', inputs: { targetNew: 5200, slotsUsed: 3900, soonAdmitted: 260, inFlight: 100 }, assumptions: [] },
      { key: 'fillSeconds', value: 2, formula: 'vacancy ÷ admitRatio ÷ servingRateCap', inputs: { vacancy: 940, admitRatio: 0.5, servingRateCap: 940 }, assumptions: [] },
      { key: 'steadyAdmissionRate', value: 26, formula: 'targetNew ÷ avgDwellSeconds', inputs: { targetNew: 5200, avgDwellSeconds: 200 }, assumptions: ['정상 상태다(머무는 시간·입장 비율이 지금과 같다)'] },
      { key: 'servingRate', value: 52, formula: 'steadyAdmissionRate ÷ admitRatio', inputs: { steadyAdmissionRate: 26, admitRatio: 0.5 }, assumptions: ['정상 상태다(머무는 시간·입장 비율이 지금과 같다)'] },
    ],
    unavailable: [{ key: 'inFlight', source: 'queue-redis', reason: 'source-not-wired' }],
    limits: { admissionTargetMax: 8000, admissionTargetMin: 1000 },
    ...over,
  };
}

/** 명령 6 결제 갈래(이 회차)의 dry-run: 동시 입장 목표 상한 지금 값은 세지 못하고 새 값만 예측한다 */
export function dryRunPgFallback(over = {}) {
  return {
    version: 1,
    approvalMode: 'TWO',
    reauthRequired: true,
    counted: [{ key: `newPgTps:${E}`, value: 60, source: 'payment-svc', measuredAt: AT }],
    predicted: [
      {
        key: `admissionTargetCapNew:${E}`,
        value: 5400,
        formula: 'min(admissionTargetMax, pgTps × avgDwellSeconds ÷ paymentRatio × safetyFactor)',
        inputs: { pgTps: 60, avgDwellSeconds: 180, paymentRatio: 1, safetyFactor: 0.5, admissionTargetMax: 8000 },
        assumptions: ['평균 체류 180초(docs/architecture.md §9.1)', '결제 비율 1.0 [가정], 안전 계수 0.5 [가정](docs/features/queue-admission.md §5 결제사별 상한)'],
      },
    ],
    unavailable: [{ key: `admissionTargetCapNow:${E}`, source: 'prediction', reason: `input-unavailable:currentPgTps:${E}` }],
    limits: {},
    ...over,
  };
}

/** 명령 3(판매 일시정지)의 dry-run: 1인 실행(승인 없이 즉시)·재인증 */
export function dryRunKillSwitch(over = {}) {
  return {
    version: 1,
    approvalMode: 'NONE',
    reauthRequired: true,
    counted: [{ key: 'waiting', value: 41000, source: 'queue-redis', measuredAt: AT }],
    predicted: [],
    unavailable: [{ key: 'paymentSessions', source: 'purchase-db', reason: 'source-not-wired' }],
    limits: {},
    ...over,
  };
}

/** openapi CommandState(상세) */
export function commandState(over = {}) {
  return {
    commandId: C1,
    type: 'KILL_SWITCH',
    state: 'ACKED',
    eventId: E,
    reason: '결제사 승인 지연으로 판매를 멈춥니다',
    params: { scope: 'EVENT', eventIds: [E] },
    requestedBy: { adminAccountId: 'acc-commander-1', displayName: '수진', role: 'commander' },
    createdAt: '2026-11-23T11:00:00.000Z',
    approvalExpiresAt: null,
    approvals: [],
    attempts: 1,
    lastError: null,
    executedAt: '2026-11-23T11:00:02.000Z',
    result: null,
    canApprove: false,
    postReviewDueAt: null,
    delivery: { kind: 'ACK', ackedCount: 3, targetCount: 3, unackedTargets: [] },
    dryRun: dryRunKillSwitch(),
    ...over,
  };
}

/** 저장소·쿠키에 쓴 것을 적는 가짜(document.cookie·localStorage·sessionStorage). restore()로 되돌린다 */
export function recordStorage() {
  const writes = [];
  const storage = (name) => ({
    getItem: () => null,
    setItem: (k, v) => writes.push(`${name}:${k}=${v}`),
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  });
  const saved = ['localStorage', 'sessionStorage', 'document'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  Object.defineProperty(globalThis, 'localStorage', { value: storage('localStorage'), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage('sessionStorage'), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', {
    value: {
      get cookie() {
        return '';
      },
      set cookie(v) {
        writes.push(`cookie:${v}`);
      },
    },
    configurable: true,
    writable: true,
  });
  return {
    writes,
    restore() {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(globalThis, k, d);
        else delete globalThis[k];
      }
    },
  };
}

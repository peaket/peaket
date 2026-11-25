// F-05-12 월렛 부스 재발급 흐름(d5 §5.13 '저장소 유실, 입장 시작 뒤' → 대조 동의 → 본인확인 → 부스 코드 → BOOTH 등록).
// 정본: docs/frontend.md §4.2.4 '부스 재발급 세부', docs/features/offline-gate.md §9.1, openapi
//       createIdentityBoothReverification·createTicketBoothRequest·createTicketDeviceKey.
// 흐름은 React를 모르는 순수 클래스다. 10초 재시도·online 사건·reason: BOOTH·공개키는 화면이 아니라 이 클래스가 지킨다(TR-12).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const MODULE = './flow.ts';
const loaded = await import(MODULE).catch(() => ({}));
function flowClass() {
  assert.equal(typeof loaded.BoothReissueFlow, 'function', `${MODULE}가 없다`);
  return loaded.BoothReissueFlow;
}

const TICKET = '0190f3a1-7c2e-7a00-8000-00000000c001';
const BOOTH_REQUEST = '0190f3a1-7c2e-7a00-8000-00000000c002';
const TOKEN = 'A'.repeat(43);
const CODE_MS = 10 * 60_000;
const RETRY_MS = 10_000;
/** 월렛이 만든 이 기기의 공개키(개인키는 넘기지 않는다) */
const PUBLIC_KEY = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0', ext: true, key_ops: ['verify'] };

function harness(over = {}) {
  const now = { ms: Date.parse('2026-11-26T03:00:00Z') };
  const calls = { start: [], confirm: [], request: [], register: [] };
  const states = [];
  const answers = {
    start: async (i) => {
      calls.start.push(i);
      return { verificationId: 'v-1', window: { url: 'https://agency.example', method: 'POST', fields: {}, mode: 'POPUP' }, expiresAt: new Date(now.ms + 600_000).toISOString() };
    },
    confirm: async (i) => {
      calls.confirm.push(i);
      return { resultToken: TOKEN };
    },
    request: async (i) => {
      calls.request.push(i);
      return { boothRequestId: BOOTH_REQUEST, boothCode: 'K7QD2M9X', expiresAt: new Date(now.ms + CODE_MS).toISOString() };
    },
    register: async (i) => {
      calls.register.push(i);
      throw Object.assign(new Error('아직 허용 전'), { status: 403, type: 'booth-not-authorized' });
    },
    ...over,
  };
  const flow = new (flowClass())({
    ticketId: TICKET,
    api: answers,
    now: () => now.ms,
    retryEveryMs: RETRY_MS,
    deviceKey: { publicKeyJwk: PUBLIC_KEY },
    onState: (s) => states.push(s),
  });
  return { flow, calls, states, now, answers };
}

async function toWaiting(h) {
  h.flow.begin();
  await h.flow.consent();
  await h.flow.verified({ verificationId: 'v-1', providerResult: { tx: 'v-1' } });
  await h.flow.request();
  await h.flow.tick();
  assert.equal(h.states.at(-1)?.phase, 'waiting');
}

test('부스 재발급: 동의 전에는 시작하지 않고, 동의하면 대조 목적 동의 true로 시작한다', async () => {
  const h = harness();
  h.flow.begin();
  assert.equal(h.calls.start.length, 0);
  assert.equal(h.states.at(-1)?.phase, 'consent');
  await h.flow.consent();
  assert.deepEqual(h.calls.start[0], { ticketId: TICKET, consent: true });
  assert.equal(h.states.at(-1)?.phase, 'verifying');
});

test('부스 재발급: 본인확인 결과 토큰으로 부스 코드(8자, 10분)를 받고 코드 상태를 보인다', async () => {
  const h = harness();
  h.flow.begin();
  await h.flow.consent();
  await h.flow.verified({ verificationId: 'v-1', providerResult: { tx: 'v-1' } });
  await h.flow.request();
  assert.deepEqual(h.calls.request[0], { ticketId: TICKET, reverificationToken: TOKEN });
  assert.equal(h.states.at(-1)?.phase, 'code');
  assert.equal(h.states.at(-1)?.boothCode, 'K7QD2M9X');
  assert.equal(h.states.at(-1)?.expiresAtMs, h.now.ms + CODE_MS);
});

test('부스 재발급: 403 booth-not-authorized는 기다림이고, 같은 시각에 tick을 세 번 불러도 한 번만 시도하며 10,000ms마다·online에서 다시 시도한다', async () => {
  let attempts = 0;
  const h = harness({
    register: async () => {
      attempts++;
      throw Object.assign(new Error('아직'), { status: 403, type: 'booth-not-authorized' });
    },
  });
  await toWaiting(h);
  assert.equal(attempts, 1, '코드를 보인 뒤 첫 tick은 바로 한 번 시도한다');
  await h.flow.tick();
  await h.flow.tick();
  assert.equal(attempts, 1, '같은 now에서 tick을 여러 번 불러도 10초가 지나기 전에는 다시 부르지 않는다');
  h.now.ms += RETRY_MS - 1;
  await h.flow.tick();
  assert.equal(attempts, 1, '10,000−1ms에는 아직이다');
  h.now.ms += 1;
  await h.flow.tick();
  assert.equal(attempts, 2, '10,000ms마다 한 번 시도한다');
  // online 사건은 10초를 기다리지 않고 바로 시도한다
  h.now.ms += 1;
  await h.flow.online();
  assert.equal(attempts, 3, 'online 사건에 바로 다시 시도한다');
});

test('부스 재발급: 201이면 registered이고 등록 본문에 reason BOOTH·boothRequestId·이 기기 공개키를 싣는다', async () => {
  let attempts = 0;
  const h = harness({
    register: async (i) => {
      attempts++;
      h.calls.register.push(i);
      if (attempts < 3) throw Object.assign(new Error('아직'), { status: 403, type: 'booth-not-authorized' });
      return { keyId: 'key-1' };
    },
  });
  await toWaiting(h);
  h.now.ms += RETRY_MS;
  await h.flow.tick();
  assert.equal(h.states.at(-1)?.phase, 'waiting');
  h.now.ms += RETRY_MS;
  await h.flow.tick();
  assert.equal(h.states.at(-1)?.phase, 'registered');
  assert.equal(attempts, 3);
  const reg = h.calls.register[0];
  assert.equal(reg.ticketId, TICKET);
  assert.equal(reg.boothRequestId, BOOTH_REQUEST);
  assert.equal(reg.reason, 'BOOTH');
  assert.deepEqual(reg.publicKeyJwk, PUBLIC_KEY);
  // 등록 뒤에는 코드 만료 전이어도 더 시도하지 않는다
  h.now.ms += 1;
  await h.flow.tick();
  await h.flow.online();
  assert.equal(attempts, 3);
});

test('부스 재발급: 코드 만료 600,000−1ms에는 시도하고, 만료 시각에는 시도를 멈추고 expired다', async () => {
  let attempts = 0;
  const h = harness({
    register: async () => {
      attempts++;
      throw Object.assign(new Error('아직'), { status: 403, type: 'booth-not-authorized' });
    },
  });
  await toWaiting(h);
  h.now.ms += CODE_MS - 1;
  await h.flow.tick();
  assert.equal(attempts, 2);
  h.now.ms += 1;
  await h.flow.tick();
  assert.equal(attempts, 2, '만료 시각에는 시도하지 않는다');
  assert.equal(h.states.at(-1)?.phase, 'expired');
  await h.flow.online();
  assert.equal(attempts, 2);
});

test('부스 재발급: 결과 확정 409 booth-mismatch는 mismatch, 요청 409 before-entry는 before-entry, 429는 limit, 404는 error다', async () => {
  // 본인확인 결과가 다른 사람(identity 결과 확정의 409)
  {
    const h = harness({
      confirm: async () => {
        throw Object.assign(new Error('다른 사람'), { status: 409, type: 'booth-mismatch' });
      },
    });
    h.flow.begin();
    await h.flow.consent();
    await h.flow.verified({ verificationId: 'v-1', providerResult: { tx: 'v-1' } }).catch(() => undefined);
    assert.equal(h.states.at(-1)?.phase, 'mismatch');
  }
  for (const [status, type, phase] of [
    [429, 'too-many-requests', 'limit'],
    [409, 'booth-mismatch', 'mismatch'],
    [409, 'booth-before-entry', 'before-entry'],
    [404, 'not-found', 'error'],
  ]) {
    const h = harness({
      request: async () => {
        throw Object.assign(new Error(type), { status, type });
      },
    });
    h.flow.begin();
    await h.flow.consent();
    await h.flow.verified({ verificationId: 'v-1', providerResult: { tx: 'v-1' } });
    await h.flow.request();
    assert.equal(h.states.at(-1)?.phase, phase, `${status}/${type}`);
  }
});

test('부스 재발급: 토큰·코드 원문을 로그에 남기지 않는다', async () => {
  const logs = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(originals)) console[k] = (...args) => logs.push(args.map(String).join(' '));
  try {
    const h = harness();
    h.flow.begin();
    await h.flow.consent();
    await h.flow.verified({ verificationId: 'v-1', providerResult: { tx: 'v-1' } });
    await h.flow.request();
    await h.flow.tick();
  } finally {
    Object.assign(console, originals);
  }
  const text = logs.join('\n');
  assert.equal(text.includes(TOKEN), false, '본인확인 결과 토큰 원문이 로그에 남았다');
  assert.equal(text.includes('K7QD2M9X'), false, '부스 코드 원문이 로그에 남았다');
});

test('부스 재발급: 흐름 소스는 토큰·코드를 저장소(localStorage·sessionStorage·IndexedDB)에 두지 않는다', () => {
  const source = readFileSync(new URL(MODULE, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/, '부스 토큰·코드를 브라우저 저장소에 두면 안 된다');
});

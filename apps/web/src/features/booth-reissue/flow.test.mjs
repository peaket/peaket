// F-05-12 월렛 부스 재발급 흐름(d5 §5.13 '저장소 유실, 입장 시작 뒤' → 대조 동의 → 본인확인 → 부스 코드 → BOOTH 등록).
// 정본: docs/frontend.md §4.2.4 '부스 재발급 세부', docs/features/offline-gate.md §9.1, openapi
//       createIdentityBoothReverification·createTicketBoothRequest·createTicketDeviceKey.
// 흐름은 React를 모르는 순수 클래스다. 10초 재시도는 화면이 tick()을 부르는 것으로 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const MODULE = '../src/features/booth-reissue/flow.ts';
const loaded = await import(MODULE).catch(() => ({}));
function flowClass() {
  assert.equal(typeof loaded.BoothReissueFlow, 'function', `${MODULE}가 없다`);
  return loaded.BoothReissueFlow;
}

const TICKET = '0190f3a1-7c2e-7a00-8000-00000000c001';
const BOOTH_REQUEST = '0190f3a1-7c2e-7a00-8000-00000000c002';
const TOKEN = 'A'.repeat(43);
const CODE_MS = 10 * 60_000;

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
  const flow = new (flowClass())({ ticketId: TICKET, api: answers, now: () => now.ms, onState: (s) => states.push(s) });
  return { flow, calls, states, now, answers };
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

test('부스 재발급: 403 booth-not-authorized는 기다림이고, 허용 뒤 201이면 registered다', async () => {
  let attempts = 0;
  const h = harness({
    register: async (i) => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('아직'), { status: 403, type: 'booth-not-authorized' });
      return { keyId: 'key-1' };
    },
  });
  h.flow.begin();
  await h.flow.consent();
  await h.flow.verified({ verificationId: 'v-1', providerResult: { tx: 'v-1' } });
  await h.flow.request();
  await h.flow.tick();
  assert.equal(h.states.at(-1)?.phase, 'waiting');
  await h.flow.tick();
  assert.equal(h.states.at(-1)?.phase, 'waiting');
  await h.flow.tick();
  assert.equal(h.states.at(-1)?.phase, 'registered');
  assert.equal(attempts, 3);
  assert.deepEqual(h.calls.register[0], { ticketId: TICKET, boothRequestId: BOOTH_REQUEST });
});

test('부스 재발급: 코드 만료 뒤에는 등록을 더 시도하지 않고 expired다', async () => {
  let attempts = 0;
  const h = harness({
    register: async () => {
      attempts++;
      throw Object.assign(new Error('아직'), { status: 403, type: 'booth-not-authorized' });
    },
  });
  h.flow.begin();
  await h.flow.consent();
  await h.flow.verified({ verificationId: 'v-1', providerResult: { tx: 'v-1' } });
  await h.flow.request();
  h.now.ms += CODE_MS - 1;
  await h.flow.tick();
  assert.equal(attempts, 1);
  h.now.ms += 1;
  await h.flow.tick();
  assert.equal(attempts, 1);
  assert.equal(h.states.at(-1)?.phase, 'expired');
});

test('부스 재발급: 429는 limit, 409 두 갈래는 mismatch·before-entry, 404는 error다', async () => {
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

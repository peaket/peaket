// 입장 확정 사례(docs/features/queue-admission.md §6 '입장 확정의 첫 구현', ADR-0183). 메모리 저장소(test/admission.test.ts)와
// 실제 Valkey Lua(test-int/admission-store.int.test.ts)에 똑같이 돈다. 서버 시각은 실제 시계라(Lua는 Redis TIME) 지난 시각은 기록을 과거로 써서 만든다.
import { createPublicKey, generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import type { Clock } from '@peaket/platform';
import { expect, test } from 'vitest';
import { ADMISSION_TOKEN_ISSUER_ENV, ADMISSION_TOKEN_KEY_ENV, Es256AdmissionTokens } from '../src/modules/admission/adapters/es256-admission-tokens.js';
import { AdmissionError } from '../src/modules/admission/application/admission-error.js';
import { ConfirmAdmission, type ConfirmInput } from '../src/modules/admission/application/confirm-admission.js';
import { FIRST_USE_MS, MAX_STAY_MS, TURN_GRACE_MS } from '../src/modules/admission/domain/admission.js';
import type { AdmissionSignals, AdmissionStore } from '../src/modules/admission/domain/ports.js';
import type { EventSchedules } from '../src/modules/entry/domain/ports.js';
import { type EventSchedule, QueueStoreUnavailable, saleEndOf } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, DEVICE, JNY, newEvent, OTHER_ACCOUNT, openSchedule, PID, tokens } from './support.js';

export const ISSUER = 'https://queue.peaket.example';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
export const ADMISSION_JWK = { ...privateKey.export({ format: 'jwk' }), kid: 'adm-1' };
export const signer = Es256AdmissionTokens.fromEnv({ [ADMISSION_TOKEN_KEY_ENV]: JSON.stringify(ADMISSION_JWK), [ADMISSION_TOKEN_ISSUER_ENV]: ISSUER });
const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: ADMISSION_JWK.x, y: ADMISSION_JWK.y }, format: 'jwk' });

/** 입장 토큰을 공개키로 확인하고 머리·클레임을 돌려준다(받는 쪽 확인을 흉내 낸다) */
export function readAdmissionToken(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h, p, s] = token.split('.') as [string, string, string];
  expect(verifySignature('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>, claims: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown> };
}

/** 지표 기록기 */
export function recordingSignals(): AdmissionSignals & { seen: Record<string, number[]> } {
  const seen: Record<string, number[]> = { beforeTurn: [], user: [], system: [], arrival: [], soonWait: [], eta: [] };
  return {
    seen,
    admittedBeforeTurn: () => void seen.beforeTurn!.push(1),
    turnEntryFailed: (cause) => void seen[cause]!.push(1),
    arrivalDelay: (s) => void seen.arrival!.push(s),
    soonWait: (s) => void seen.soonWait!.push(s),
    etaError: (r) => void seen.eta!.push(r),
  };
}

export interface AdmissionHarness {
  store: AdmissionStore;
  clock: Clock;
  schedules: EventSchedules & { set(eventId: string, s: EventSchedule): Promise<void> };
  setServing(eventId: string, serving: number): Promise<void>;
  /** serving_log 칸(그 시각의 초)에 serving을 남긴다 */
  logServing(eventId: string, atMs: number, serving: number): Promise<void>;
  /** 전진 기록 calls(점수 = 마지막 번호, 값 = {시각}:{유효 수}) */
  addCall(eventId: string, lastSeq: number, atMs: number, valid: number): Promise<string>;
  callReq(eventId: string, member: string): Promise<number>;
  setRemoved(eventId: string, seq: number): Promise<void>;
  isRemoved(eventId: string, seq: number): Promise<boolean>;
  setVerify(eventId: string, hash: string, value: string): Promise<void>;
  addSkipped(eventId: string, line: string): Promise<void>;
  setNotice(eventId: string, fields: Record<string, string>): Promise<void>;
  setTarget(eventId: string, n: number): Promise<void>;
  addSlot(eventId: string, jti: string, expiresAtMs: number): Promise<void>;
  slots(eventId: string): Promise<Map<string, number>>;
  /** 곧 입장 대기열의 해시(번호 순)와 처음 SOON 시각 */
  soon(eventId: string): Promise<string[]>;
  soonFirst(eventId: string, hash: string): Promise<number | null>;
  /** 리더가 낡은 곧 입장 항목을 빼는 것을 흉내 낸다 */
  dropSoon(eventId: string, hash: string): Promise<void>;
  admitted(eventId: string): Promise<number>;
  setDup(pid: string, eventId: string, v: string): Promise<void>;
  dup(pid: string, eventId: string): Promise<string | null>;
  adm(pid: string, eventId: string): Promise<string | null>;
  setAdm(pid: string, eventId: string, v: string): Promise<void>;
  /** 자리를 처음 잡은 시각(slot_of의 '<해시>:at')을 바꾼다 */
  setIssuedAt(eventId: string, ticketHash: string, atMs: number): Promise<void>;
}

let pidN = 0;
const newPid = () => `pid-${process.pid}-${pidN++}`;

export function admissionCases(name: string, setup: () => Promise<AdmissionHarness>): void {
  async function world(o: { serving?: number; turnAgoMs?: number; schedule?: Partial<EventSchedule>; wrap?: (s: AdmissionStore) => AdmissionStore } = {}) {
    const h = await setup();
    const eventId = newEvent();
    const now = h.clock.now();
    await h.schedules.set(eventId, openSchedule(now, o.schedule));
    const serving = o.serving ?? 200;
    await h.setServing(eventId, serving);
    const turnAt = now - (o.turnAgoMs ?? 60_000);
    await h.logServing(eventId, turnAt, serving);
    const signals = recordingSignals();
    const app = new ConfirmAdmission(o.wrap ? o.wrap(h.store) : h.store, h.schedules, tokens, signer, signals, h.clock);
    const ticket = (seq: number, c: { a?: string; e?: string; g?: number; jny?: string } = {}) =>
      tokens.ticket({ e: c.e ?? eventId, a: c.a ?? ACCOUNT, d: DEVICE, s: seq, g: c.g ?? 1, seg: Math.floor((seq - 1) / 1000), rq: crypto.randomUUID(), jny: c.jny ?? JNY });
    const confirm = (t: string, o2: Partial<ConfirmInput> & { pid?: string } = {}) =>
      app.run({ accountId: ACCOUNT, sessionId: 'sess-1', eventId, body: { queueTicket: t }, ...o2, pid: o2.pid ?? PID });
    return { h, eventId, now, turnAt, signals, app, ticket, confirm };
  }

  const rejects = async (p: Promise<unknown>, code: AdmissionError['code']) => {
    const e = await p.then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(AdmissionError);
    expect((e as AdmissionError).code).toBe(code);
    return e as AdmissionError;
  };

  test(`[${name}] Q-T64⑤ 일정 사본에 좌석맵 판이 있으면 입장 확정 응답에 그 회차의 좌석맵 파일 경로를 싣고, 없으면 그 칸을 뺀다`, async () => {
    const a = await world({ schedule: { layoutVersion: 7 } });
    const r = await a.confirm(a.ticket(150));
    expect(r.status).toBe('ADMITTED');
    if (r.status !== 'ADMITTED') return;
    expect(r.seatmapLayoutPath).toBe(`/v1/events/${encodeURIComponent(a.eventId)}/seatmap-layouts/7.json`);
    const b = await world();
    const none = await b.confirm(b.ticket(150, { a: 'other-account' }), { accountId: 'other-account', pid: 'pid-other' });
    expect(none.status).toBe('ADMITTED');
    expect('seatmapLayoutPath' in none).toBe(false);
  });

  test(`[${name}] 차례가 온 대기표는 ADMITTED와 입장 토큰(typ·iss·aud·jti·sid·event·jny·exp)을 받고, 자리·입장 수·1인 1순번 키가 남고 q:dup이 지워진다(Q-T60)`, async () => {
    const { h, eventId, ticket, confirm } = await world();
    await h.setDup(PID, eventId, `150:1:rq:${JNY}:`);
    const t = ticket(150, { jny: '0190f3a1-7c2e-7a00-8000-0000000000bb' });
    const r = await confirm(t);
    expect(r.status).toBe('ADMITTED');
    if (r.status !== 'ADMITTED') return;
    const { header, claims } = readAdmissionToken(r.admissionToken);
    expect(header).toEqual({ alg: 'ES256', typ: 'admission+jwt', kid: 'adm-1' });
    expect(claims).toMatchObject({ iss: ISSUER, sub: ACCOUNT, aud: 'purchase', sid: 'sess-1', event: eventId, jny: '0190f3a1-7c2e-7a00-8000-0000000000bb' });
    expect(claims.exp).toBe((claims.iat as number) + MAX_STAY_MS / 1000);
    const slots = await h.slots(eventId);
    expect([...slots.keys()]).toEqual([claims.jti]);
    expect(slots.get(claims.jti as string)! - h.clock.now()).toBeGreaterThan(FIRST_USE_MS - 5_000);
    expect(slots.get(claims.jti as string)! - h.clock.now()).toBeLessThanOrEqual(FIRST_USE_MS + 1_000);
    expect(await h.admitted(eventId)).toBe(1);
    expect((await h.adm(PID, eventId))?.startsWith(`${tokens.hash(t)}:`)).toBe(true);
    expect(await h.dup(PID, eventId)).toBeNull();
  });

  test(`[${name}] 같은 대기표로 다시 오면 자리가 남아 있을 때 같은 jti를 다시 주고 입장 수를 다시 세지 않는다. 자리가 회수됐으면 새 jti로 다시 잡는다(Q-T31)`, async () => {
    const { h, eventId, ticket, confirm } = await world();
    const t = ticket(150);
    const a = await confirm(t);
    const b = await confirm(t);
    if (a.status !== 'ADMITTED' || b.status !== 'ADMITTED') throw new Error('ADMITTED가 아니다');
    const ja = readAdmissionToken(a.admissionToken).claims.jti as string;
    expect(readAdmissionToken(b.admissionToken).claims.jti).toBe(ja);
    expect(await h.admitted(eventId)).toBe(1);
    expect((await h.slots(eventId)).size).toBe(1);
    // 첫 사용 기한으로 회수(구매 세션 종료로 흉내)
    await h.store.sessionEnded({ eventId, jti: ja });
    const c = await confirm(t);
    if (c.status !== 'ADMITTED') throw new Error('ADMITTED가 아니다');
    const jc = readAdmissionToken(c.admissionToken).claims.jti as string;
    expect(jc).not.toBe(ja);
    expect([...(await h.slots(eventId)).keys()]).toEqual([jc]);
    expect((await h.adm(PID, eventId))?.startsWith(`${tokens.hash(t)}:`)).toBe(true);
  });

  test(`[${name}] BAS-042 같은 대기표로 다시 받는 입장 토큰은 첫 발급 + 최대 체류를 exp로 두고, 그 시각이 지났으면 다시 주지 않고 410 만료(rejoinAllowed 거짓)다(exp < iat 토큰을 내지 않는다, HOT-010 리뷰)`, async () => {
    const { h, eventId, ticket, confirm } = await world();
    const t = ticket(150);
    const a = await confirm(t);
    if (a.status !== 'ADMITTED') throw new Error('ADMITTED가 아니다');
    const near = h.clock.now() - MAX_STAY_MS + 60_000;
    await h.setIssuedAt(eventId, tokens.hash(t), near);
    const b = await confirm(t);
    if (b.status !== 'ADMITTED') throw new Error('ADMITTED가 아니다');
    const cb = readAdmissionToken(b.admissionToken).claims;
    expect(cb.exp).toBe(Math.floor(near / 1000) + MAX_STAY_MS / 1000);
    expect(cb.exp as number).toBeGreaterThan(cb.iat as number);
    expect(Date.parse(b.purchaseSessionExpiresAt)).toBe((cb.exp as number) * 1000);
    await h.setIssuedAt(eventId, tokens.hash(t), h.clock.now() - MAX_STAY_MS);
    const e = await rejects(confirm(t), 'EXPIRED');
    expect(e.rejoinAllowed).toBe(false);
    expect(await h.admitted(eventId)).toBe(1);
  });

  test(`[${name}] 같은 대기표의 요청 둘이 동시에 와도 자리·입장 수는 하나이고 같은 jti를 받는다(ADR-0183 결정 2)`, async () => {
    const { h, eventId, ticket, confirm } = await world();
    const t = ticket(150);
    const rs = await Promise.all([confirm(t), confirm(t), confirm(t)]);
    const jtis = rs.map((r) => (r.status === 'ADMITTED' ? (readAdmissionToken(r.admissionToken).claims.jti as string) : r.status));
    expect(new Set(jtis).size).toBe(1);
    expect((await h.slots(eventId)).size).toBe(1);
    expect(await h.admitted(eventId)).toBe(1);
    expect((await h.adm(PID, eventId))?.startsWith(`${tokens.hash(t)}:`)).toBe(true);
  });

  test(`[${name}] 다시 줄 때는 첫 사용 기한을 지금부터 5분으로 올리고, 이미 만료된 자리는 다시 주지 않고 새 jti로 잡는다`, async () => {
    const { h, eventId, now, ticket, confirm } = await world();
    const t = ticket(150);
    const a = await confirm(t);
    if (a.status !== 'ADMITTED') throw new Error('ADMITTED가 아니다');
    const ja = readAdmissionToken(a.admissionToken).claims.jti as string;
    await h.addSlot(eventId, ja, now + 60_000);
    const b = await confirm(t);
    expect(b.status === 'ADMITTED' && readAdmissionToken(b.admissionToken).claims.jti).toBe(ja);
    expect((await h.slots(eventId)).get(ja)!).toBeGreaterThan(h.clock.now() + FIRST_USE_MS - 5_000);
    // 만료됐지만 리더가 아직 치우지 않은 자리
    await h.addSlot(eventId, ja, h.clock.now() - 1_000);
    const c = await confirm(t);
    if (c.status !== 'ADMITTED') throw new Error('ADMITTED가 아니다');
    const jc = readAdmissionToken(c.admissionToken).claims.jti as string;
    expect(jc).not.toBe(ja);
    expect((await h.slots(eventId)).get(jc)!).toBeGreaterThan(h.clock.now() + FIRST_USE_MS - 5_000);
  });

  test(`[${name}] 입장한 뒤 응답을 잃고 15분을 넘겨 다시 오면 410이 아니라 살아 있는 자리를 다시 준다`, async () => {
    const { h, eventId, now, signals, ticket, confirm } = await world({ turnAgoMs: 14 * 60_000 });
    const t = ticket(150);
    const a = await confirm(t);
    if (a.status !== 'ADMITTED') throw new Error('ADMITTED가 아니다');
    await h.logServing(eventId, now - 16 * 60_000, 200);
    const b = await confirm(t);
    expect(b.status === 'ADMITTED' && readAdmissionToken(b.admissionToken).claims.jti).toBe(readAdmissionToken(a.admissionToken).claims.jti);
    expect(signals.seen.user).toHaveLength(0);
    // 자리가 회수됐으면 만료다
    await h.store.sessionEnded({ eventId, jti: readAdmissionToken(a.admissionToken).claims.jti as string });
    await rejects(confirm(t), 'EXPIRED');
  });

  test(`[${name}] 사람 슬롯 마무리: 늦게 온 SOON 되돌리기는 같은 대기표의 입장 기록을 지우지 못하고, 먼저 지워졌으면 입장 마무리가 되살린다. 해시만 적힌 옛 값도 같은 대기표다`, async () => {
    const h = await setup();
    const eventId = newEvent();
    const pid = newPid();
    const hash = tokens.hash(`t-${eventId}`);
    const until = h.clock.now() + 3600_000;
    expect(await h.store.claim({ pid, eventId, ticketHash: hash, nonce: 'n1', expireAtMs: until })).toEqual({ kind: 'NEW' });
    expect(await h.store.claim({ pid, eventId, ticketHash: hash, nonce: 'n2', expireAtMs: until })).toEqual({ kind: 'SAME' });
    await h.store.settle({ pid, eventId, ticketHash: hash, outcome: 'ADMITTED', nonce: 'n2', expireAtMs: until });
    await h.store.settle({ pid, eventId, ticketHash: hash, outcome: 'RELEASE', nonce: 'n1', expireAtMs: until });
    expect(await h.adm(pid, eventId)).toBe(`${hash}:n2`);
    // 반대 순서: 되돌리기가 먼저 지운 뒤 입장 마무리
    const pid2 = newPid();
    await h.store.claim({ pid: pid2, eventId, ticketHash: hash, nonce: 'n1', expireAtMs: until });
    await h.store.settle({ pid: pid2, eventId, ticketHash: hash, outcome: 'RELEASE', nonce: 'n1', expireAtMs: until });
    expect(await h.adm(pid2, eventId)).toBeNull();
    await h.store.settle({ pid: pid2, eventId, ticketHash: hash, outcome: 'ADMITTED', nonce: 'n3', expireAtMs: until });
    expect(await h.adm(pid2, eventId)).toBe(`${hash}:n3`);
    // 다른 대기표의 값은 입장 마무리가 덮지 않는다
    const other = tokens.hash(`o-${eventId}`);
    await h.store.settle({ pid: pid2, eventId, ticketHash: other, outcome: 'ADMITTED', nonce: 'n4', expireAtMs: until });
    expect(await h.adm(pid2, eventId)).toBe(`${hash}:n3`);
    // 해시만 적힌 옛 값
    const pid3 = newPid();
    await h.setAdm(pid3, eventId, hash);
    expect(await h.store.claim({ pid: pid3, eventId, ticketHash: hash, nonce: 'n5', expireAtMs: until })).toEqual({ kind: 'SAME' });
    expect(await h.store.claim({ pid: pid3, eventId, ticketHash: other, nonce: 'n6', expireAtMs: until })).toEqual({ kind: 'DUP' });
    await h.store.settle({ pid: pid3, eventId, ticketHash: hash, outcome: 'ADMITTED', nonce: 'n5', expireAtMs: until });
    expect(await h.adm(pid3, eventId)).toBe(`${hash}:n5`);
  });

  test(`[${name}] 곧 입장에서 리더가 뺀 뒤 다시 와도 처음 요청은 그 번호에 한 번만 센다`, async () => {
    const { h, eventId, now, turnAt, ticket, confirm } = await world();
    await h.setTarget(eventId, 1);
    await h.addSlot(eventId, 'someone', now + 60_000);
    const member = await h.addCall(eventId, 200, turnAt, 100);
    const t = ticket(150);
    expect((await confirm(t)).status).toBe('SOON');
    await h.dropSoon(eventId, tokens.hash(t));
    expect((await confirm(t)).status).toBe('SOON');
    await h.store.sessionEnded({ eventId, jti: 'someone' });
    expect((await confirm(t)).status).toBe('ADMITTED');
    expect(await h.callReq(eventId, member)).toBe(1);
  });

  test(`[${name}] NOT_YET 속도: 끝 칸이 모두 10초 창 안이면 가장 오래된 칸부터 센다`, async () => {
    const { h, eventId, now, ticket, confirm } = await world({ serving: 200, turnAgoMs: 1_000 });
    // 8초 전 100, 1초 전 200 → 초당 약 12.5. 300번은 약 8초 뒤
    await h.logServing(eventId, now - 8_000, 100);
    const r = await confirm(ticket(300));
    expect(r.status).toBe('NOT_YET');
    if (r.status !== 'NOT_YET') return;
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(6_000);
    expect(r.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  test(`[${name}] [ASVS v5.0.0-15.4.2] 같은 사람의 다른 대기표는 409 DUPLICATE_ADMISSION이고 그 번호가 빠진 번호가 된다. 먼저 입장한 대기표는 그대로 통과한다(Q-T31)`, async () => {
    const { h, eventId, ticket, confirm } = await world();
    const first = ticket(150);
    const second = ticket(160);
    expect((await confirm(first)).status).toBe('ADMITTED');
    await rejects(confirm(second), 'DUPLICATE_ADMISSION');
    expect(await h.isRemoved(eventId, 160)).toBe(true);
    expect(await h.isRemoved(eventId, 150)).toBe(false);
    expect((await h.slots(eventId)).size).toBe(1);
    expect((await confirm(first)).status).toBe('ADMITTED');
  });

  test(`[${name}] [ASVS v5.0.0-9.2.1] 차례 뒤 14분은 바로 입장하고 16분은 410 queue-ticket-expired(rejoinAllowed true)와 이 대기표의 q:dup 지우기다(Q-T10)`, async () => {
    const a = await world({ turnAgoMs: 14 * 60_000 });
    expect((await a.confirm(a.ticket(150))).status).toBe('ADMITTED');
    const b = await world({ turnAgoMs: TURN_GRACE_MS + 60_000 });
    await b.h.setDup(PID, b.eventId, `150:1:rq:${JNY}:`);
    const e = await rejects(b.confirm(b.ticket(150)), 'EXPIRED');
    expect(e.rejoinAllowed).toBe(true);
    expect(await b.h.dup(PID, b.eventId)).toBeNull();
    expect(await b.h.adm(PID, b.eventId)).toBeNull();
    expect((await b.h.slots(b.eventId)).size).toBe(0);
    expect(b.signals.seen.user).toHaveLength(1);
  });

  test(`[${name}] 만료 410은 다른 번호의 q:dup을 지우지 않고, 입장한 적이 있으면 rejoinAllowed false다`, async () => {
    const { h, eventId, ticket, confirm } = await world({ turnAgoMs: TURN_GRACE_MS + 60_000 });
    await h.setDup(PID, eventId, `999:1:rq:${JNY}:`);
    expect((await rejects(confirm(ticket(150)), 'EXPIRED')).rejoinAllowed).toBe(true);
    expect(await h.dup(PID, eventId)).toBe(`999:1:rq:${JNY}:`);
    await h.setAdm(PID, eventId, `${'a'.repeat(64)}:jti-old`);
    expect((await rejects(confirm(ticket(150)), 'EXPIRED')).rejoinAllowed).toBe(false);
  });

  test(`[${name}] 차례 시각 기록이 없으면 만료를 세지 않는다`, async () => {
    const h = await setup();
    const eventId = newEvent();
    await h.schedules.set(eventId, openSchedule(h.clock.now()));
    await h.setServing(eventId, 200);
    const app = new ConfirmAdmission(h.store, h.schedules, tokens, signer, recordingSignals(), h.clock);
    const t = tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: 150, g: 1, seg: 0, rq: 'rq-1', jny: JNY });
    expect((await app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } })).status).toBe('ADMITTED');
  });

  test(`[${name}] 차례 전이면 NOT_YET과 serving 속도로 센 retryAfterMs(1~60초)이고 자리·1인 1순번 키를 건드리지 않는다`, async () => {
    const { h, eventId, now, ticket, confirm } = await world({ serving: 200, turnAgoMs: 1_000 });
    // 12초 전 serving 100, 지금 200 → 초당 약 8.3번호. 300번은 약 12초 뒤
    await h.logServing(eventId, now - 12_000, 100);
    const r = await confirm(ticket(300));
    expect(r.status).toBe('NOT_YET');
    if (r.status !== 'NOT_YET') return;
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(10_000);
    expect(r.retryAfterMs).toBeLessThanOrEqual(14_000);
    expect(await h.adm(PID, eventId)).toBeNull();
    expect((await h.slots(eventId)).size).toBe(0);
    // 먼 번호는 60초로 자른다
    const far = await confirm(ticket(1_000_000));
    expect(far.status === 'NOT_YET' && far.retryAfterMs).toBe(60_000);
  });

  test(`[${name}] serving이 멈춰 있으면 NOT_YET은 60초다`, async () => {
    const { h, eventId, now, ticket, confirm } = await world({ serving: 200, turnAgoMs: 5 * 60_000 });
    await h.logServing(eventId, now - 6 * 60_000, 190);
    const r = await confirm(ticket(201));
    expect(r.status === 'NOT_YET' && r.retryAfterMs).toBe(60_000);
  });

  test(`[${name}] 빠진 번호는 추가 검증 중이면 200 VERIFYING(사유), 그 밖은 410 queue-ticket-removed다`, async () => {
    const { h, eventId, ticket, confirm } = await world();
    const v = ticket(150);
    await h.setRemoved(eventId, 150);
    await h.setVerify(eventId, tokens.hash(v), `VERIFYING:${h.clock.now()}:NETWORK`);
    const r = await confirm(v);
    expect(r).toMatchObject({ status: 'VERIFYING', verificationReason: 'NETWORK' });
    await h.setRemoved(eventId, 151);
    await rejects(confirm(ticket(151)), 'REMOVED');
    const blocked = ticket(152);
    await h.setRemoved(eventId, 152);
    await h.setVerify(eventId, tokens.hash(blocked), `BLOCKED:${h.clock.now()}:NETWORK`);
    await rejects(confirm(blocked), 'REMOVED');
    expect(await h.adm(PID, eventId)).toBeNull();
  });

  test(`[${name}] 건너뛴 구간 안의 옛 세대 대기표는 받고 처음 요청으로 세지 않는다. 같은 구간의 새 세대 번호는 410이다(Q-T13, ADR-0181)`, async () => {
    const { h, eventId, turnAt, ticket, confirm } = await world({ serving: 300 });
    await h.addSkipped(eventId, '101:200:1');
    const member = await h.addCall(eventId, 300, turnAt, 100);
    expect((await confirm(ticket(150, { g: 1 }))).status).toBe('ADMITTED');
    expect(await h.callReq(eventId, member)).toBe(0);
    await rejects(confirm(ticket(160, { g: 2 }), { pid: newPid() }), 'REMOVED');
  });

  test(`[${name}] 처음 요청은 그 번호를 부른 전진에 한 번만 세고 도착 지연을 낸다. 전진 기록이 지워져 다른 초의 전진이 잡히면 세지 않는다`, async () => {
    const { h, eventId, turnAt, signals, ticket, confirm } = await world({ serving: 200 });
    const member = await h.addCall(eventId, 200, turnAt, 100);
    const t = ticket(150);
    await confirm(t);
    await confirm(t);
    expect(await h.callReq(eventId, member)).toBe(1);
    expect(signals.seen.arrival).toHaveLength(1);
    expect(signals.seen.arrival![0]!).toBeGreaterThan(55);
    expect(signals.seen.arrival![0]!).toBeLessThan(65);
    // 다른 회차: 150을 부른 전진은 지워지고 뒤 전진(다른 초)만 남았다
    const b = await world({ serving: 400 });
    const later = await b.h.addCall(b.eventId, 400, b.turnAt + 5_000, 200);
    await b.confirm(b.ticket(150));
    expect(await b.h.callReq(b.eventId, later)).toBe(0);
    expect(b.signals.seen.arrival).toHaveLength(0);
  });

  test(`[${name}] 자리가 없으면 SOON으로 곧 입장 대기열에 넣고 1인 1순번 키를 지운다. 처음 SOON만 처음 요청으로 센다`, async () => {
    const { h, eventId, now, turnAt, ticket, confirm } = await world();
    await h.setTarget(eventId, 1);
    await h.addSlot(eventId, 'someone', now + 60_000);
    const member = await h.addCall(eventId, 200, turnAt, 100);
    const t = ticket(150);
    const r = await confirm(t);
    expect(r.status).toBe('SOON');
    if (r.status !== 'SOON') return;
    expect(r.retryAfterSeconds).toBe(5);
    expect(await h.soon(eventId)).toEqual([tokens.hash(t)]);
    expect(await h.soonFirst(eventId, tokens.hash(t))).not.toBeNull();
    expect(await h.adm(PID, eventId)).toBeNull();
    expect((await confirm(t)).status).toBe('SOON');
    expect(await h.callReq(eventId, member)).toBe(1);
    // 자리가 비면 들어가고 곧 입장 대기열에서 빠진다. 처음 요청은 그대로 1
    await h.store.sessionEnded({ eventId, jti: 'someone' });
    const s = await confirm(t);
    expect(s.status).toBe('ADMITTED');
    expect(await h.soon(eventId)).toEqual([]);
    expect(await h.soonFirst(eventId, tokens.hash(t))).toBeNull();
    expect(await h.callReq(eventId, member)).toBe(1);
  });

  test(`[${name}] 빈자리는 다시 시도한 순서와 상관없이 낮은 번호부터 가고(90 → 101 → 110) 목표를 넘지 않는다. 곧 입장 중에는 15분이 지나도 410이 아니다(Q-T9)`, async () => {
    const { h, eventId, now, signals, ticket, confirm } = await world({ serving: 200, turnAgoMs: 10 * 60_000 });
    await h.setTarget(eventId, 3);
    for (const j of ['x1', 'x2', 'x3']) await h.addSlot(eventId, j, now + 60_000);
    const who = new Map<number, { t: string; pid: string }>();
    for (const seq of [90, 101, 105, 110]) who.set(seq, { t: ticket(seq), pid: newPid() });
    const go = (seq: number) => confirm(who.get(seq)!.t, { pid: who.get(seq)!.pid });
    for (const seq of [101, 105, 110]) expect((await go(seq)).status).toBe('SOON');
    // 빈자리 하나: 110이 먼저 다시 와도 앞 번호(101·105)가 있어 SOON. 늦게 온 90은 곧 입장 대기열에 없지만 앞 번호가 없어 들어간다
    await h.store.sessionEnded({ eventId, jti: 'x1' });
    expect((await go(110)).status).toBe('SOON');
    expect((await go(90)).status).toBe('ADMITTED');
    expect((await go(101)).status).toBe('SOON');
    // 101은 곧 입장 중에 차례 뒤 15분을 넘긴다(차례 기록을 20분 전으로 다시 쓴다)
    await h.logServing(eventId, now - 20 * 60_000, 200);
    await h.store.sessionEnded({ eventId, jti: 'x2' });
    expect((await go(110)).status).toBe('SOON');
    expect((await go(101)).status).toBe('ADMITTED');
    // 105는 다시 오지 않아 리더가 뺐다. 110이 다음 자리를 받는다
    await h.dropSoon(eventId, tokens.hash(who.get(105)!.t));
    await h.store.sessionEnded({ eventId, jti: 'x3' });
    expect((await go(110)).status).toBe('ADMITTED');
    expect((await h.slots(eventId)).size).toBe(3);
    expect(await h.admitted(eventId)).toBe(3);
    expect(signals.seen.soonWait).toHaveLength(2);
    expect(signals.seen.beforeTurn).toHaveLength(0);
  });

  test(`[${name}] retryAfterSeconds는 (앞 수 + 1 − 빈자리) ÷ 최근 10초 입장 속도를 올림해 1~5초로 자른다`, async () => {
    const { h, eventId, ticket, confirm } = await world({ serving: 500 });
    await h.setTarget(eventId, 10);
    for (let i = 0; i < 10; i += 1) expect((await confirm(ticket(100 + i), { pid: newPid() })).status).toBe('ADMITTED');
    // 지난 10초 입장 10건 → 초당 1. 앞 0: (0 + 1 − 0) ÷ 1 = 1초, 앞 2: 3초, 앞 7: 8초 → 5초
    const r0 = await confirm(ticket(200), { pid: newPid() });
    expect(r0.status === 'SOON' && r0.retryAfterSeconds).toBe(1);
    await confirm(ticket(201), { pid: newPid() });
    const r2 = await confirm(ticket(300), { pid: newPid() });
    expect(r2.status === 'SOON' && r2.retryAfterSeconds).toBe(3);
    for (const s of [301, 302, 303, 304]) await confirm(ticket(s), { pid: newPid() });
    const r6 = await confirm(ticket(400), { pid: newPid() });
    expect(r6.status === 'SOON' && r6.retryAfterSeconds).toBe(5);
  });

  test(`[${name}] 지금 목표가 없으면 5,000이다`, async () => {
    const { h, eventId, now, ticket, confirm } = await world();
    for (let i = 0; i < 20; i += 1) await h.addSlot(eventId, `s${i}`, now + 60_000);
    expect((await confirm(ticket(150))).status).toBe('ADMITTED');
  });

  test(`[${name}] 만료된 자리는 빈자리로 센다`, async () => {
    const { h, eventId, now, ticket, confirm } = await world();
    await h.setTarget(eventId, 1);
    await h.addSlot(eventId, 'gone', now - 1_000);
    expect((await confirm(ticket(150))).status).toBe('ADMITTED');
  });

  test(`[${name}] 매진이면 410 sold-out, 매진이 풀린 뒤 매진 때의 마지막 발급 번호 이하도 sold-out, 그 뒤 번호는 받는다. 일시 매진에는 평소대로 받는다(Q-T51, ADR-0122)`, async () => {
    const a = await world();
    await a.h.setNotice(a.eventId, { saleState: 'SOLD_OUT' });
    await rejects(a.confirm(a.ticket(150)), 'SOLD_OUT');
    const b = await world({ serving: 300 });
    await b.h.setNotice(b.eventId, { saleState: 'ON_SALE', soldOutLastSeq: '180' });
    await rejects(b.confirm(b.ticket(180)), 'SOLD_OUT');
    expect((await b.confirm(b.ticket(181))).status).toBe('ADMITTED');
    const c = await world();
    await c.h.setNotice(c.eventId, { saleState: 'ALL_HELD' });
    expect((await c.confirm(c.ticket(150))).status).toBe('ADMITTED');
    const d = await world();
    await d.h.setNotice(d.eventId, { saleState: 'ENDED' });
    await rejects(d.confirm(d.ticket(150)), 'SALE_ENDED');
  });

  test(`[${name}] 판매 종료 뒤에는 차례가 왔어도 410 sale-ended이고 자리를 주지 않는다(ADR-0064)`, async () => {
    const h = await setup();
    const eventId = newEvent();
    const now = h.clock.now();
    const s = { opensAtMs: now - 3 * 24 * 3600_000, startsAtMs: now + 3600_000, lobbyShuffle: true, openBatch: true };
    expect(saleEndOf(s)).toBeLessThan(now);
    await h.schedules.set(eventId, s);
    await h.setServing(eventId, 200);
    const app = new ConfirmAdmission(h.store, h.schedules, tokens, signer, recordingSignals(), h.clock);
    const t = tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: 150, g: 1, seg: 0, rq: 'rq', jny: JNY });
    await rejects(app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } }), 'SALE_ENDED');
    expect((await h.slots(eventId)).size).toBe(0);
  });

  test(`[${name}] 대기표가 다른 회차·다른 계정·변조면 403 queue-ticket-invalid, 참가 토큰만 오면 같은 403, 우선 구매 권리는 404다`, async () => {
    const { eventId, ticket, confirm } = await world();
    await rejects(confirm(ticket(150, { e: `${eventId}-x` })), 'TICKET_INVALID');
    await rejects(confirm(ticket(150, { a: OTHER_ACCOUNT })), 'TICKET_INVALID');
    await rejects(confirm(`${ticket(150)}x`), 'TICKET_INVALID');
    await rejects(confirm('', { body: { lobbyToken: 'lobby-token' } }), 'TICKET_INVALID');
    await rejects(confirm('', { body: { priorityGrantId: '0190f3a1-7c2e-7a00-8000-0000000000cc' } }), 'PRIORITY_GRANT_NOT_FOUND');
  });

  test(`[${name}] 일정 사본이 없으면 404다`, async () => {
    const h = await setup();
    const app = new ConfirmAdmission(h.store, h.schedules, tokens, signer, recordingSignals(), h.clock);
    const eventId = newEvent();
    const t = tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: 1, g: 1, seg: 0, rq: 'rq', jny: JNY });
    await rejects(app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } }), 'NOT_FOUND');
  });

  test(`[${name}] 구매 세션 시작은 남은 자리만 최대 체류 시각으로 올리고(되살리지 않음), 종료는 자리를 뺀다(Q-T11)`, async () => {
    const { h, eventId, now, ticket, confirm } = await world();
    const r = await confirm(ticket(150));
    if (r.status !== 'ADMITTED') throw new Error('ADMITTED가 아니다');
    const jti = readAdmissionToken(r.admissionToken).claims.jti as string;
    expect(await h.store.sessionStarted({ eventId, jti, maxStayUntilMs: now + MAX_STAY_MS })).toBe(true);
    expect((await h.slots(eventId)).get(jti)).toBe(now + MAX_STAY_MS);
    // 낮은 점수로 늦게 온 같은 사건은 내리지 않는다
    expect(await h.store.sessionStarted({ eventId, jti, maxStayUntilMs: now + 1_000 })).toBe(false);
    expect((await h.slots(eventId)).get(jti)).toBe(now + MAX_STAY_MS);
    expect(await h.store.sessionEnded({ eventId, jti })).toBe(true);
    expect((await h.slots(eventId)).size).toBe(0);
    expect(await h.store.sessionStarted({ eventId, jti, maxStayUntilMs: now + MAX_STAY_MS })).toBe(false);
    expect((await h.slots(eventId)).size).toBe(0);
    expect(await h.store.sessionEnded({ eventId, jti })).toBe(false);
  });

  test(`[${name}] 예상 대기 오차는 처음 입장 때 (차례 시각 − 처음 보인 시각) ÷ 처음 예상 대기이고, 범위 밖이면 버린다`, async () => {
    const { turnAt, signals, ticket, confirm } = await world({ turnAgoMs: 30_000 });
    // 처음 보인 때가 차례 120초 전, 예상 100초 → 1.2. 같은 대기표로 다시 오면(처음 입장이 아님) 다시 넣지 않는다
    const t = ticket(150);
    const body = { queueTicket: t, firstEtaSec: 100, firstEtaAtMs: turnAt - 120_000 };
    expect((await confirm(t, { body })).status).toBe('ADMITTED');
    expect((await confirm(t, { body })).status).toBe('ADMITTED');
    expect(signals.seen.eta).toHaveLength(1);
    expect(signals.seen.eta![0]!).toBeCloseTo(1.2, 1);
    // 관측 칸의 모양이 틀려도 입장은 그대로다
    const odd = ticket(151);
    expect((await confirm(odd, { pid: newPid(), body: { queueTicket: odd, firstEtaSec: 'x', firstEtaAtMs: 1.5 } })).status).toBe('ADMITTED');
    expect(signals.seen.eta).toHaveLength(1);
    const b = await world();
    const t1 = b.ticket(150);
    const t2 = b.ticket(151);
    expect((await b.confirm(t1, { body: { queueTicket: t1, firstEtaSec: 100, firstEtaAtMs: b.now + 60_000 } })).status).toBe('ADMITTED');
    expect((await b.confirm(t2, { pid: newPid(), body: { queueTicket: t2, firstEtaSec: 100, firstEtaAtMs: b.now - 3 * 24 * 3600_000 } })).status).toBe('ADMITTED');
    expect(b.signals.seen.eta).toHaveLength(0);
  });

  test(`[${name}] 차례를 확인한 뒤 저장소가 잠시 안 되면 503 원인을 그대로 던지고 차례가 온 사람의 시스템 원인 실패로 센다(Q-T28)`, async () => {
    const failing = (store: AdmissionStore) =>
      new Proxy(store, {
        get(target, k) {
          const f = Reflect.get(target, k) as unknown;
          if (k === 'admit') return () => Promise.reject(new QueueStoreUnavailable(new Error('down')));
          return typeof f === 'function' ? (f as (...a: unknown[]) => unknown).bind(target) : f;
        },
      });
    const { h, signals, ticket, confirm, eventId } = await world({ wrap: failing });
    await expect(confirm(ticket(150))).rejects.toBeInstanceOf(QueueStoreUnavailable);
    // 이 요청이 새로 채운 1인 1순번 키는 지운다(입장하지 않았다)
    expect(signals.seen.system).toHaveLength(1);
    // 차례 전 요청의 장애는 세지 않는다
    await expect(confirm(ticket(900))).resolves.toMatchObject({ status: 'NOT_YET' });
    expect(signals.seen.system).toHaveLength(1);
    expect(await h.adm(PID, eventId)).toBeNull();
  });
}

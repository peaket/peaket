// SCR-061 내 현장 배정 실제 흐름의 화면 값 시험(d5 §5.35, docs/features/identity.md §12 I-T93 ①~③, BUILD_ORDER F-05-7 시험 담당).
// 화면 값은 model/live.ts(경로 별칭 없이 읽힌다)에서, 목록 호출은 features/staff-invitation의 listAssignments에서 본다. 경계(fetch)만 가짜다.
// 문구는 d5 §5.35·I-T93의 글이다(화면 부품 .tsx는 node로 그리지 못해 그 글이 부품에 있는지만 소스로 본다).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createStaffInvitationApi } from '../../../features/staff-invitation/index.ts';
import { staffLoginHref } from '../../../shared/lib/staff-fragment.ts';
import { staffHomeLiveView } from './live.ts';

const LIVE_UI = readFileSync(new URL('../ui/StaffHomeLive.tsx', import.meta.url), 'utf8');
const NOW = Date.parse('2026-12-04T08:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const EV_A = '0190f3a1-7c2e-7a00-8000-00000000e611';
const EV_B = '0190f3a1-7c2e-7a00-8000-00000000e612';
const a = (id, status, from, until, o = {}) => ({ assignmentId: id, eventId: EV_A, role: 'gate_staff', status, validFrom: iso(from), validUntil: iso(until), activeScannerDeviceName: null, ...o });
const SUM = new Map([
  [EV_A, { kind: 'ok', summary: { eventId: EV_A, title: '겨울 실내악 밤', startsAt: '2026-12-04T09:00:00.000Z', sellerName: '(주)바람소리기획' } }],
  [EV_B, { kind: 'unreadable' }],
]);

test('I-T93 ① 배정마다 회차 공개 요약으로 공연명·회차·상호를 채우고 배지를 지금 시각으로 정한다', () => {
  const v = staffHomeLiveView([a('on', 'ASSIGNED', NOW - HOUR, NOW + HOUR, { activeScannerDeviceName: '서문-14' })], SUM, NOW);
  assert.equal(v.current.length, 1);
  const c = v.current[0];
  assert.equal(c.title, '겨울 실내악 밤');
  assert.equal(c.partnerName, '(주)바람소리기획');
  assert.equal(c.sub, '12/4(금) 18:00');
  assert.equal(c.phase, 'active');
  assert.equal(c.phaseLabel, '진행 중');
  assert.equal(c.roleLabel, '현장 스태프');
  assert.equal(c.scannerName, '서문-14');
  // 요약을 못 읽은 회차는 공연명·상호 없이
  const u = staffHomeLiveView([a('u', 'ASSIGNED', NOW - HOUR, NOW + HOUR, { eventId: EV_B })], SUM, NOW).current[0];
  assert.equal(u.title, null);
  assert.equal(u.partnerName, null);
});

test('I-T93 ② 곧 시작·진행 중·validUntil 전의 해제는 현재 배정, 끝난 배정·지난 해제는 지난 배정이고 안내는 곧 시작·진행 중이 있을 때만이다', () => {
  const items = [
    a('soon', 'ASSIGNED', NOW + 1, NOW + 5 * HOUR),
    a('active', 'ASSIGNED', NOW, NOW + HOUR),
    a('revoked-now', 'REVOKED', NOW - HOUR, NOW),
    a('revoked-old', 'REVOKED', NOW - 3 * HOUR, NOW - 1),
    a('ended', 'ENDED', NOW - 9 * HOUR, NOW - 5 * HOUR),
    a('over', 'ASSIGNED', NOW - 3 * HOUR, NOW - 1),
  ];
  const v = staffHomeLiveView(items, SUM, NOW);
  assert.deepEqual(v.current.map((c) => [c.id, c.phaseLabel]), [
    ['soon', '곧 시작'],
    ['active', '진행 중'],
    ['revoked-now', '해제'],
  ]);
  assert.deepEqual(v.past.map((c) => [c.id, c.phaseLabel]), [
    ['revoked-old', '해제'],
    ['ended', '종료'],
    ['over', '종료'],
  ]);
  assert.equal(v.guide, true);
  assert.equal(v.empty, false);
  // 지난 배정 줄은 회차 시작 · 상호
  assert.equal(v.past.find((c) => c.id === 'ended').sub, '12/4(금) 18:00 · (주)바람소리기획');
  // 해제만 남으면 스캐너 로그인 방법 안내가 없다
  assert.equal(staffHomeLiveView([a('r', 'REVOKED', NOW - HOUR, NOW + HOUR)], SUM, NOW).guide, false);
  // 화면 부품이 정본 문구를 그 조건에 쓴다
  assert.match(LIVE_UI, /파트너가 배정을 해제했습니다/);
  // '지금 로그인한 스캐너: {이름}'은 이름표와 값 두 칸으로 그린다(카드의 scannerName이 있을 때만)
  assert.match(LIVE_UI, /\{card\.scannerName \? \([\s\S]{0,200}지금 로그인한 스캐너<\/span>\s*<strong[^>]*>\{card\.scannerName\}<\/strong>/);
});

test('I-T93 ③ 빈 목록은 빈 화면이고, 부품은 빈 화면·실패 문구와 [다시 불러오기]를 쓴다', () => {
  const v = staffHomeLiveView([], SUM, NOW);
  assert.deepEqual(v, { current: [], past: [], guide: false, empty: true });
  assert.match(LIVE_UI, /배정된 현장 근무가 없습니다/);
  assert.match(LIVE_UI, /현장 근무를 불러오지 못했습니다/);
  assert.match(LIVE_UI, /다시 불러오기/);
});

test('I-T93 ③ 첫 쪽은 limit 50이고 nextCursor가 있으면 다음 쪽을 그 커서로 부른다. 401(갱신도 401)은 /login?next=/staff다', async () => {
  const calls = [];
  const page1 = { items: [a('p1', 'ASSIGNED', NOW, NOW + HOUR)], nextCursor: 'cur-2' };
  const page2 = { items: [a('p2', 'ENDED', NOW - 9 * HOUR, NOW - 5 * HOUR)] };
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', credentials: init.credentials });
    const u = new URL(url);
    return new Response(JSON.stringify(u.searchParams.get('cursor') ? page2 : page1), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const api = createStaffInvitationApi({ origin: 'https://api.peaket.test', fetch: f });
  const first = await api.listAssignments();
  assert.equal(first.kind, 'ok');
  assert.deepEqual(first.items.map((x) => x.assignmentId), ['p1']);
  assert.equal(first.nextCursor, 'cur-2');
  const q1 = new URL(calls[0].url);
  assert.equal(q1.pathname, '/v1/staff-assignments');
  assert.deepEqual(Object.fromEntries(q1.searchParams), { limit: '50' });
  assert.equal(calls[0].credentials, 'include');
  const second = await api.listAssignments(first.nextCursor);
  assert.deepEqual(second.items.map((x) => x.assignmentId), ['p2']);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(Object.fromEntries(new URL(calls[1].url).searchParams), { limit: '50', cursor: 'cur-2' });
  // 401 뒤 갱신도 401이면 login, 그 밖 실패는 error
  const unauth = createStaffInvitationApi({ origin: '', fetch: async () => new Response(null, { status: 401 }) });
  assert.deepEqual(await unauth.listAssignments(), { kind: 'login' });
  const broken = createStaffInvitationApi({ origin: '', fetch: async () => new Response('{}', { status: 500 }) });
  assert.deepEqual(await broken.listAssignments(), { kind: 'error' });
  const u = new URL(staffLoginHref('/staff'), 'https://www.peaket.test');
  assert.equal(`${u.pathname}?next=${u.searchParams.get('next')}`, '/login?next=/staff');
});

// [좌석맵 저장]의 요청과 답 표 시험(ADR-0264 결정 8, d5 §6.5). 가짜 클라이언트로 보낸 요청(If-Match·본문)을 보고, 답마다 화면 동작을 정확한 값으로 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyDoc, ifMatchOf, SAVE_MAX_BYTES, saveBlockers, saveBody } from './doc.ts';
import { canSave, DEFAULT_RETRY_MS, failedAnswer, fieldLabel, savedAnswer, TEXT } from './save-answer.ts';
import { BodyTooLarge, failureOf, importSeatmap, loadSeatmap, saveSeatmap } from './seatmap-api.ts';

function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    deps: {
      client: {
        async send(op, o) {
          calls.push({ op, ...o });
          if (answer instanceof Error || (answer && answer.status >= 400)) throw answer;
          return answer;
        },
      },
      ops: { getPartnerProductionSeatmap: 'GET seatmap', putPartnerProductionSeatmap: 'PUT seatmap', createPartnerProductionSeatmapImport: 'POST imports' },
      parseRetryAfter: (h) => (/^\d+$/.test(h) ? Number(h) * 1000 : undefined),
    },
  };
}
const headers = (etag) => ({ get: (k) => (k === 'etag' ? etag : null) });

test('FE-T46 ⑦ 저장 본문은 If-Match "0"·색인과 응답 전용 칸 없음이고 412·409·403·422·429·503·12MiB·떠나기 확인이 정한 대로다 [ASVS v5.0.0-3.5.2] [ASVS v5.0.0-2.2.2]', async () => {
  const doc = {
    ...emptyDoc(),
    order: ['s1'],
    sections: { s1: { sectionId: 's1', name: 'A', shape: { kind: 'RECT', points: [[0, 0], [10, 0], [10, 10], [0, 10]] }, tierId: 'R', seats: [{ seatId: 'a', row: '1', number: 1, x: 5, y: 5 }] } },
    priceTiers: [{ tierId: 'R', name: 'R석', price: 1000 }],
  };
  // 판 0: If-Match "0", 사전 요청이 생기는 요청(PUT + JSON + If-Match)이다
  const ok = fakeClient({ data: { layoutVersion: 1, fanFilePublished: false, sections: [] }, status: 200, headers: headers('"1"') });
  const r = await saveSeatmap('p1', saveBody(doc, 0), ok.deps);
  assert.equal(ok.calls.length, 1);
  assert.deepEqual([ok.calls[0].op, ok.calls[0].ifMatch, ok.calls[0].params], ['PUT seatmap', '"0"', { productionId: 'p1' }]);
  const sent = JSON.stringify(ok.calls[0].body);
  for (const k of ['"index"', '"seatIndexRange"', '"fanFilePublished"', '"geometryLocked"', '"warnings"']) assert.equal(sent.includes(k), false, k);
  assert.equal(ifMatchOf(10), '"10"');
  // 200: 응답 판(ETag)과 게시 안 됨 안내
  assert.deepEqual(savedAnswer(r.layout, r.etag), { kind: 'saved', layout: r.layout, version: 1, notice: TEXT.notPublished });
  assert.equal(savedAnswer({ layoutVersion: 10, fanFilePublished: true }, '"10"').version, 10);

  // 답 표
  const now = 1_000_000;
  assert.deepEqual(failedAnswer({ status: 412, type: 'precondition-failed' }, now), { kind: 'conflict', text: '다른 곳에서 좌석맵이 바뀌었습니다. 지금 변경을 JSON으로 내보낸 뒤 다시 불러오세요' });
  assert.deepEqual(failedAnswer({ status: 409, type: 'seatmap-geometry-locked' }, now), { kind: 'locked', text: TEXT.locked });
  assert.deepEqual(failedAnswer({ status: 409, type: 'sale-setting-locked' }, now), { kind: 'locked', text: TEXT.tiersLocked });
  assert.deepEqual(failedAnswer({ status: 409, type: 'production-suspended' }, now), { kind: 'message', text: TEXT.suspended });
  assert.deepEqual(failedAnswer({ status: 403, type: 'partner-admin-required' }, now), { kind: 'message', text: '판매 승인을 받은 공연의 좌석맵은 파트너 관리자만 저장할 수 있습니다' });
  assert.deepEqual(failedAnswer({ status: 404, type: 'not-found' }, now), { kind: 'notFound', text: '공연을 찾을 수 없습니다' });
  const inv = failedAnswer({ status: 422, type: 'seatmap-invalid', extensions: { result: { ok: false, errors: [{ line: 0, field: 'sections[0].seats[0].tierId', code: 'TIER_UNKNOWN' }] } } }, now);
  assert.deepEqual(inv, { kind: 'invalid', text: TEXT.invalid, rows: [{ field: 'sections[0].seats[0].tierId', text: '가격 등급에 없는 등급입니다' }] });
  assert.equal(fieldLabel('sections[0].seats[0].tierId', ['A구역']), 'A구역 1번째 좌석 tierId');
  // 429·503은 Retry-After 동안 [좌석맵 저장]을 잠근다(없으면 10초 [가정]). 경계: 잠근 시각 − 1ms는 못 누르고 그 시각에는 누른다
  const busy = failedAnswer({ status: 429, type: 'server-busy', retryFloorMs: 7_000 }, now);
  assert.deepEqual(busy, { kind: 'busy', text: TEXT.busy, retryAt: now + 7_000 });
  assert.equal(canSave(busy.retryAt, now + 6_999), false);
  assert.equal(canSave(busy.retryAt, now + 7_000), true);
  assert.deepEqual(failedAnswer({ status: 503, type: 'seatmap-publish-unavailable' }, now), { kind: 'busy', text: TEXT.publish, retryAt: now + DEFAULT_RETRY_MS });
  assert.equal(DEFAULT_RETRY_MS, 10_000);
  for (const status of [504, 500, 0]) assert.deepEqual(failedAnswer({ status, type: 'x' }, now), { kind: 'unknown', text: '저장했는지 확인하지 못했습니다. 다시 불러와 확인해 주세요' });
  // 서버 답 → 표의 입력(Retry-After 초 → ms)
  assert.deepEqual(await failureOf({ status: 503, type: 'server-busy', retryAfter: '12', extensions: {} }, now, ok.deps), { status: 503, type: 'server-busy', extensions: {}, retryFloorMs: 12_000 });
  assert.deepEqual(await failureOf(new TypeError('network'), now, ok.deps), { status: 0, type: 'network' });

  // 12MiB: 정확히는 보내고 1바이트 넘으면 보내지 않는다
  assert.equal(SAVE_MAX_BYTES, 12 * 1024 * 1024);
  const pad = (n) => ({ layoutVersion: 0, x: 'a'.repeat(n - JSON.stringify({ layoutVersion: 0, x: '' }).length) });
  const exact = fakeClient({ data: {}, status: 200, headers: headers('"1"') });
  await saveSeatmap('p1', pad(SAVE_MAX_BYTES), exact.deps);
  assert.equal(exact.calls.length, 1);
  const over = fakeClient({ data: {}, status: 200, headers: headers('"1"') });
  await assert.rejects(saveSeatmap('p1', pad(SAVE_MAX_BYTES + 1), over.deps), BodyTooLarge);
  assert.equal(over.calls.length, 0);
  assert.deepEqual(saveBlockers(doc, pad(SAVE_MAX_BYTES + 1)), ['좌석맵이 너무 큽니다. 좌석이나 구역을 줄여 주세요']);
  assert.deepEqual(saveBlockers(doc, pad(SAVE_MAX_BYTES)), []);
  // 가격을 채우지 않은 등급(가져온 파일)은 저장을 막는다
  assert.equal(saveBlockers({ ...doc, priceTiers: [{ tierId: 'X', name: 'X', price: null }] }).length, 1);
  // 실패 답은 던진다(저장소는 부른 쪽이 그대로 둔다)
  const fail = fakeClient(Object.assign(new Error('412'), { status: 412, type: 'precondition-failed' }));
  await assert.rejects(saveSeatmap('p1', saveBody(doc, 3), fail.deps), (e) => e.status === 412);
  assert.equal(fail.calls[0].ifMatch, '"3"');
});

test('FE-T46 ① 불러오기는 배치본이 없으면(404) 시작 화면, 있으면 응답과 ETag', async () => {
  const none = fakeClient(Object.assign(new Error('404'), { status: 404, type: 'not-found' }));
  assert.deepEqual(await loadSeatmap('p1', undefined, none.deps), { kind: 'none' });
  const has = fakeClient({ data: { layoutVersion: 7 }, status: 200, headers: headers('"7"') });
  assert.deepEqual(await loadSeatmap('p1', undefined, has.deps), { kind: 'ok', layout: { layoutVersion: 7 }, etag: '"7"' });
  const broken = fakeClient(Object.assign(new Error('503'), { status: 503, type: 'x' }));
  await assert.rejects(loadSeatmap('p1', undefined, broken.deps), (e) => e.status === 503);
});

test('내보내기 파일 이름은 seatmap-{ID 8자}-v{판}이고 가져오기 파일 칸 이름은 seatmap.{형식}이다 [ASVS v5.0.0-5.4.1]', async () => {
  const c = fakeClient({ data: { ok: true }, status: 200, headers: headers(null) });
  const file = new Blob(['a,b'], { type: 'text/plain' });
  await importSeatmap('p1', 'CSV', new File([file], '../../내 파일<script>.csv'), c.deps);
  const fd = c.calls[0].body;
  assert.equal(c.calls[0].headers['X-Requested-With'], 'peaket-partner');
  assert.equal(fd.get('format'), 'CSV');
  assert.equal(fd.get('file').name, 'seatmap.csv');
  assert.equal(fd.get('file').type, 'text/csv');
  const { fileStem } = await import('./doc.ts');
  assert.equal(fileStem('0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01', 12), 'seatmap-0b8f1f2e-v12');
});

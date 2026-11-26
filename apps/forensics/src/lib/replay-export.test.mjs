// F-04-16 replay-export 받기·응답 계약·파일 검증 시험. 정본: docs/features/forensic-replay.md §4.2·§6.3·§6.5·§6.7.1·§6.8,
// docs/api/openapi.yaml GET /v1/ops/fraud-cases/{caseId}/replay-export·GET /v1/ops/research-exports/{exportId},
// docs/security/asvs/forensic-replay.md(v5.0.0-1.5.2·5.2.2·5.2.3·5.4.1·14.3.3).
// 운영 모듈이 없으면 시험마다 단언으로 실패하게 동적 import를 쓴다(architecture §8.6 4의 3·7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  COLUMN_SPECS,
  EVENT_KIND,
  MAX_FILE_BYTES,
  MAX_WINDOW_MS,
  RESULT,
  SCHEMA_NAME,
  columnsFromRows,
} from './forensics/events.ts';

const CASE_ID = '11111111-1111-7111-8111-111111111111';
const EXPORT_ID = '22222222-2222-7222-8222-222222222222';
const EVENT_ID = 'evt-lumen-2026-r1';

const TARGET_INV = {
  source: 'INVESTIGATION',
  sourceLabel: 'investigation',
  eventId: EVENT_ID,
  caseId: CASE_ID,
  exportId: null,
};
const TARGET_RES = {
  source: 'RESEARCH',
  sourceLabel: 'research',
  eventId: EVENT_ID,
  caseId: null,
  exportId: EXPORT_ID,
};

async function load() {
  try {
    return await import('./replay-export.ts');
  } catch {
    return null;
  }
}

const replay = await load();

function need(name) {
  assert.ok(replay, 'replay-export 모델(src/lib/replay-export.ts)이 없다');
  assert.equal(typeof replay[name], 'function', `${name}이 없다`);
  return replay[name];
}

const SCHEMA = COLUMN_SPECS.map((c) => ({ name: c.name, type: c.type }));
const ROWS = [
  { t_ms: -1_000, kind: EVENT_KIND.QUEUE_ENTER, session: 1 },
  { t_ms: 0, kind: EVENT_KIND.ADMIT, session: 1, first_hold_ms: 100 },
  { t_ms: 100, kind: EVENT_KIND.HOLD_TRY, seat: 5, section: 0, session: 1, result: RESULT.HELD, latency_ms: 50, first_hold_ms: 100 },
  { t_ms: 1_000, kind: EVENT_KIND.HOLD_END, seat: 5, section: 0, session: 1 },
  { t_ms: 1_100, kind: EVENT_KIND.PAY_TRY, seat: 5, section: 0, session: 1, latency_ms: 40 },
  { t_ms: 1_500, kind: EVENT_KIND.SALE, seat: 5, section: 0, session: 1, result: RESULT.PAID },
];
const ENVELOPE = { byteLength: 39 * ROWS.length, head: 'ARROW1', tail: 'ARROW1' };

function invFile(overrides = {}) {
  const columns = columnsFromRows(ROWS);
  for (let i = 0; i < columns.t_ms.length; i += 1) {
    columns.entropy[i] = Number.NaN;
    columns.net_type[i] = 0;
    columns.asn[i] = 0;
    columns.device_group[i] = 0;
    columns.bot_tier[i] = 0;
    columns.member[i] = 0;
    columns.post_seat[i] = 0;
  }
  return {
    meta: {
      schema: SCHEMA_NAME,
      source: 'INVESTIGATION',
      seatCount: 1_000,
      sectionCount: 2,
      saleStart: '2026-11-28T09:00:00.000Z',
      eventId: EVENT_ID,
      caseId: CASE_ID,
      snapshotVersion: '1',
      windowFromMs: -600_000,
      windowToMs: MAX_WINDOW_MS,
      ...(overrides.meta ?? {}),
    },
    schema: overrides.schema ?? SCHEMA,
    columns: overrides.columns ?? columns,
    envelope: { ...ENVELOPE, ...(overrides.envelope ?? {}) },
  };
}

test('FX-T21 ② [ASVS v5.0.0-5.2.2] replay-export는 앞뒤 ARROW1 매직과 200MB 경계를 읽기 전에 본다', () => {
  const envelopeOf = need('replayEnvelopeOf');
  const fileIssue = need('replayFileIssue');
  assert.equal(typeof replay.ARROW_MAGIC, 'string');
  assert.equal(replay.ARROW_MAGIC, 'ARROW1');

  const bytes = new TextEncoder().encode('ARROW1bodyARROW1');
  assert.deepEqual(envelopeOf(bytes), { byteLength: bytes.byteLength, head: 'ARROW1', tail: 'ARROW1' });
  assert.equal(fileIssue(envelopeOf(bytes)), undefined);

  assert.match(fileIssue({ byteLength: 12, head: 'ARROW0', tail: 'ARROW1' }), /ARROW1/);
  assert.match(fileIssue({ byteLength: 12, head: 'ARROW1', tail: '' }), /ARROW1/);
  assert.match(fileIssue({ byteLength: MAX_FILE_BYTES + 1, head: 'ARROW1', tail: 'ARROW1' }), /200MB/);
  assert.equal(fileIssue({ byteLength: MAX_FILE_BYTES, head: 'ARROW1', tail: 'ARROW1' }), undefined, '200MB 경계는 허용한다');
});

test('FX-T21 ③ 응답은 no-store·Content-Disposition 없음·Arrow 미디어 형식만 받는다', () => {
  const headersIssue = need('replayHeadersIssue');
  const good = new Headers({
    'content-type': 'application/vnd.apache.arrow.file',
    'cache-control': 'no-store',
  });
  assert.equal(headersIssue(200, good), undefined);

  const wrongType = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  assert.match(headersIssue(200, wrongType), /Arrow|형식/);

  const cached = new Headers({ 'content-type': 'application/vnd.apache.arrow.file', 'cache-control': 'private, max-age=60' });
  assert.match(headersIssue(200, cached), /no-store/);

  const attachment = new Headers({
    'content-type': 'application/vnd.apache.arrow.file',
    'cache-control': 'no-store',
    'content-disposition': 'attachment; filename="replay.arrow"',
  });
  assert.match(headersIssue(200, attachment), /Content-Disposition|내려받/);
});

test('FX-T21 ③ 받은 파일은 스키마·원천 대조를 통과해야 하고 원천이 다르면 파일 거절이다', () => {
  const fileValidation = need('replayFileValidation');
  assert.equal(fileValidation(invFile(), TARGET_INV).ok, true);

  const mismatch = fileValidation(invFile(), TARGET_RES);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'source-mismatch');

  const unknownColumn = invFile({ schema: [...SCHEMA, { name: 'ip', type: 'utf8' }] });
  const unknownResult = fileValidation(unknownColumn, TARGET_INV);
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.code, 'schema-columns');
});

test('FX-T21 ③ [ASVS v5.0.0-5.2.3] 압축 버퍼·사전 열은 풀기 전에 거절한다', () => {
  const fileValidation = need('replayFileValidation');
  const compressed = invFile({ schema: SCHEMA.map((c, i) => (i === 0 ? { ...c, compressed: true } : c)) });
  const compressedResult = fileValidation(compressed, TARGET_INV);
  assert.equal(compressedResult.ok, false);
  assert.equal(compressedResult.code, 'schema-compressed');

  const dictionary = invFile({ schema: SCHEMA.map((c, i) => (i === 0 ? { ...c, dictionary: true } : c)) });
  const dictionaryResult = fileValidation(dictionary, TARGET_INV);
  assert.equal(dictionaryResult.ok, false);
  assert.equal(dictionaryResult.code, 'schema-dictionary');
});

test('A-T23 ② [ASVS v5.0.0-1.5.2] 연구 원천 파일은 조사 칸·원문 IP 열을 싣지 않고 열 허용 목록 밖 칸을 거절한다', () => {
  const fileValidation = need('replayFileValidation');
  assert.ok(!COLUMN_SPECS.some((c) => c.name === 'ip'), '파일 열에 ip가 있으면 안 된다');
  assert.ok(!COLUMN_SPECS.some((c) => c.name === 'account_id'), '파일 열에 account_id가 있으면 안 된다');

  const research = invFile({
    meta: {
      source: 'RESEARCH',
      eventId: EVENT_ID,
      caseId: undefined,
      snapshotVersion: undefined,
      windowFromMs: -600_000,
      windowToMs: MAX_WINDOW_MS,
    },
  });
  assert.equal(fileValidation(research, TARGET_RES).ok, true);

  const withMember = invFile({
    meta: {
      source: 'RESEARCH',
      eventId: EVENT_ID,
      caseId: undefined,
      snapshotVersion: undefined,
      windowFromMs: -600_000,
      windowToMs: MAX_WINDOW_MS,
    },
  });
  withMember.columns.member[2] = 1;
  const result = fileValidation(withMember, TARGET_RES);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source-rule');
});

test('FX-T21 ④ 원천 보존이 지난 회차는 410 investigation-source-expired로 원천 만료 화면이다', () => {
  const problem = need('replayProblem');
  const inv = problem(410, 'investigation-source-expired', 'INVESTIGATION');
  assert.equal(inv.kind, 'expired');
  assert.match(inv.message, /조사용 기록.*보존 기간/);

  const res = problem(410, 'retention-ended', 'RESEARCH');
  assert.equal(res.kind, 'expired');
  assert.match(res.message, /가명 기록.*90일/);
});

test('FX-T21 ⑤ 지정 없는 운영자의 403은 권한 없음 화면이고 감사 기록은 서버 몫이다', () => {
  const problem = need('replayProblem');
  const denied = problem(403, 'investigator-required', 'INVESTIGATION');
  assert.equal(denied.kind, 'denied');
  assert.match(denied.message, /부정 거래 조사관/);

  const handler = problem(403, 'pseudonym-handler-required', 'RESEARCH');
  assert.equal(handler.kind, 'denied');
  assert.match(handler.message, /가명정보 취급자/);
});

test('FX-T10 ④ [ASVS v5.0.0-5.4.1] 연구 내보내기는 fetch로만 받고 내려받기 링크·Content-Disposition·주소 열기를 만들지 않는다', () => {
  const operationOf = need('replayOperation');
  const op = operationOf(TARGET_RES);
  assert.equal(op.operationId, 'getOpsResearchExport');
  assert.deepEqual(op.params, { exportId: EXPORT_ID });
  assert.deepEqual(op.query, {});

  const source = readFileSync('src/operating/OperatingApp.tsx', 'utf8');
  assert.doesNotMatch(source, /<a[^>]+download/i);
  assert.doesNotMatch(source, /window\.open/);
  assert.doesNotMatch(source, /createObjectURL/);
  assert.doesNotMatch(source, /Content-Disposition/i);
});

test('FX-T10 ⑤ 가명처리 적정성 검토 전 403 pseudonymization-review-pending은 연구 원천 안내 문구다', () => {
  const problem = need('replayProblem');
  const pending = problem(403, 'pseudonymization-review-pending', 'RESEARCH');
  assert.equal(pending.kind, 'review-pending');
  assert.match(pending.message, /가명 처리 검토/);
});

test('FX-T21 ② 연구 내보내기가 아직 준비되지 않으면 409와 다시 시도를 안내한다', () => {
  const problem = need('replayProblem');
  const notReady = problem(409, 'research-export-not-ready', 'RESEARCH');
  assert.equal(notReady.kind, 'not-ready');
  assert.equal(notReady.retry, true);
  assert.match(notReady.message, /만드는 중/);
});

test('FX-T21 ③ 시간창은 시작·끝을 함께 적고 30분을 넘기지 않는다', () => {
  const windowIssue = need('replayWindowIssue');
  assert.equal(windowIssue({}), undefined);
  assert.match(windowIssue({ fromMs: 0 }), /함께/);
  assert.match(windowIssue({ fromMs: 1_000, toMs: 1_000 }), /뒤/);
  assert.match(windowIssue({ fromMs: 0, toMs: MAX_WINDOW_MS + 1 }), /30분/);
  assert.equal(windowIssue({ fromMs: 0, toMs: MAX_WINDOW_MS }), undefined);
  assert.match(windowIssue({ fromMs: 0.5, toMs: 1 }), /정수/);
});

test('FX-T21 ④ replay-export 작업은 사건 작업대와 연구 메뉴의 계약 경로를 가른다', () => {
  const operationOf = need('replayOperation');
  const inv = operationOf(TARGET_INV, { fromMs: -600_000, toMs: MAX_WINDOW_MS });
  assert.equal(inv.operationId, 'getOpsFraudCaseReplayExport');
  assert.deepEqual(inv.params, { caseId: CASE_ID });
  assert.deepEqual(inv.query, { fromMs: -600_000, toMs: MAX_WINDOW_MS });

  const res = operationOf(TARGET_RES);
  assert.equal(res.operationId, 'getOpsResearchExport');
  assert.throws(() => operationOf(TARGET_RES, { fromMs: 0, toMs: 1_000 }), /연구 내보내기/);
});

test('[ASVS v5.0.0-14.3.3] 받은 파일은 화면 메모리에만 두고 브라우저 저장소·URL·로그에 쓰지 않는다', () => {
  const path = 'src/operating/OperatingApp.tsx';
  assert.ok(existsSync(path), '운영 화면(src/operating/OperatingApp.tsx)이 없다');
  const source = readFileSync(path, 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(source, /console\.(log|info|debug|warn|error)/);
  assert.doesNotMatch(source, /history\.(push|replace)State\([^)]*(file|bytes|replay)/i);
  assert.match(source, /setFile\(null\)/, '화면을 떠날 때 파일을 지우는 정리가 없다');
  assert.match(source, /AbortController/, '화면을 떠날 때 받기를 멈추는 신호가 없다');
});

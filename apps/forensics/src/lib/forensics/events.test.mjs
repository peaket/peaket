// F-04-9 사건 형식 v2 검증 시험. 정본: docs/features/forensic-replay.md §4.1~§4.3·§8 FX-T2,
// docs/security/asvs/forensic-replay.md v5.0.0-1.4.1·1.4.2·1.5.2·2.2.1·5.2.1·5.2.2·5.2.3.
// 화면·Arrow 실물 없이 열 배열과 메타데이터 수준에서 거절·버리기를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMN_SPECS,
  EVENT_KIND,
  MAX_FILE_BYTES,
  MAX_EVENTS,
  MAX_WINDOW_MS,
  MIN_SEATS,
  NO_SEAT,
  RESULT,
  SCHEMA_NAME,
  columnsFromRows,
  compactColumns,
  validateEventCount,
  validateFile,
} from './events.ts';

const META = {
  schema: SCHEMA_NAME,
  source: 'SYNTHETIC',
  seatCount: 1_000,
  sectionCount: 2,
  saleStart: '2026-11-28T09:00:00.000Z',
  seed: 'fx-t2',
  generatorVersion: 2,
  windowToMs: MAX_WINDOW_MS,
};

const ENVELOPE = { fileName: 'scenario.arrow', byteLength: 39 * 6, magicHead: 'ARROW1', magicTail: 'ARROW1' };
const SCHEMA = COLUMN_SPECS.map((c) => ({ name: c.name, type: c.type }));

function rows() {
  return [
    { t_ms: -1_000, kind: EVENT_KIND.QUEUE_ENTER, session: 1, device_group: 1, net_type: 1, entropy: 1.4 },
    { t_ms: 0, kind: EVENT_KIND.ADMIT, session: 1, first_hold_ms: 100, device_group: 1, net_type: 1, entropy: 1.4 },
    {
      t_ms: 100,
      kind: EVENT_KIND.HOLD_TRY,
      seat: 5,
      section: 0,
      session: 1,
      result: RESULT.HELD,
      latency_ms: 50,
      first_hold_ms: 100,
      device_group: 1,
      net_type: 1,
      entropy: 1.4,
    },
    { t_ms: 1_000, kind: EVENT_KIND.HOLD_END, seat: 5, section: 0, session: 1 },
    { t_ms: 1_100, kind: EVENT_KIND.PAY_TRY, seat: 5, section: 0, session: 1, latency_ms: 40 },
    { t_ms: 1_500, kind: EVENT_KIND.SALE, seat: 5, section: 0, session: 1, result: RESULT.PAID },
  ];
}

function validColumns() {
  return columnsFromRows(rows());
}

function file(overrides = {}) {
  return {
    meta: { ...META, ...(overrides.meta ?? {}) },
    schema: overrides.schema ?? SCHEMA,
    columns: overrides.columns ?? validColumns(),
    envelope: { ...ENVELOPE, ...(overrides.envelope ?? {}) },
    openedSource: overrides.openedSource,
  };
}

// [ASVS v5.0.0-5.2.1] [ASVS v5.0.0-5.2.2]
test('FX-T2 ① 확장자·크기·매직을 읽기 전에 거절한다', () => {
  assert.equal(validateFile(file()).ok, true);

  const wrongExtension = validateFile(file({ envelope: { fileName: 'scenario.txt' } }));
  assert.equal(wrongExtension.ok, false);
  assert.equal(wrongExtension.code, 'extension');

  const upperExtension = validateFile(file({ envelope: { fileName: 'SCENARIO.ARROW' } }));
  assert.equal(upperExtension.ok, true, '.arrow는 대소문자를 가리지 않는다');

  const tooBig = validateFile(file({ envelope: { byteLength: MAX_FILE_BYTES + 1 } }));
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.code, 'size');

  const exactLimit = validateFile(file({ envelope: { byteLength: MAX_FILE_BYTES } }));
  assert.equal(exactLimit.ok, true, '200MB 경계는 허용한다');

  const badHead = validateFile(file({ envelope: { magicHead: 'ARROW0' } }));
  assert.equal(badHead.ok, false);
  assert.equal(badHead.code, 'magic');

  const badTail = validateFile(file({ envelope: { magicTail: '' } }));
  assert.equal(badTail.ok, false);
  assert.equal(badTail.code, 'magic');
});

// [ASVS v5.0.0-1.5.2] [ASVS v5.0.0-5.2.3]
test('FX-T2 ② 스키마 열 이름·형·순서가 다르거나 압축·사전 열·모르는 열이 있으면 거절한다', () => {
  const swapped = [...SCHEMA];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  const swappedResult = validateFile(file({ schema: swapped }));
  assert.equal(swappedResult.ok, false);
  assert.equal(swappedResult.code, 'schema-columns');

  const wrongType = SCHEMA.map((c, i) => (i === 0 ? { ...c, type: 'int64' } : c));
  const wrongTypeResult = validateFile(file({ schema: wrongType }));
  assert.equal(wrongTypeResult.ok, false);
  assert.equal(wrongTypeResult.code, 'schema-columns');

  const unknown = [...SCHEMA, { name: 'ip', type: 'string' }];
  const unknownResult = validateFile(file({ schema: unknown }));
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.code, 'schema-columns');

  const compressed = SCHEMA.map((c, i) => (i === 0 ? { ...c, compressed: true } : c));
  const compressedResult = validateFile(file({ schema: compressed }));
  assert.equal(compressedResult.ok, false);
  assert.equal(compressedResult.code, 'schema-compressed');

  const dictionary = SCHEMA.map((c, i) => (i === 0 ? { ...c, dictionary: true } : c));
  const dictionaryResult = validateFile(file({ schema: dictionary }));
  assert.equal(dictionaryResult.ok, false);
  assert.equal(dictionaryResult.code, 'schema-dictionary');
});

// [ASVS v5.0.0-1.4.1] [ASVS v5.0.0-1.4.2]
test('FX-T2 ③ 행 수·시각·좌석·구역·시간창 경계를 본다', () => {
  assert.equal(validateEventCount(MAX_EVENTS).ok, true);
  const tooMany = validateEventCount(MAX_EVENTS + 1);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'event-limit');

  const mismatch = validColumns();
  mismatch.kind = new Uint8Array(mismatch.kind.length + 1);
  const mismatchResult = validateFile(file({ columns: mismatch }));
  assert.equal(mismatchResult.ok, false);
  assert.equal(mismatchResult.code, 'row-count');

  const descending = validColumns();
  descending.t_ms[2] = descending.t_ms[1] - 1;
  const descendingResult = validateFile(file({ columns: descending }));
  assert.equal(descendingResult.ok, false);
  assert.equal(descendingResult.code, 'time-order');

  const early = validColumns();
  early.t_ms[0] = -600_001;
  const earlyResult = validateFile(file({ columns: early }));
  assert.equal(earlyResult.ok, false);
  assert.equal(earlyResult.code, 'lobby');

  const late = validColumns();
  late.t_ms[late.t_ms.length - 1] = MAX_WINDOW_MS + 1;
  const lateResult = validateFile(file({ columns: late }));
  assert.equal(lateResult.ok, false);
  assert.equal(lateResult.code, 'window');

  const badSeat = validColumns();
  badSeat.seat[2] = META.seatCount;
  const badSeatResult = validateFile(file({ columns: badSeat }));
  assert.equal(badSeatResult.ok, false);
  assert.equal(badSeatResult.code, 'seat-range');

  const badSection = validColumns();
  badSection.section[2] = META.sectionCount;
  const badSectionResult = validateFile(file({ columns: badSection }));
  assert.equal(badSectionResult.ok, false);
  assert.equal(badSectionResult.code, 'section-range');

  const noSeat = validColumns();
  noSeat.seat[0] = NO_SEAT;
  assert.equal(validateFile(file({ columns: noSeat })).ok, true, '좌석 없는 사건은 좌석 범위 검사에서 뺀다');
});

// [ASVS v5.0.0-2.2.1]
test('FX-T2 ④ 원천별 칸 규칙과 연 길이 다르면 거절한다', () => {
  const syntheticMember = validColumns();
  syntheticMember.member[2] = 1;
  const syntheticMemberResult = validateFile(file({ columns: syntheticMember }));
  assert.equal(syntheticMemberResult.ok, false);
  assert.equal(syntheticMemberResult.code, 'source-rule');

  const syntheticPost = validColumns();
  syntheticPost.post_seat[2] = 1;
  assert.equal(validateFile(file({ columns: syntheticPost })).code, 'source-rule');

  const research = validColumns();
  for (let i = 0; i < research.t_ms.length; i += 1) {
    research.entropy[i] = Number.NaN;
    research.net_type[i] = 0;
    research.asn[i] = 0;
    research.device_group[i] = 0;
    research.member[i] = 0;
    research.post_seat[i] = 0;
    research.bot_tier[i] = 1;
  }
  assert.equal(validateFile(file({ meta: { source: 'RESEARCH', eventId: 'evt-lumen-2026-r1' }, columns: research })).ok, true);

  const researchEntropy = columnsFromRows(rows());
  for (let i = 0; i < researchEntropy.entropy.length; i += 1) researchEntropy.entropy[i] = Number.NaN;
  researchEntropy.entropy[2] = 1.2;
  const researchEntropyResult = validateFile(file({ meta: { source: 'RESEARCH', eventId: 'evt-lumen-2026-r1' }, columns: researchEntropy }));
  assert.equal(researchEntropyResult.ok, false);
  assert.equal(researchEntropyResult.code, 'source-rule');

  const investigation = columnsFromRows(rows());
  for (let i = 0; i < investigation.t_ms.length; i += 1) {
    investigation.bot_tier[i] = 0;
    investigation.member[i] = 0;
    investigation.post_seat[i] = 0;
    investigation.entropy[i] = Number.NaN;
    investigation.net_type[i] = 0;
    investigation.asn[i] = 0;
    investigation.device_group[i] = 0;
  }
  const invMeta = { source: 'INVESTIGATION', eventId: 'evt-lumen-2026-r1', caseId: 'CASE-2610-0007', snapshotVersion: '1' };
  assert.equal(validateFile(file({ meta: invMeta, columns: investigation })).ok, true);

  const investigationMember = columnsFromRows(rows());
  for (let i = 0; i < investigationMember.t_ms.length; i += 1) {
    investigationMember.bot_tier[i] = 0;
    investigationMember.member[i] = 0;
    investigationMember.post_seat[i] = 0;
    investigationMember.entropy[i] = Number.NaN;
    investigationMember.net_type[i] = 0;
    investigationMember.asn[i] = 0;
    investigationMember.device_group[i] = 0;
  }
  investigationMember.member[2] = 1;
  investigationMember.entropy[2] = 1.4;
  assert.equal(validateFile(file({ meta: invMeta, columns: investigationMember })).ok, true);

  const investigationNoMemberValues = columnsFromRows(rows());
  for (let i = 0; i < investigationNoMemberValues.t_ms.length; i += 1) {
    investigationNoMemberValues.bot_tier[i] = 0;
    investigationNoMemberValues.member[i] = 0;
    investigationNoMemberValues.post_seat[i] = 0;
    investigationNoMemberValues.entropy[i] = Number.NaN;
    investigationNoMemberValues.net_type[i] = 0;
    investigationNoMemberValues.asn[i] = 0;
    investigationNoMemberValues.device_group[i] = 0;
  }
  investigationNoMemberValues.net_type[2] = 1;
  const investigationNoMemberResult = validateFile(file({ meta: invMeta, columns: investigationNoMemberValues }));
  assert.equal(investigationNoMemberResult.ok, false);
  assert.equal(investigationNoMemberResult.code, 'source-rule');

  const mismatch = validateFile(file({ openedSource: 'RESEARCH' }));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'source-mismatch');
});

test('FX-T2 ⑤ 일관성 위반 사건만 버리고 수와 코드를 돌려준다', () => {
  const orphanHoldEnd = columnsFromRows([
    { t_ms: 100, kind: EVENT_KIND.HOLD_END, seat: 5, section: 0, session: 1 },
    { t_ms: 200, kind: EVENT_KIND.QUEUE_ENTER, session: 1 },
  ]);
  const holdEndResult = validateFile(file({ columns: orphanHoldEnd }));
  assert.equal(holdEndResult.ok, true);
  assert.equal(holdEndResult.rowCount, 2);
  assert.equal(holdEndResult.kept, 1);
  assert.equal(holdEndResult.dropped, 1);
  assert.equal(holdEndResult.droppedBy[0].code, 'HOLD_END_WITHOUT_HOLD');
  assert.equal(holdEndResult.keep[0], 0);
  assert.equal(holdEndResult.keep[1], 1);
  assert.equal(compactColumns(orphanHoldEnd, holdEndResult.keep).t_ms.length, 1);

  const orphanSale = columnsFromRows([
    { t_ms: 100, kind: EVENT_KIND.SALE, seat: 5, section: 0, session: 1, result: RESULT.PAID },
    { t_ms: 200, kind: EVENT_KIND.QUEUE_ENTER, session: 1 },
  ]);
  const saleResult = validateFile(file({ columns: orphanSale }));
  assert.equal(saleResult.ok, true);
  assert.equal(saleResult.kept, 1);
  assert.equal(saleResult.dropped, 1);
  assert.equal(saleResult.droppedBy[0].code, 'SALE_WITHOUT_PAY');
});

test('FX-T2 ⑥ 메타데이터의 좌석 수·구역 수·시간창·원천별 필수 값과 일치한다', () => {
  for (const seatCount of [MIN_SEATS - 1, 100_001]) {
    const result = validateFile(file({ meta: { seatCount } }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'meta');
  }
  assert.equal(validateFile(file({ meta: { seatCount: MIN_SEATS } })).ok, true);
  assert.equal(validateFile(file({ meta: { seatCount: 100_000 } })).ok, true);

  assert.equal(validateFile(file({ meta: { sectionCount: 0 } })).code, 'meta');
  assert.equal(validateFile(file({ meta: { windowToMs: MAX_WINDOW_MS + 1 } })).code, 'meta');
  assert.equal(validateFile(file({ meta: { saleStart: 'not-a-date' } })).code, 'meta');
  assert.equal(validateFile(file({ meta: { seed: undefined, generatorVersion: undefined } })).code, 'meta');

  const researchWithoutEvent = validateFile(file({ meta: { source: 'RESEARCH' } }));
  assert.equal(researchWithoutEvent.code, 'meta');

  const investigationWithoutCase = validateFile(file({ meta: { source: 'INVESTIGATION', eventId: 'evt-1' } }));
  assert.equal(investigationWithoutCase.code, 'meta');
});

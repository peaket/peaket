// F-01-8 법정 접속기록의 5분 칸 대조·일 해시 앵커·Object Lock 머리 계산 시험.
// 정본 값은 docs/observability.md §7 '법정 사본은 잃지 않는 갈래' ④·⑤와 docs/infra.md §6 'ClickHouse 접속기록 DB',
// docs/verification.md V-T21~V-T23에서 읽어 시험에 적는다(코드 상수를 가져오지 않는다).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayAnchor, objectLockHeaders, retentionUntil, seqGaps, shortfallAlarm, shortfallRatio, windowOf } from './access-log-reconcile.mjs';

const KST = 9 * 60 * 60 * 1000;
const at = (h, m) => Date.parse(`2026-11-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);

test('V-T21 5분 칸은 15분 전의 5분 경계로 내리고 경계 밖은 다음 칸으로 넘어간다', () => {
  // 12:07 KST → 5분 경계 12:05, 15분 전 11:50, 끝 11:55
  const a = windowOf(at(12, 7));
  assert.equal(new Date(a.startMs + KST).toISOString().slice(11, 16), '11:50');
  assert.equal(new Date(a.endMs + KST).toISOString().slice(11, 16), '11:55');
  // 12:10 KST → 12:10, 15분 전 11:55, 끝 12:00
  const b = windowOf(at(12, 10));
  assert.equal(new Date(b.startMs + KST).toISOString().slice(11, 16), '11:55');
  assert.equal(new Date(b.endMs + KST).toISOString().slice(11, 16), '12:00');
  // 5분 경계에 딱 맞으면 그 칸을 쓴다(현재 칸의 15분 전)
  const c = windowOf(at(12, 5));
  assert.equal(new Date(c.startMs + KST).toISOString().slice(11, 16), '11:50');
  assert.equal(new Date(c.endMs + KST).toISOString().slice(11, 16), '11:55');
  assert.equal(c.endMs - c.startMs, 5 * 60 * 1000);
  // 인자로 다른 칸을 고를 수 있다(2분 전의 1분 칸)
  const d = windowOf(at(12, 7), { offsetMinutes: 2, sizeMinutes: 1 });
  assert.equal(new Date(d.startMs + KST).toISOString().slice(11, 16), '12:05');
  assert.equal(new Date(d.endMs + KST).toISOString().slice(11, 16), '12:06');
});

test('V-T21 모자란 비율은 0.1%를 넘을 때만 참이고 경계값은 참이 아니다', () => {
  assert.equal(shortfallRatio(10_000, 9_990), 0.001); // 경계: 0.1%
  assert.equal(shortfallRatio(10_000, 9_989), 0.0011);
  assert.equal(shortfallRatio(10_000, 10_000), 0);
  assert.equal(shortfallRatio(10_000, 10_010), 0); // 적재가 더 많으면 모자람 0
  assert.equal(shortfallAlarm(0.001, 0.001), false); // 넘어야 울린다
  assert.equal(shortfallAlarm(0.0011, 0.001), true);
  assert.equal(shortfallAlarm(1, 0.001), true);
  assert.equal(shortfallAlarm(0, 0.001), false);
  // 원천이 없으면 '확인할 수 없음'이고 통과로 쓰지 않는다
  assert.equal(shortfallRatio(0, 0), null);
  assert.throws(() => shortfallAlarm(null, 0.001));
  // 잘못된 입력을 0으로 바꾸지 않는다
  assert.throws(() => shortfallRatio(-1, 0));
  assert.throws(() => shortfallRatio(Number.NaN, 1));
  assert.throws(() => shortfallRatio(10, -1));
});

test('V-T22 빈 일련번호와 중복을 세고 빈 값도 빠진 번호로 센다', () => {
  assert.deepEqual(seqGaps([1, 2, 4, 4, 7]), { missing: [3, 5, 6], duplicates: [4] });
  assert.deepEqual(seqGaps([1, 2, 3]), { missing: [], duplicates: [] });
  // 빈 값은 그 자리의 번호가 빠진 것이다(맨 끝 빈 값도 센다)
  assert.deepEqual(seqGaps([1, null, 3]), { missing: [2], duplicates: [] });
  assert.deepEqual(seqGaps([1, 2, 3, null]), { missing: [4], duplicates: [] });
  assert.deepEqual(seqGaps([null, 1, 2]), { missing: [3], duplicates: [] });
  // 1부터 시작하지 않는 값도 빠진 번호를 센다
  assert.deepEqual(seqGaps([2, 3]), { missing: [1], duplicates: [] });
  assert.deepEqual(seqGaps([]), { missing: [], duplicates: [] });
  // 0·음수·소수는 일련번호가 아니다
  assert.throws(() => seqGaps([1, 0]));
  assert.throws(() => seqGaps([1, -2]));
  assert.throws(() => seqGaps([1.5]));
});

test('V-T21·V-T23 하루 앵커는 적재 수·파일 행 수·SHA-256이 모두 맞을 때만 참이다', () => {
  const base = {
    date: '2026-11-23',
    sourceTotal: 100_000,
    ingestedTotal: 100_000,
    seqs: [1, 2, 3, 4, 5],
    fileSha256: 'a'.repeat(64),
    fileRows: 100_000,
  };
  const ok = dayAnchor(base);
  assert.equal(ok.matches, true);
  assert.equal(ok.shortfall, 0);
  assert.deepEqual(ok.seqMissing, []);
  assert.deepEqual(ok.seqDuplicates, []);
  assert.equal(ok.fileSha256, base.fileSha256);
  assert.equal(ok.fileRows, 100_000);

  // 행 수가 모자라면 앵커가 맞지 않는다
  assert.equal(dayAnchor({ ...base, ingestedTotal: 99_999 }).matches, false);
  // 파일 행 수가 적재 수와 다르면 앵커가 맞지 않는다
  assert.equal(dayAnchor({ ...base, fileRows: 99_999 }).matches, false);
  // 빈 일련번호가 있으면 앵커가 맞지 않는다
  assert.equal(dayAnchor({ ...base, seqs: [1, null, 3] }).matches, false);
  // SHA-256 모양이 틀리면 던진다(빈 값을 통과로 쓰지 않는다)
  assert.throws(() => dayAnchor({ ...base, fileSha256: '' }));
  assert.throws(() => dayAnchor({ ...base, fileSha256: 'a'.repeat(63) }));
  // 원천이 0이면 확인 불가로 던지지 않고 null을 남기되 matches는 거짓이다
  const none = dayAnchor({ ...base, sourceTotal: 0, ingestedTotal: 0, fileRows: 0 });
  assert.equal(none.shortfall, null);
  assert.equal(none.matches, false);
});

test('V-T23 사본 보존은 그 날짜의 3개월 뒤 7일이고 Object Lock 준수 모드 머리를 낸다', () => {
  assert.equal(retentionUntil('2026-11-24', 3, 7), '2027-03-03T00:00:00.000Z');
  assert.equal(retentionUntil('2026-01-31', 1, 0), '2026-02-28T00:00:00.000Z'); // 월말을 넘긴다
  assert.equal(retentionUntil('2024-02-29', 12, 1), '2025-03-01T00:00:00.000Z'); // 윤년
  assert.throws(() => retentionUntil('2026-13-01', 3, 7));
  assert.throws(() => retentionUntil('2026-11-24', 0, 7));
  assert.throws(() => retentionUntil('2026-11-24', 3, -1));

  const until = retentionUntil('2026-11-24', 3, 7);
  assert.deepEqual(objectLockHeaders({ mode: 'COMPLIANCE', retainUntil: until }), {
    'x-amz-object-lock-mode': 'COMPLIANCE',
    'x-amz-object-lock-retain-until-date': until,
  });
  assert.deepEqual(objectLockHeaders({ mode: 'GOVERNANCE', retainUntil: until }), {
    'x-amz-object-lock-mode': 'GOVERNANCE',
    'x-amz-object-lock-retain-until-date': until,
  });
  // 보존이 지난 시각·모르는 모드는 거부한다
  assert.throws(() => objectLockHeaders({ mode: 'COMPLIANCE', retainUntil: '2020-01-01T00:00:00.000Z' }));
  assert.throws(() => objectLockHeaders({ mode: 'NONE', retainUntil: until }));
});

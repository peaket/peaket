// 공연 이미지·좌석맵 가져오기의 도메인 규칙(공개 순수 함수, ADR-0257 결정 2·3·5·8, BUILD_ORDER HOT-190·HOT-210).
// HTTP·DB·gRPC를 거친 끝까지의 동작은 test-int/production-image.int.test.ts·seatmap-import.int.test.ts가 본다.
import { describe, expect, test } from 'vitest';
import { agreedFormat, altValid, derivativeKeysMatch, derivativeNames, reorderDetails, sniffFormat, specViolation, stagingKey } from '../src/modules/catalog/domain/production-image.js';
import { type CheckedLayout, fillSeatIds, isCompressed, recheckLayout, tooMany } from '../src/modules/catalog/domain/seatmap-import.js';
import { forbiddenCredentialNames } from '../src/seatmap-worker/credentials.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const GIF = new TextEncoder().encode('GIF89a......');

describe('공연 이미지 규칙', () => {
  test('파일 앞부분·Content-Type·확장자가 모두 같은 형식일 때만 받는다(GIF·SVG·위장 거절) [ASVS v5.0.0-5.2.2]', () => {
    expect([sniffFormat(JPEG), sniffFormat(PNG), sniffFormat(WEBP), sniffFormat(GIF), sniffFormat(new Uint8Array([0xff, 0xd8]))]).toEqual(['jpeg', 'png', 'webp', undefined, undefined]);
    expect(agreedFormat(JPEG, 'image/jpeg', 'poster.JPG')).toBe('jpeg');
    expect(agreedFormat(JPEG, 'image/jpeg', 'poster.jpeg')).toBe('jpeg');
    expect(agreedFormat(PNG, 'image/png; charset=binary', 'a.png')).toBe('png');
    expect(agreedFormat(WEBP, 'image/webp', 'a.webp')).toBe('webp');
    // 셋 가운데 하나라도 다르면 받지 않는다
    expect(agreedFormat(PNG, 'image/jpeg', 'a.jpg')).toBeUndefined();
    expect(agreedFormat(JPEG, 'image/png', 'a.jpg')).toBeUndefined();
    expect(agreedFormat(JPEG, 'image/jpeg', 'a.png')).toBeUndefined();
    expect(agreedFormat(JPEG, 'image/jpeg', 'noext')).toBeUndefined();
    expect(agreedFormat(GIF, 'image/gif', 'a.gif')).toBeUndefined();
    expect(agreedFormat(new TextEncoder().encode('<svg/>'), 'image/svg+xml', 'a.svg')).toBeUndefined();
    // RIFF 상자라도 8번째 바이트부터 WEBP가 아니면(AVI 등) WebP가 아니다
    const AVI = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20, 0x4c, 0x49]);
    expect(sniffFormat(AVI)).toBeUndefined();
    expect(agreedFormat(AVI, 'image/webp', 'a.webp')).toBeUndefined();
  });

  test('처리 결과의 폭·높이 다시 검사: 포스터 800×1,000 정확히는 받고 799·999·세로=가로는 POSTER_SPEC이다 [ASVS v5.0.0-2.1.2] [ASVS v5.0.0-2.2.3]', () => {
    expect(specViolation('POSTER', 800, 1000)).toBeUndefined();
    expect(specViolation('POSTER', 799, 1000)).toBe('POSTER_SPEC');
    expect(specViolation('POSTER', 800, 999)).toBe('POSTER_SPEC');
    expect(specViolation('POSTER', 1200, 1200)).toBe('POSTER_SPEC');
    expect(specViolation('POSTER', 1200, 1201)).toBeUndefined();
    expect(specViolation('DETAIL', 800, 1)).toBeUndefined();
    expect(specViolation('DETAIL', 799, 5000)).toBe('DETAIL_SPEC');
  });

  test('화소 상한: 긴 변 20,000은 받고 20,001은, 4,000만 화소는 받고 하나 넘으면 PIXEL_LIMIT이다. 0·음수·소수·너무 큰 값도 막는다 [ASVS v5.0.0-1.4.2]', () => {
    expect(specViolation('DETAIL', 20_000, 2_000)).toBeUndefined();
    expect(specViolation('DETAIL', 20_001, 1_000)).toBe('PIXEL_LIMIT');
    expect(specViolation('POSTER', 1_000, 20_001)).toBe('PIXEL_LIMIT');
    expect(specViolation('DETAIL', 8_000, 5_000)).toBeUndefined();
    expect(specViolation('DETAIL', 5_000, 8_001)).toBe('PIXEL_LIMIT');
    expect(specViolation('DETAIL', 4_000_001, 10)).toBe('PIXEL_LIMIT');
    for (const [w, h] of [
      [0, 1000],
      [1000, 0],
      [-800, 1000],
      [800.5, 1000],
      [Number.MAX_SAFE_INTEGER + 2, 1],
      [Number.NaN, 1000],
    ] as const)
      expect(specViolation('DETAIL', w, h)).toBe('PIXEL_LIMIT');
  });

  test('파생본 키는 그 이미지 준비 위치의 여덟 개와 정확히 같아야 한다(모자람·남음·겹침·접두사 밖 거절) [ASVS v5.0.0-5.3.2]', () => {
    const id = '0190f3a1-7c2e-7a00-8000-000000000001';
    const keys = derivativeNames().map((n) => stagingKey(id, n));
    expect(keys).toEqual([320, 640, 960, 1280].flatMap((w) => [`staging/production/${id}/${w}.avif`, `staging/production/${id}/${w}.webp`]));
    expect(derivativeKeysMatch(id, keys)).toBe(true);
    expect(derivativeKeysMatch(id, [...keys].reverse())).toBe(true);
    expect(derivativeKeysMatch(id, keys.slice(1))).toBe(false);
    expect(derivativeKeysMatch(id, [...keys, `staging/production/${id}/2560.webp`])).toBe(false);
    expect(derivativeKeysMatch(id, [...keys.slice(1), keys[2]!])).toBe(false);
    expect(derivativeKeysMatch(id, keys.map((k) => k.replace(id, '0190f3a1-7c2e-7a00-8000-000000000002')))).toBe(false);
    expect(derivativeKeysMatch(id, [...keys.slice(1), `production/${id}/320.avif`])).toBe(false);
  });

  test('대체 텍스트는 1~300자(코드 포인트)이고 NUL·짝 잃은 서로게이트는 받지 않는다', () => {
    expect(altValid('가'.repeat(300))).toBe(true);
    expect(altValid('가'.repeat(301))).toBe(false);
    expect(altValid('😀'.repeat(300))).toBe(true);
    expect(altValid('')).toBe(false);
    expect(altValid('a\u0000b')).toBe(false);
    expect(altValid('a\ud800b')).toBe(false);
  });

  test('상세 이미지 순서: 옮기면 사이를 한 칸씩 밀고, 지우면 0부터 빈틈 없이 다시 매긴다 [ASVS v5.0.0-1.4.2]', () => {
    const d = [
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
      { id: 'c', order: 2 },
      { id: 'd', order: 3 },
    ];
    expect(reorderDetails(d, 'd', 1)).toEqual([
      { id: 'a', order: 0 },
      { id: 'd', order: 1 },
      { id: 'b', order: 2 },
      { id: 'c', order: 3 },
    ]);
    expect(reorderDetails(d, 'a', 9)).toEqual([
      { id: 'b', order: 0 },
      { id: 'c', order: 1 },
      { id: 'd', order: 2 },
      { id: 'a', order: 3 },
    ]);
    expect(reorderDetails(d.filter((x) => x.id !== 'b'))).toEqual([
      { id: 'a', order: 0 },
      { id: 'c', order: 1 },
      { id: 'd', order: 2 },
    ]);
  });
});

const layout = (o: Partial<CheckedLayout> = {}): CheckedLayout => ({
  canvas: { width: 100, height: 100 },
  sections: [{ sectionId: '1', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [100, 0], [100, 100]] }, seats: [{ seatId: '1-1-1', row: '1', number: 1, x: 10, y: 10 }] }],
  ...o,
});
const seats = (n: number) => Array.from({ length: n }, (_, i) => ({ seatId: `s${i}`, row: '1', number: i, x: 1, y: 1 }));

describe('좌석맵 가져오기 다시 보기', () => {
  test('개수 상한: 좌석 50,000·구역 500·꼭짓점 1,000은 넘지 않고 하나씩 더하면 넘는다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-15.2.2]', () => {
    const sec = (n: number) => ({ sectionId: '1', name: 'A', shape: { kind: 'POLYGON' as const, points: [[0, 0], [1, 0], [1, 1]] as [number, number][] }, seats: seats(n) });
    expect(tooMany(layout({ sections: [sec(25_000), { ...sec(25_000), sectionId: '2', name: 'B' }] }))).toBeUndefined();
    expect(tooMany(layout({ sections: [sec(25_000), { ...sec(25_001), sectionId: '2', name: 'B' }] }))).toBe('TOO_MANY_SEATS');
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...sec(0), sectionId: String(i), name: `S${i}` }));
    expect(tooMany(layout({ sections: many(500) }))).toBeUndefined();
    expect(tooMany(layout({ sections: many(501) }))).toBe('TOO_MANY_SECTIONS');
    const pts = (n: number) => Array.from({ length: n }, (_, i) => [i % 100, i % 2] as [number, number]);
    expect(tooMany(layout({ stage: [{ kind: 'POLYGON', points: pts(1000) }] }))).toBeUndefined();
    expect(tooMany(layout({ stage: [{ kind: 'POLYGON', points: pts(1001) }] }))).toBe('TOO_MANY_POINTS');
    expect(tooMany(layout({ sections: [{ ...sec(0), shape: { kind: 'POLYGON', points: pts(1001) } }] }))).toBe('TOO_MANY_POINTS');
  });

  test('모든 좌표가 캔버스 안이어야 하고(경계는 안), 캔버스는 1~100,000이다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-1.4.2]', () => {
    expect(recheckLayout(layout())).toEqual([]);
    expect(recheckLayout(layout({ sections: [{ sectionId: '1', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [100, 0], [100, 100]] }, seats: [{ seatId: 'x', row: '1', number: 1, x: 100, y: 100 }] }] }))).toEqual([]);
    expect(
      recheckLayout(
        layout({
          stage: [{ kind: 'RECT', points: [[0, 0], [101, 0], [0, 1]] }],
          sections: [{ sectionId: '1', name: 'A', shape: { kind: 'POLYGON', points: [[-1, 0], [100, 0], [100, 100]] }, label: { x: 50, y: 101 }, seats: [{ seatId: 'x', row: '1', number: 1, x: 10, y: -1 }] }],
        }),
      ),
    ).toEqual([
      { line: 0, field: 'stage[0]', code: 'OUT_OF_CANVAS' },
      { line: 0, field: 'sections[0].shape', code: 'OUT_OF_CANVAS' },
      { line: 0, field: 'sections[0].label', code: 'OUT_OF_CANVAS' },
      { line: 0, field: 'sections[0].seats[0]', code: 'OUT_OF_CANVAS' },
    ]);
    expect(recheckLayout(layout({ canvas: { width: 100_000, height: 100_000 } }))).toEqual([]);
    expect(recheckLayout(layout({ canvas: { width: 100_001, height: 100 } }))).toEqual([{ line: 0, field: 'canvas', code: 'CANVAS_INVALID' }]);
    expect(recheckLayout(layout({ canvas: { width: 0, height: 100 } }))).toEqual([{ line: 0, field: 'canvas', code: 'CANVAS_INVALID' }]);
  });

  test('같은 구역(구역 ID)·열·번호와 같은 좌석 ID는 겹침 오류이고 이름이 같은 구역은 받는다 [ASVS v5.0.0-2.2.1]', () => {
    const r = recheckLayout(
      layout({
        sections: [
          { sectionId: '1', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [1, 0], [1, 1]] }, seats: [{ seatId: 'a', row: '1', number: 1, x: 1, y: 1 }, { seatId: 'b', row: '1', number: 1, x: 2, y: 1 }, { seatId: 'a', row: '1', number: 2, x: 3, y: 1 }] },
          { sectionId: '2', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [1, 0], [1, 1]] }, seats: [{ seatId: 'c', row: '1', number: 3, x: 1, y: 1 }] },
          { sectionId: '3', name: 'B', shape: { kind: 'POLYGON', points: [[0, 0], [1, 0], [1, 1]] }, seats: [{ seatId: 'd', row: '1', number: 1, x: 1, y: 1 }] },
        ],
      }),
    );
    expect(r).toEqual([
      { line: 0, field: 'sections[0].seats[1]', code: 'DUPLICATE_SEAT' },
      { line: 0, field: 'sections[0].seats[2].seatId', code: 'DUPLICATE_SEAT_ID' },
    ]);
  });

  test('좌석 ID가 없는 좌석은 {구역 순번}-{열}-{번호}로 채우고, 있는 ID와 받은 값은 그대로 둔다', () => {
    const raw = { canvas: { width: 1, height: 1 }, sections: [{ name: 'A', seats: [{ row: 'A', number: 3 }] }, { name: 'B', seats: [{ seatId: 'keep', row: '1', number: 1 }, { row: '2', number: 9 }] }] };
    expect(fillSeatIds(raw)).toEqual({ canvas: { width: 1, height: 1 }, sections: [{ name: 'A', seats: [{ seatId: '1-A-3', row: 'A', number: 3 }] }, { name: 'B', seats: [{ seatId: 'keep', row: '1', number: 1 }, { seatId: '2-2-9', row: '2', number: 9 }] }] });
    expect(raw.sections[0]!.seats[0]).toEqual({ row: 'A', number: 3 });
    expect(fillSeatIds('x')).toBe('x');
  });

  test('압축 파일(gzip·zip)의 앞부분을 알아본다 [ASVS v5.0.0-5.1.1]', () => {
    expect(isCompressed(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe(true);
    expect(isCompressed(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(isCompressed(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
    expect(isCompressed(new TextEncoder().encode('<svg'))).toBe(false);
    expect(isCompressed(new Uint8Array([0x1f]))).toBe(false);
  });
});

describe('seatmap-worker 자격 증명 거절', () => {
  test('DB·Kafka·Redis·AWS 자격 증명 이름이 하나라도 있으면(빈 값도) 그 이름을 돌려주고 값은 싣지 않는다 [ASVS v5.0.0-15.2.5]', () => {
    expect(forbiddenCredentialNames({ PEAKET_GRPC_PORT: '1', PATH: '/bin', PEAKET_SEATMAP_HEAP_MB: '64' })).toEqual([]);
    expect(
      forbiddenCredentialNames({
        PEAKET_DATABASE_URL: 'postgres://u:secret@h/db',
        PEAKET_PARTNER_DATABASE_URL: '',
        PEAKET_KAFKA_BROKERS: 'b:9092',
        PEAKET_REDIS_SEAT_URL: 'redis://h',
        AWS_ACCESS_KEY_ID: 'AKIA',
        AWS_REGION: 'ap-northeast-2',
        PEAKET_GRPC_PORT: '50051',
      }),
    ).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_REGION', 'PEAKET_DATABASE_URL', 'PEAKET_KAFKA_BROKERS', 'PEAKET_PARTNER_DATABASE_URL', 'PEAKET_REDIS_SEAT_URL']);
    expect(forbiddenCredentialNames({ AWS_PROFILE: undefined })).toEqual([]);
  });
});

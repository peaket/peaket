// 좌석맵 가져오기 해석기·작업 설정의 리뷰 재현 시험(BAT-145 리뷰 2차, ADR-0257 결정 5~8). 해석기 공개 함수와 작업의 순수 함수만 부른다.
import { describe, expect, test } from 'vitest';
import { forbiddenCredentialNames } from '../src/seatmap-worker/credentials.js';
import { parseSeatmapFile, toReply } from '../src/seatmap-worker/parse.js';

const enc = (s: string) => new TextEncoder().encode(s);
const svg = (body: string, attrs = 'viewBox="0 0 1000 1000"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>\n${body}\n</svg>`;
const parse = (text: string, format: 'SVG' | 'JSON' | 'CSV') => parseSeatmapFile(enc(text), format);
const HEADER = 'section,row,number,x,y,tier,wheelchair,gate,shape';
const ms = (fn: () => void) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('자격 증명 금지 이름(넓은 꼴)', () => {
  test('저장소가 실제로 쓰는 자격 증명 이름이 모두 걸리고 작업이 쓰는 이름은 통과한다 [ASVS v5.0.0-15.2.5]', () => {
    const real = [
      'PEAKET_SEAT_REDIS_URL',
      'PEAKET_QUEUE_REDIS_URL',
      'PEAKET_SEAT_REDIS_CLUSTER_URLS',
      'PEAKET_QUEUE_REDIS_CLUSTER_URLS',
      'PEAKET_OUTBOX_DATABASE_URL',
      'PEAKET_MAINTENANCE_DATABASE_URL',
      'PEAKET_V0_DATABASE_URL',
      'PEAKET_DATABASE_URL',
      'PEAKET_PARTNER_DATABASE_URL',
      'PEAKET_TELEMETRY_KAFKA_BROKERS',
      'PEAKET_PG_TOSS_SECRET_KEY',
      'PEAKET_FAN_TOKEN_KEY',
      'PEAKET_PID_HMAC_KEY',
      'PEAKET_LOG_PSEUDONYM_KEY',
      'PEAKET_PASSWORD_PEPPER',
      'PGPASSWORD',
      'pghost',
      'AWS_ACCESS_KEY_ID',
      'aws_secret_access_key',
    ];
    const env = Object.fromEntries(real.map((k) => [k, 'x']));
    expect(forbiddenCredentialNames(env)).toEqual([...real].sort());
    const allowed = ['PEAKET_GRPC_PORT', 'PEAKET_GRPC_HOST', 'PEAKET_SEATMAP_PARSE_TIMEOUT_MS', 'PEAKET_SEATMAP_HEAP_MB', 'PEAKET_ENV', 'PEAKET_LOG_LEVEL', 'PEAKET_VERSION', 'PEAKET_POD', 'OTEL_SERVICE_NAME', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'NODE_OPTIONS', 'PATH', 'HOME', 'TEMP'];
    expect(forbiddenCredentialNames(Object.fromEntries(allowed.map((k) => [k, 'x'])))).toEqual([]);
  });
});

describe('되돌기가 커지지 않는 숫자·경로 읽기', () => {
  test('숫자 4만 자 뒤 x와 공백 4만 자 뒤 !가 든 SVG를 50ms 안에 거절한다(칸 64자·d 64KB 상한) [ASVS v5.0.0-15.2.2]', () => {
    const digits = svg(`<rect data-section="A" x="${'1'.repeat(40_000)}x" y="0" width="10" height="10"/>`);
    let r = parseSeatmapFile(enc(digits), 'SVG');
    expect(ms(() => (r = parseSeatmapFile(enc(digits), 'SVG')))).toBeLessThan(50);
    expect(r.status === 'PARSED' && r.errors.map((e) => e.code)).toEqual(['SHAPE_INVALID', 'NO_SECTIONS']);
    const spaces = svg(`<path data-section="A" d="M0 0${' '.repeat(40_000)}!"/>`);
    expect(ms(() => (r = parseSeatmapFile(enc(spaces), 'SVG')))).toBeLessThan(50);
    expect(r.status === 'PARSED' && r.errors[0]?.code).toBe('SHAPE_INVALID');
    const longD = svg(`<path data-section="A" d="M0 0 ${'L1 1 '.repeat(14_000)}Z"/>`);
    expect(parse(longD, 'SVG')).toMatchObject({ status: 'PARSED', errors: [{ field: 'd', code: 'SHAPE_INVALID' }, { code: 'NO_SECTIONS' }] });
    const points = svg(`<polygon data-section="A" points="0,0 10,0 ${'9'.repeat(65)},10"/>`);
    expect(parse(points, 'SVG')).toMatchObject({ status: 'PARSED', errors: [{ code: 'SHAPE_INVALID' }, { code: 'NO_SECTIONS' }] });
    // 칸 하나 64자: 앞을 0으로 채워 값은 1인 숫자도 65자면 받지 않고 64자는 받는다(값 상한과 따로 본다)
    const padded = (n: number) => svg(`<polygon data-section="A" points="0,0 10,0 ${'0'.repeat(n - 1)}1,10"/>`);
    expect(parse(padded(65), 'SVG')).toMatchObject({ status: 'PARSED', errors: [{ code: 'SHAPE_INVALID' }, { code: 'NO_SECTIONS' }] });
    expect(parse(padded(64), 'SVG')).toMatchObject({ status: 'PARSED', errors: [] });
  });
});

describe('응답 크기·글자 칸·무대 상한', () => {
  test('해석한 배치 JSON이 상한(8MiB − 봉투 64KB)을 넘으면 보내지 않고 REJECTED LAYOUT_TOO_LARGE다 [ASVS v5.0.0-15.2.2]', () => {
    const r = parse(svg('<polygon data-section="A" points="0,0 10,0 10,10"/>'), 'SVG');
    const json = r.status === 'PARSED' ? JSON.stringify(r.layout) : '';
    expect(toReply(r, Buffer.byteLength(json))).toMatchObject({ status: 'PARSED', layoutJson: json });
    expect(toReply(r, Buffer.byteLength(json) - 1)).toEqual({ status: 'REJECTED', errors: [{ line: 0, field: 'layout', code: 'LAYOUT_TOO_LARGE' }], ignored: [] });
    expect(toReply(r).status).toBe('PARSED');
  });

  test('JSON의 모든 글자 칸에서 제어 문자를 지우고 구역·좌석 ID 64자, 층·등급·게이트 30자를 넘으면 행 오류다 [ASVS v5.0.0-1.1.1] [ASVS v5.0.0-2.2.1]', () => {
    const doc = (o: { sectionId?: string; level?: string; seatId?: string; tierId?: string; gateZone?: string }) =>
      JSON.stringify({
        canvas: { width: 10, height: 10 },
        stage: [{ kind: 'RECT', points: [[0, 0], [1, 0], [1, 1]], name: '무\u202e대' }],
        sections: [{ sectionId: o.sectionId ?? 'S\u0007-1', name: 'A', level: o.level ?? '1\u200f층', shape: { kind: 'RECT', points: [[0, 0], [5, 0], [5, 5]] }, seats: [{ seatId: 'a\u2066-1', row: '1', number: 1, x: 1, y: 1, tierId: o.tierId ?? 'R\u0000', gateZone: o.gateZone ?? '동\u202a문' }, { seatId: o.seatId ?? 'b-1', row: '1', number: 2, x: 2, y: 1 }] }],
      });
    const ok = parse(doc({}), 'JSON');
    expect(ok).toMatchObject({ status: 'PARSED', errors: [] });
    expect(ok.status === 'PARSED' && ok.layout).toMatchObject({ stage: [{ name: '무대' }], sections: [{ sectionId: 'S-1', level: '1층', seats: [{ seatId: 'a-1', tierId: 'R', gateZone: '동문' }, { seatId: 'b-1' }] }] });
    const bad = parse(doc({ sectionId: 'S'.repeat(65), level: '층'.repeat(31), seatId: 'a'.repeat(65), tierId: 'R'.repeat(31), gateZone: 'G'.repeat(31) }), 'JSON');
    expect(bad.status === 'PARSED' && bad.errors.map((e) => e.code).sort()).toEqual(['GATE_TOO_LONG', 'LEVEL_TOO_LONG', 'SEAT_ID_INVALID', 'SECTION_ID_INVALID', 'TIER_TOO_LONG']);
    expect(parse(doc({ sectionId: 'S'.repeat(64), seatId: 'a'.repeat(64), level: '층'.repeat(30) }), 'JSON')).toMatchObject({ status: 'PARSED', errors: [] });
  });

  test('무대 도형은 500개까지 읽고 501개면 해석하지 않는다', () => {
    const stage = (n: number) => Array.from({ length: n }, (_, i) => `<rect data-kind="stage" x="${i}" y="0" width="1" height="1"/>`).join('');
    const sec = '<rect data-section="A" x="0" y="0" width="5" height="5"/>';
    expect(parse(svg(sec + stage(500)), 'SVG')).toMatchObject({ status: 'PARSED', errors: [] });
    expect(parse(svg(sec + stage(501)), 'SVG')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'TOO_MANY_STAGE' }] });
  });
});

describe('글자 정규화 차례와 형식 세부', () => {
  test('S-T32 ⑧ 제어 문자를 지운 뒤 NFC로 합치므로 사이에 낀 제어 문자가 있어도 같은 구역이다 [ASVS v5.0.0-1.1.1]', () => {
    const csv = [HEADER, '"ᄀ\u200eᅡ",1,1,1,1,,,,"0 0;5 0;5 5"', '가,1,2,2,2,,,,', '"e\u0007́",1,1,3,3,,,,"0 0;6 0;6 6"', 'é,1,2,4,4,,,,'].join('\n');
    const r = parse(csv, 'CSV');
    expect(r.status === 'PARSED' && r.errors).toEqual([]);
    expect(r.status === 'PARSED' && r.layout.sections.map((s) => [s.name, s.seats.length])).toEqual([
      ['가', 2],
      ['é', 2],
    ]);
    const twoShapes = svg('<polygon data-section="ᄀ&#x200E;ᅡ" points="0,0 1,0 1,1"/><polygon data-section="가" points="0,0 2,0 2,2"/>');
    expect(parse(twoShapes, 'SVG')).toMatchObject({ status: 'PARSED', errors: [{ code: 'SECTION_DUPLICATE' }] });
  });

  test('CSV 머리는 칸 단위로 견주고(따옴표 한 칸에 넣은 머리는 형식 불일치), 닫는 따옴표 뒤 글자는 CSV_QUOTE다 [ASVS v5.0.0-5.2.2]', () => {
    expect(parse(`"${HEADER}"\nA,1,1,1,1,,,,"0 0;1 0;1 1"`, 'CSV')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'FORMAT_MISMATCH' }] });
    const r = parse([HEADER, '"A"x,1,1,1,1,,,,"0 0;1 0;1 1"'].join('\n'), 'CSV');
    expect(r.status === 'PARSED' && r.errors[0]).toEqual({ line: 2, field: 'csv', code: 'CSV_QUOTE' });
  });

  test('rect는 네 꼭짓점을 구한 뒤 반올림하고, 정한 참조 밖의 &와 홀로 &는 형식 불일치다', () => {
    const r = parse(svg('<rect data-section="A" x="0.4" y="0" width="0.4" height="10"/>'), 'SVG');
    expect(r.status === 'PARSED' && r.layout.sections[0]!.shape.points).toEqual([
      [0, 0],
      [1, 0],
      [1, 10],
      [0, 10],
    ]);
    for (const bad of ['<polygon data-section="A &amp B" points="0,0 1,0 1,1"/>', '<polygon data-section="A & B" points="0,0 1,0 1,1"/>', '<polygon data-section="&#xD800;" points="0,0 1,0 1,1"/>']) {
      expect(parse(svg(bad), 'SVG'), bad).toMatchObject({ status: 'REJECTED', errors: [{ code: 'FORMAT_MISMATCH' }] });
    }
  });

  test('안쪽 svg는 들어가지 않고 무시 목록에 svg로, 처리 명령 xml-stylesheet도 무시 목록에 남고, 무대 표시가 붙은 원은 좌석·무대가 아니다 [ASVS v5.0.0-1.3.4]', () => {
    const file = `<?xml version="1.0"?>\n<?xml-stylesheet href="https://evil.example/a.css"?>\n${svg('<svg viewBox="0 0 10 10"><polygon data-section="안" points="0,0 1,0 1,1"/></svg><polygon data-section="A" points="0,0 5,0 5,5"/><circle data-kind="stage" cx="1" cy="1" r="1"/>')}`;
    const r = parse(file, 'SVG');
    expect(r.status).toBe('PARSED');
    expect(r.status === 'PARSED' && r.ignored).toEqual(['xml-stylesheet', 'svg', 'data-kind']);
    expect(r.status === 'PARSED' && [r.layout.sections.map((s) => s.name), r.layout.stage.length]).toEqual([['A'], 0]);
    expect(JSON.stringify(r)).not.toContain('evil.example');
  });

  test('JSON은 이름이 같은 구역(층이 다른 같은 이름)을 받는다', () => {
    const sec = (id: string, level: string) => ({ sectionId: id, name: 'A', level, shape: { kind: 'RECT', points: [[0, 0], [1, 0], [1, 1]] }, seats: [{ seatId: `${id}-1`, row: '1', number: 1, x: 1, y: 1 }] });
    const r = parse(JSON.stringify({ canvas: { width: 5, height: 5 }, sections: [sec('A1', '1층'), sec('A2', '2층')] }), 'JSON');
    expect(r).toMatchObject({ status: 'PARSED', errors: [] });
    expect(r.status === 'PARSED' && r.layout.sections.map((s) => [s.sectionId, s.seats.length])).toEqual([
      ['A1', 1],
      ['A2', 1],
    ]);
  });
});

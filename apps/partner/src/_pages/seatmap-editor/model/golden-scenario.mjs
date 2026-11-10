// 시험용 골든 배치(services/core-svc/test-int/fixtures/seatmap-editor/). 화면 모델 시험과 core-svc 통합 시험이 같은 파일을 쓴다(BAT-150 계획 §3.4).
// 에디터 명령(도형 더하기·채우기·속성)으로 만든 문서이고, 무대 사각형 하나와 구역 넷(사각형·다각형·부채꼴·곡선 띠), 가격 등급 셋(차례를 바꾼 것)이다.
// 다각형 구역 이름은 '<img src=x onerror=alert(1)>'(FE-T46 ⑪). 서버가 매긴 좌석 UUID는 차례 번호('#1'…)로 바꿔 견준다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDoc } from './doc.ts';
import { fillSection } from './fill.ts';
import { arcPoints, rectPoints } from './shapes.ts';
import { addShapeCmd, createEditorStore, fillCmd, seatsCmd, tiersCmd, updateSectionCmd } from './store.ts';
import { patchSeats } from './refine.ts';

export const GOLDEN_DIR = fileURLToPath(new URL('../../../../../../services/core-svc/test-int/fixtures/seatmap-editor/', import.meta.url));
export const golden = (name) => readFileSync(join(GOLDEN_DIR, name), 'utf8');
export const goldenJson = (name) => JSON.parse(golden(name));

export const XSS_NAME = '<img src=x onerror=alert(1)>';
/** 골든 공연 ID(내보내기 파일 이름 앞 8자) */
export const GOLDEN_PRODUCTION = '0b8f1f2e-4a1d-4c1e-9b5a-000000000150';

/** 에디터 명령으로 골든 문서를 만든다(판 0, 저장 전) */
export function goldenStore() {
  const st = createEditorStore(emptyDoc(), 0, false, { idPrefix: 'gold' });
  const run = (cmd) => {
    if (!st.getState().exec(cmd)) throw new Error(`명령 거절: ${cmd?.label}`);
  };
  const doc = () => st.getState().doc;
  run(tiersCmd(doc(), [
    { tierId: 'S', name: 'S석', price: 99_000 },
    { tierId: 'R', name: 'R석', price: 150_000 },
    { tierId: 'A', name: 'A석', price: 70_000 },
  ]));
  run(addShapeCmd(doc(), 'stage', { kind: 'RECT', points: rectPoints({ x: 3000, y: 200, w: 2000, h: 600, rotation: 0 }) }, ''));
  run(addShapeCmd(doc(), 'section', { kind: 'RECT', points: rectPoints({ x: 2600, y: 1400, w: 1200, h: 700, rotation: 0 }) }, 's1'));
  run(addShapeCmd(doc(), 'section', { kind: 'POLYGON', points: [[4200, 1400], [5400, 1400], [5600, 1900], [4800, 2300], [4200, 1900]] }, 's2'));
  const sector = { cx: 1500, cy: 4500, innerRadius: 0, outerRadius: 1000, startAngle: 180, endAngle: 270 };
  run(addShapeCmd(doc(), 'section', { kind: 'SECTOR', points: arcPoints(sector), arc: sector }, 's3'));
  const band = { cx: 4000, cy: 500, innerRadius: 2500, outerRadius: 3200, startAngle: 60, endAngle: 120 };
  run(addShapeCmd(doc(), 'section', { kind: 'ARC_BAND', points: arcPoints(band), arc: band }, 's4'));
  run(updateSectionCmd(doc(), 's1', { name: 'A구역', level: '1층', tierId: 'R' }));
  run(updateSectionCmd(doc(), 's2', { name: XSS_NAME, tierId: 'S' }));
  run(updateSectionCmd(doc(), 's3', { name: 'C구역', tierId: 'A' }));
  run(updateSectionCmd(doc(), 's4', { name: 'D구역', tierId: 'A', gateZone: 'G2' }));
  const fill = (id, rule) => {
    const s = doc().sections[id];
    const r = fillSection(s.shape.points, rule, doc().stage, doc().canvas);
    run(fillCmd(doc(), id, r.seats.map((x) => ({ seatId: st.getState().newSeatId(), ...x })), rule));
  };
  fill('s1', { method: 'COUNT', targetCount: 36, aisles: 1 });
  fill('s2', { method: 'GRID', rows: 2, seatsPerRow: 5, aisles: 0 });
  fill('s3', { method: 'COUNT', targetCount: 12, aisles: 0, rowLabel: 'ALPHA' });
  fill('s4', { method: 'COUNT', targetCount: 30, rowShape: 'CURVED', aisles: 2, numberFrom: 'RIGHT' });
  const seatsOf = (id) => doc().sections[id].seats;
  run(seatsCmd(doc(), '휠체어석', patchSeats(doc(), new Set([seatsOf('s1')[0].seatId]), { wheelchair: true })));
  run(seatsCmd(doc(), '등급', patchSeats(doc(), new Set([seatsOf('s1')[1].seatId]), { tierId: 'S' })));
  run(seatsCmd(doc(), '판매 제외', patchSeats(doc(), new Set([seatsOf('s2')[1].seatId]), { unavailable: true })));
  run(seatsCmd(doc(), '게이트', patchSeats(doc(), new Set([seatsOf('s4')[0].seatId]), { gateZone: 'G3' })));
  return st;
}

/** 좌석 ID를 나온 차례로 '#1'…로 바꾼다(서버 UUID·에디터 자리표시를 같은 꼴로 견준다) */
export function normalizeIds(v) {
  const map = new Map();
  const id = (s) => {
    if (!map.has(s)) map.set(s, `#${map.size + 1}`);
    return map.get(s);
  };
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(x)) {
        // 팬 파일의 열 꼴(seatId 배열)도 같은 차례 번호로 바꾼다
        if (k === 'seatId' && typeof val === 'string') out[k] = id(val);
        else if (k === 'seatId' && Array.isArray(val)) out[k] = val.map((s) => (typeof s === 'string' ? id(s) : s));
        else out[k] = walk(val);
      }
      return out;
    }
    return x;
  };
  return walk(v);
}

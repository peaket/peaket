// 좌석맵 시연 페이지(BUILD_ORDER HOT-120). tools/web-checks/seatmap-pkg가 세 엔진에서 열어 본다. 제품 화면이 아니다(좌석 화면은 HOT-350).
// ?theme=dark, ?main=1(OffscreenCanvas가 있어도 메인 스레드 대체로 그린다)
import { createSeatMap, type FromWorker } from '../src/index';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('map') as HTMLCanvasElement;
const hint = document.getElementById('hint')!;
const messages: FromWorker[] = [];
const started = performance.timeOrigin + performance.now();
const map = createSeatMap({
  canvas,
  layoutUrl: './layout.json',
  snapshotUrl: './snapshot.bin',
  admission: { token: 'demo' },
  theme: q.get('theme') === 'dark' ? 'dark' : 'light',
  createWorker: () => new Worker(new URL('../src/worker.ts', import.meta.url), { type: 'module' }),
  env: q.get('main') ? {} : undefined,
  onMessage: (m) => {
    messages.push(m);
    if (m.type === 'view') hint.textContent = m.level === 'overview' ? '구역을 확대하면 좌석을 고를 수 있습니다' : m.selectable ? '' : '조금 더 확대하면 좌석을 고를 수 있습니다';
    if (m.type === 'hit' && m.seatIndex >= 0) map.send({ type: 'select', seatIndex: m.seatIndex });
  },
});
canvas.addEventListener('pointerup', (e) => {
  const r = canvas.getBoundingClientRect();
  map.send({ type: 'pointer', kind: 'up', x: e.clientX - r.left, y: e.clientY - r.top });
});
document.getElementById('zin')!.addEventListener('click', () => map.send({ type: 'zoomBy', factor: 1.5 }));
document.getElementById('zout')!.addEventListener('click', () => map.send({ type: 'zoomBy', factor: 1 / 1.5 }));
document.getElementById('fit')!.addEventListener('click', () => map.send({ type: 'fit' }));

// 검사가 읽고 보낸다
Object.assign(window, { __seatmap: { mode: map.mode, messages, started, send: map.send } });

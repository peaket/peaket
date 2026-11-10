// CMP-051 좌석맵 편집 캔버스(ADR-0264 결정 2·3). Konva를 가져오는 곳은 이 폴더 하나다(asvs/frontend.md 15.1.4). 화면은 늦게 싣는 덩어리 안에서만 부른다.
export { mountSeatmapCanvas, SCALE_MAX, SCALE_MIN, WHEEL_FACTOR, type CanvasHandle, type CanvasHost, type CanvasSel, type CanvasState, type CanvasStep, type CanvasTool, type RectParams } from './canvas';

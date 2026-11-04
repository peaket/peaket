// @peaket/seatmap 공개 함수(docs/frontend.md §3.5·§5.2, BUILD_ORDER HOT-110). Worker 진입점은 '@peaket/seatmap/worker'다.
export { LAYOUT_FORMAT, FLAG, LIMITS, LayoutError, decodeLayout, sectionOf, seatIdOf, type DecodedLayout, type SeatMapColumnsFile, type SeatMapShape } from './layout';
export { CELL, HIT_RADIUS, MAX_GRID_CELLS, buildGrids, hitTest, hitAtScreen, cameraFit, type Camera, type SectionGrid } from './grid';
export { STATE, MAX_SUBSCRIBED_SECTIONS, WireError, decodeSnapshot, applySnapshot, decodeFrame, encodeSubscribe, encodeTimeSync, applyDelta, type Snapshot, type Frame, type SectionVersions, type DeltaDecision } from './wire';
export { PATTERN_MIN_PX, seatState, seatStyle, drawSeat, contrastRatio, type Ctx2D, type SeatStyle, type ColorMode } from './paint';
export { SeatMapEngine, SEAT_CM, SEAT_DRAW_MIN_PX, MIN_SELECT_PX } from './engine';
export { ToWorker, FromWorker, Admission } from './protocol';
export { canUseWorker, createSeatMap, type SeatMapClient, type CreateOptions, type Mode } from './client';

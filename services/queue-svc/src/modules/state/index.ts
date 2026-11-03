// 대기 상태 파일 컨텍스트의 공개 면(다른 모듈·시작 파일은 이 파일로만 들어온다).
export { MemoryStateSnapshots } from './adapters/memory-state-snapshots.js';
export { DEFAULT_WEB_ORIGIN, type StateSnapshots } from './domain/ports.js';
export { StateModule, type StateModuleOptions } from './state.module.js';

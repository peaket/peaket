// F-02-6(동결 로컬) CloudFront 설정 포트의 시험·local 가짜. 실제 CloudFront 배포 변경은 미실행이다.
// 처음 원본 그룹은 정본 값(500·502·503·504, 연결 시간 초과 2초, 시도 1회)이고, S3 사본 고정은 해제 명령 전까지 유지된다
// (control-tower §5 'CDN 설정 API', ADR-0078 결정 2, C-T44 ⑥).
import type { CdnEdgeChange, CdnEdgeSettings, CdnEdgeState } from '../domain/edge-ports.js';

const INITIAL: CdnEdgeState = Object.freeze({
  queueFilesOrigin: 'ORIGIN_GROUP',
  queueEntryResponse: 'ORIGIN',
  originGroup: Object.freeze({ failoverCodes: Object.freeze([500, 502, 503, 504]), connectionTimeoutMs: 2_000, attempts: 1 }),
});

export class MemoryCdnEdgeSettings implements CdnEdgeSettings {
  #state: CdnEdgeState = INITIAL;

  async read(): Promise<CdnEdgeState> {
    return this.#state;
  }

  async apply(change: CdnEdgeChange): Promise<CdnEdgeState> {
    // 두 스위치는 서로 독립이다: 준 칸만 바꾸고 다른 칸·원본 그룹은 그대로 둔다
    this.#state = {
      queueFilesOrigin: change.stateMirrorFixed === undefined ? this.#state.queueFilesOrigin : change.stateMirrorFixed ? 'S3_FALLBACK' : 'ORIGIN_GROUP',
      queueEntryResponse: change.soldOutStatic === undefined ? this.#state.queueEntryResponse : change.soldOutStatic ? 'SOLD_OUT_STATIC' : 'ORIGIN',
      originGroup: this.#state.originGroup,
    };
    return this.#state;
  }
}

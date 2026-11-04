// 조사용 값 호출의 오류(identity §9.1 '조사용 값의 첫 구현', BUILD_ORDER BOT-045). 받는 층이 gRPC 상태로 옮긴다.
// INVALID: 모양이 틀림, UNAVAILABLE: 라벨 키가 없음, EXHAUSTED: 초당 상한을 넘음
export class InvRefError extends Error {
  constructor(
    readonly code: 'INVALID' | 'UNAVAILABLE' | 'EXHAUSTED',
    message: string,
  ) {
    super(message);
    this.name = 'InvRefError';
  }
}

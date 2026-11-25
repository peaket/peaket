// F-04-12 조사 모듈 뼈대(첫 구현 커밋). 다음 커밋에서 채운다.
export class FraudClusterRunService {
  constructor(_: any) {}
  async runOnce(_: any): Promise<{ status: 'DONE' | 'FAILED'; attempts: number }> { return { status: 'FAILED', attempts: 0 }; }
}

// 연구 내보내기 거절 경보의 기록 대역. 실제 경보 전송은 관제 경보 경로가 맡는다.
import type { ResearchAlerts } from '../domain/ports.js';

export class LoggingResearchAlerts implements ResearchAlerts {
  constructor(
    private readonly log: (i: { kind: string; accountId: string; count: number; atMs: number; severity: string }) => void = (i) =>
      void process.stdout.write(`${JSON.stringify({ level: 'info', service: 'ops-svc', ...i, kind: 'research_export_alert' })}\n`),
  ) {}
  async raise(i: { kind: 'RESEARCH_EXPORT_DENIALS'; accountId: string; count: number; atMs: number; severity: 'SEV2' | 'SEV3' }): Promise<void> {
    this.log(i);
  }
}

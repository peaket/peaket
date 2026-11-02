// v0 입구 시작(docs/infra.md §3 'v0 배포'). 실행 명령: node dist/gateway/main.js
// v0 모놀리스 이미지의 다른 시작 명령이다(배포 단위는 하나, docs/architecture.md §9.3).
import { loadGatewayConfig } from './config.js';
import { createV0Gateway } from './server.js';

/**
 * 종료 때 처리 중인 요청을 기다리는 시간 [가정]: 앱 응답 기다림(기본 20초)보다 조금 길고,
 * 차트의 종료 유예 30초에서 preStop 5초를 뺀 25초보다 짧다(docs/devops.md §6.4 '일반 서비스')
 */
const SHUTDOWN_GRACE_MS = 21_000;

const config = loadGatewayConfig(process.env);
const gateway = createV0Gateway({ config });
const { port, managementPort } = await gateway.listen();
process.stdout.write(`v0-gateway listening https:${port} management:${managementPort}\n`);
process.once('SIGTERM', () => {
  void gateway.close(Math.min(SHUTDOWN_GRACE_MS, config.upstreamTimeoutMs + 1_000)).finally(() => process.exit(0));
});

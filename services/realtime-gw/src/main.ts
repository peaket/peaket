// realtime-gw 시작(BUILD_ORDER HOT-090). 실행: node --import @peaket/platform/telemetry/register dist/main.js
// 부모 프로세스가 있으면 포트를 알리고(peaket-ports), SIGTERM을 받으면 새 핸드셰이크를 받지 않고 모든 연결을 1012로 닫은 뒤 끝낸다(ADR-0296 결정 6, ADR-0297 결정 5).
import { start } from './start.js';

const service = await start({ env: process.env });
if (process.send) process.send({ type: 'peaket-ports', ...service.ports });
// close()는 10초 마감 안에 끝나거나 거절된다(ADR-0297 결정 5). 거절되면 로그 한 줄을 남기고 종료 코드 1로 끝낸다
process.once('SIGTERM', () => {
  service.close().then(
    // 다 닫았다. 남은 핸들(멈춘 Redis 소켓 등)이 프로세스를 붙잡지 않게 바로 끝낸다(로그는 동기 쓰기라 잃지 않는다)
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`${JSON.stringify({ level: 'error', event: 'realtime_gw_shutdown_failed', err: err instanceof Error ? err.message : 'unknown' })}\n`);
      process.exit(1);
    },
  );
});

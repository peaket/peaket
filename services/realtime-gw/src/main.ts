// realtime-gw 시작(BUILD_ORDER HOT-090). 실행: node --import @peaket/platform/telemetry/register dist/main.js
// 부모 프로세스가 있으면 포트를 알리고(peaket-ports), SIGTERM을 받으면 새 핸드셰이크를 받지 않고 모든 연결을 1012로 닫은 뒤 끝낸다(ADR-0296 결정 6).
import { start } from './start.js';

const service = await start({ env: process.env });
if (process.send) process.send({ type: 'peaket-ports', ...service.ports });
process.once('SIGTERM', () => void service.close());

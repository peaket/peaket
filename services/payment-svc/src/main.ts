// payment-svc 시작(BUILD_ORDER PRF-180). 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 조립(포트·풀·실행기·판정자·종료 차례)은 start.ts다(한 프로세스 합본 services/bundle도 같은 함수를 부른다, BUILD_ORDER PRF-215·ADR-0262 결정 4).
// 이 파일은 환경 값과 SIGTERM만 잇는다.
import { start } from './start.js';

const service = await start({ env: process.env });
// 시험 대역이 PORT=0·PEAKET_MANAGEMENT_PORT=0·PEAKET_GRPC_PORT=0으로 띄웠을 때 실제로 연 포트를 부모에 알린다(운영에는 IPC 채널이 없다)
if (process.send) process.send({ type: 'peaket-ports', ...service.ports });
process.once('SIGTERM', () => void service.close());

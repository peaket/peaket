// payment-svc 시작(BUILD_ORDER PRF-180). 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 조립(포트·풀·실행기·판정자·종료 차례)은 start.ts다(한 프로세스 합본 services/bundle도 같은 함수를 부른다, BUILD_ORDER PRF-215·ADR-0262 결정 4).
// 이 파일은 환경 값과 SIGTERM만 잇는다.
import { start } from './start.js';

const service = await start({ env: process.env });
process.once('SIGTERM', () => void service.close());

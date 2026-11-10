// admission-ctrl 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// 관리 포트(/metrics, /ready)는 서비스 뼈대가 연다. 리더 하나만 200ms 루프를 돈다(쿠버네티스 Lease, ADR-0056·0182).
// 조립은 start.ts다(한 프로세스 합본 services/bundle도 같은 함수를 부른다, BUILD_ORDER PRF-215·ADR-0262 결정 4). 이 파일은 환경 값과 SIGTERM만 잇는다.
import { start } from './start.js';

const service = await start({ env: process.env });
process.once('SIGTERM', () => void service.close());

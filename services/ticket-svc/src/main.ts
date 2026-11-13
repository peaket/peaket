// ticket-svc 시작(BUILD_ORDER HOT-160). 실행: node --import @peaket/platform/telemetry/register dist/main.js
import { start } from './start.js';

const service = await start({ env: process.env });
if (process.send) process.send({ type: 'peaket-ports', ...service.ports });
process.once('SIGTERM', () => void service.close());

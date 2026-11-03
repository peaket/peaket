// node --import @peaket/platform/telemetry/register dist/main.js
// 환경 변수로 OTel SDK를 시작한다(openspec 변경 add-service-logging 결정 7).
// OTEL_SERVICE_NAME(필수), PEAKET_VERSION, PEAKET_ENV, PEAKET_TRACE_INBOUND(mesh 기본·untrusted), 내보내기는 OTel 표준 환경 변수.
import { startTelemetry } from './telemetry.js';

const env = process.env;
const serviceName = env.OTEL_SERVICE_NAME;
if (!serviceName) throw new Error('OTEL_SERVICE_NAME이 없다. 서비스 이름 없이 OTel SDK를 시작하지 않는다');
const inbound = env.PEAKET_TRACE_INBOUND || 'mesh';
if (inbound !== 'mesh' && inbound !== 'untrusted') throw new Error(`PEAKET_TRACE_INBOUND는 mesh·untrusted 가운데 하나여야 한다: ${inbound}`);
startTelemetry({ serviceName, version: env.PEAKET_VERSION, env: env.PEAKET_ENV, inbound });

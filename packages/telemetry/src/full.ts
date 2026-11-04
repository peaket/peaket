// @peaket/telemetry 전체 판(대기실 경량 페이지를 뺀 앱, docs/frontend.md §5.16). lite 판에 더해, 같은 출처 요청(앱 서버)에만 붙이는
// 무작위 traceparent(표본 표시 00)를 만든다. 브라우저 span은 내보내지 않고 OpenTelemetry 브라우저 SDK도 싣지 않는다.
// 오류 도구(Sentry) 연결은 그 도구를 붙이는 단계에서 더한다.
export * from './lite';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function randomNonZero(n: number): string {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    if (b.some((x) => x !== 0)) return hex(b); // W3C trace context는 모두 0인 값을 금한다
  }
}

/** W3C traceparent(판 00, 표본 표시 00) */
export function traceparent(): string {
  return `00-${randomNonZero(16)}-${randomNonZero(8)}-00`;
}

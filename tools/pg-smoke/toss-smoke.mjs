#!/usr/bin/env node
// 토스 공개 시험 키 스모크(P-T16, docs/features/payment.md §2.1 '계약 시험과 실제 결제사 호출의 몫', BUILD_ORDER HOT-145).
// 결제창 없이 되는 호출 둘만 부르고 응답 모양을 대조한다: 없는 결제 조회(404 NOT_FOUND_PAYMENT), 승인 API의 시험 코드 머리(TossPayments-Test-Code로 실패를 흉내 낸다).
// 키는 환경 값 TOSS_DOCS_TEST_SECRET_KEY다. 저장소에 넣지 않고(`docs/security/secrets-and-keys.md`), 없으면 건너뛰고 성공 종료한다. 단 예약 잡이 켜져 있으면(PEAKET_PG_SMOKE_ENABLED=true) 키 없음은 실패다(켜 둔 잡이 조용히 건너뛰지 않게). test_로 시작하지 않으면 부르지 않고 실패한다.
// 결제창 인증이 필요한 항목(정상 승인, 취소, 가상계좌, 가린 번호 실물)은 이 스모크로 못 한다.
// 쓰는 법: TOSS_DOCS_TEST_SECRET_KEY=... node tools/pg-smoke/toss-smoke.mjs
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BASE_URL = 'https://api.tosspayments.com';
/** 호출 한 번의 시간 한도 15초 [가정](스모크라 짧게 끊고 다시 하지 않는다) */
const TIMEOUT_MS = 15_000;

/** 대조할 호출. expected는 공식 문서의 모양이다(에러 코드, 인증 및 기타 헤더 설정, 2026-11-09 확인) */
export const SMOKE_CASES = [
  {
    name: 'not-found',
    method: 'GET',
    path: () => `/v1/payments/smoke-${randomUUID()}`,
    expected: { status: 404, code: 'NOT_FOUND_PAYMENT' },
  },
  {
    name: 'test-code',
    method: 'POST',
    path: () => '/v1/payments/confirm',
    headers: { 'TossPayments-Test-Code': 'INVALID_REJECT_CARD', 'content-type': 'application/json' },
    body: () => JSON.stringify({ paymentKey: `smoke-${randomUUID()}`, orderId: `smoke-${randomUUID()}`, amount: 1000 }),
    expected: { status: 400, code: 'INVALID_REJECT_CARD' },
  },
];

/** 응답 모양 대조. 문제 목록을 돌려준다(값은 코드만 싣는다) */
export function checkReply(smokeCase, reply) {
  const { status, code } = smokeCase.expected;
  const problems = [];
  if (reply.status !== status) problems.push(`${smokeCase.name}: HTTP 상태가 ${status}가 아니라 ${reply.status}다`);
  const json = reply.json;
  if (typeof json !== 'object' || json === null) {
    problems.push(`${smokeCase.name}: 응답이 JSON 객체가 아니다`);
    return problems;
  }
  if (json.code !== code) problems.push(`${smokeCase.name}: code가 ${code}가 아니라 ${String(json.code)}다`);
  if (typeof json.message !== 'string' || json.message === '') problems.push(`${smokeCase.name}: message가 글이 아니다`);
  return problems;
}

async function callOnce(smokeCase, authorization, fetchFn) {
  const res = await fetchFn(`${BASE_URL}${smokeCase.path()}`, {
    method: smokeCase.method,
    headers: { authorization, ...smokeCase.headers },
    body: smokeCase.body?.(),
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/** 스모크 한 번. 종료 코드를 돌려준다(0 성공·건너뜀, 1 실패). 출력에 키를 싣지 않는다 */
export async function run({ env = process.env, fetch: fetchFn = globalThis.fetch, log = console.log } = {}) {
  const key = env.TOSS_DOCS_TEST_SECRET_KEY?.trim();
  if (!key) {
    if (env.PEAKET_PG_SMOKE_ENABLED === 'true') {
      log('실패: PEAKET_PG_SMOKE_ENABLED가 true인데 TOSS_DOCS_TEST_SECRET_KEY가 없다');
      return 1;
    }
    log('건너뜀: TOSS_DOCS_TEST_SECRET_KEY가 없다');
    return 0;
  }
  if (!key.startsWith('test_')) {
    log('실패: TOSS_DOCS_TEST_SECRET_KEY가 시험 키(test_)가 아니라 부르지 않았다');
    return 1;
  }
  const authorization = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  const problems = [];
  for (const smokeCase of SMOKE_CASES) {
    try {
      problems.push(...checkReply(smokeCase, await callOnce(smokeCase, authorization, fetchFn)));
    } catch (err) {
      // 오류 글에 값이 실리지 않게 이름만 쓴다
      problems.push(`${smokeCase.name}: 호출 실패(${err?.name ?? '오류'})`);
    }
  }
  for (const p of problems) log(`실패: ${p}`);
  if (problems.length > 0) return 1;
  log(`통과: ${SMOKE_CASES.length}개 호출의 응답 모양이 공식 문서와 같다`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await run();

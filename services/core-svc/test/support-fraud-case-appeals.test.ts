// F-04-15 core support → ops 내부 소명 연결 경계 시험(동결 로컬, LCH-310).
// ops의 409(기한 지남·대상 아님)는 팬 화면에 그대로 보이고, 닫힌 대역은 503 ProblemError다.
import 'reflect-metadata';
import { ProblemError } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { HttpFraudCaseAppeals, UnavailableFraudCaseAppeals } from '../src/modules/support/index.js';

const input = {
  caseId: '0194b220-0000-7000-8000-000000000301',
  appealId: '0194b220-0000-7000-8000-000000000302',
  accountId: '0194b220-0000-7000-8000-000000000303',
  party: 'PAYER' as const,
  submittedAt: '2026-11-26T00:00:00.000Z',
};

const clientOf = (status: number, body: unknown) => ({
  async request() {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  },
});

describe('core support ops 연결', () => {
  test('IR-10 ops 409·404는 503이 아니라 같은 상태·이름으로 팬 화면에 전한다', async () => {
    const conflict = new HttpFraudCaseAppeals(clientOf(409, { type: 'about:blank', status: 409, title: '소명 기한이 지났습니다' }) as never);
    const c = (await conflict.submit(input).catch((e: unknown) => e)) as ProblemError;
    expect(c).toBeInstanceOf(ProblemError);
    expect(c).toMatchObject({ status: 409 });

    const missing = new HttpFraudCaseAppeals(clientOf(404, { type: 'about:blank', status: 404, title: '없는 사건' }) as never);
    const m = (await missing.submit(input).catch((e: unknown) => e)) as ProblemError;
    expect(m).toBeInstanceOf(ProblemError);
    expect(m).toMatchObject({ status: 404, slug: 'not-found' });
  });

  test('IR-10 닫힌 대역은 평범한 객체가 아니라 503 ProblemError를 던진다', async () => {
    const e = (await new UnavailableFraudCaseAppeals().submit(input).catch((x: unknown) => x)) as ProblemError;
    expect(e).toBeInstanceOf(ProblemError);
    expect(e).toMatchObject({ status: 503, slug: 'dependency-unavailable' });
  });
});

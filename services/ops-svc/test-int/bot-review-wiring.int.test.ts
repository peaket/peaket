// 표본 검토 시작 조립(BAT-197 BOT-080, 계획 §8 '시작 조립', §11 게이트).
// ops-svc 시작 파일이 후보 원장(ClickHouse)·trust ApplyLabel 클라이언트·지표를 AppModule을 거쳐 표본 검토 모듈에 넘기는지,
// 환경 값이 없을 때 local·ci는 닫힌 대역(503)으로 뜨고 운영 배포 값에 자리가 있는지 본다.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { botReviewLabelsFromEnv, botReviewSourceFromEnv } from '../src/bot-review-wiring.js';
import { BOT_REVIEW_STORE } from '../src/modules/bot-review/bot-review.module.js';
import { ClickHouseBotReviewSource, FixtureBotReviewSource, GrpcTrustLabels, UnavailableBotReviewSource } from '../src/modules/bot-review/index.js';
import { FakeIdentity, quiet } from '../test/support.js';

const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
const appModule = readFileSync(fileURLToPath(new URL('../src/app.module.ts', import.meta.url)), 'utf8');
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { scripts: Record<string, string> };
const values = readFileSync(fileURLToPath(new URL('../../../deploy/workloads/ops-svc/values.yaml', import.meta.url)), 'utf8');
const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc-bot-review-wiring',
    module: AppModule.register({
      memory: true,
      botReview: {
        source: botReviewSourceFromEnv({ PEAKET_BOT_REVIEW_SOURCE: 'fixture' }).source,
        labels: botReviewLabelsFromEnv({ PEAKET_TRUST_GRPC_URL: '127.0.0.1:1' }),
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock(),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

describe('BAT-197 표본 검토 시작 조립', () => {
  test('시작 파일이 표본 검토 모듈·trust 클라이언트·ClickHouse 원천을 조립한다', () => {
    for (const text of ['botReviewSourceFromEnv(process.env)', 'botReviewLabelsFromEnv(process.env)', 'new PromBotReviewSignals()', 'botReviewActorRef', 'botReviewSignals.register(service.metrics.registry)']) {
      expect(main).toContain(text);
    }
    expect(main).toMatch(/botReview:\s*\{[\s\S]{0,400}source:\s*botReviewSource\.source/);
    expect(main).toMatch(/\.\.\.\(botReviewLabels \? \{ labels: botReviewLabels \} : \{\}\)/);
    expect(main).toMatch(/accountRef:\s*\(accountId: string\)\s*=>\s*botReviewActorRef\.ref\(accountId\)/);
    // 뿌리 모듈이 표본 검토 모듈을 DB·메모리 두 갈래에 모두 싣는다
    expect(appModule.match(/BotReviewModule\.register\(/g)).toHaveLength(2);
    expect(appModule).toMatch(/BotReviewModule\.register\(\{ database: o\.database, \.\.\.\(o\.botReview \?\? \{\}\) \}\)/);
    expect(appModule).toMatch(/BotReviewModule\.register\(\{ \.\.\.\(o\.botReview \?\? \{\}\) \}\)/);
    // 배정 작업 실행 스크립트
    expect(pkg.scripts['assign-bot-review']).toBe('node dist/bot-review-assign.js');
    // 배포 값: trust gRPC·분석 ClickHouse·원천 선택
    for (const key of ['PEAKET_TRUST_GRPC_URL', 'PEAKET_ANALYTICS_CLICKHOUSE_URL', 'PEAKET_BOT_REVIEW_SOURCE']) expect(values, key).toContain(key);
  });

  test('원천 환경 값은 fixture·clickhouse·닫힌 대역을 가른다', async () => {
    const fixture = botReviewSourceFromEnv({ PEAKET_BOT_REVIEW_SOURCE: 'fixture' });
    expect(fixture.source).toBeInstanceOf(FixtureBotReviewSource);
    expect(fixture.warning).toBeUndefined();
    const clickhouse = botReviewSourceFromEnv({ PEAKET_BOT_REVIEW_SOURCE: 'clickhouse', PEAKET_ANALYTICS_CLICKHOUSE_URL: 'http://clickhouse:8123' });
    expect(clickhouse.source).toBeInstanceOf(ClickHouseBotReviewSource);
    // 주소가 없으면 닫힌 대역이고 경고를 남긴다(진행은 503 source-unavailable)
    const down = botReviewSourceFromEnv({});
    expect(down.source).toBeInstanceOf(UnavailableBotReviewSource);
    expect(down.warning).toMatch(/PEAKET_ANALYTICS_CLICKHOUSE_URL/);
    expect(() => botReviewSourceFromEnv({ PEAKET_BOT_REVIEW_SOURCE: 'kafka' })).toThrow(/clickhouse·fixture/);
    // trust 주소가 없으면 labels가 없어 HUMAN·BOT 판정이 503이고 UNDECIDED는 기록된다
    expect(botReviewLabelsFromEnv({})).toBeUndefined();
    const labels = botReviewLabelsFromEnv({ PEAKET_TRUST_GRPC_URL: '127.0.0.1:50051' });
    expect(labels).toBeInstanceOf(GrpcTrustLabels);
    labels?.close();
  });

  test('조립한 서비스가 표본 검토 경로를 열고 닫힌 trust 대역에서 HUMAN 판정을 503으로 답한다', async () => {
    const store = svc.app.get(BOT_REVIEW_STORE);
    expect(store).toBeDefined();
    const who = identity.ops('cs_agent');
    // 배치가 없으면 진행은 404(원장 대역은 답한다)
    const progress = await svc.http.inject({ method: 'GET', url: '/v1/ops/events/0194b197-0000-7000-8000-0000000000f1/bot-review', headers: who });
    expect(progress.statusCode).toBe(404);
    // 없는 표본 판정은 404이고 경로 자체는 열려 있다
    const missing = await svc.http.inject({
      method: 'POST',
      url: '/v1/ops/bot-review-samples/0194b197-0000-7000-8000-0000000000f2/judgement',
      headers: { ...who, 'idempotency-key': '6ba7b810-9dad-41d1-80b4-00c04fd430c8', 'content-type': 'application/json' },
      payload: JSON.stringify({ verdict: 'HUMAN' }),
    });
    expect(missing.statusCode).toBe(404);
    expect(identity.answers.size).toBeGreaterThan(0);
  });
});

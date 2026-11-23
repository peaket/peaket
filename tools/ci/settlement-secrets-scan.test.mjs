// settlement-secrets-scan.mjs 시험(J-T14 정적 검사, F-07-7 계획 I-11, ADR-0370 결정 1, ADR-0053 결정 5). 실행: node --test "tools/ci/*.test.mjs"
// 정본: docs/features/settlement.md §13 J-T14 "계좌번호, 보안 키, JWE 원문이 로그·응답·분석 이벤트에 없다(정적 검사와 로그 표본 검사)".
// 로그 표본 검사는 payment-svc 시험 몫(settlement-payout-account.http.test.ts J-T14)이고, 이 파일은 정적 검사 도구만 본다.
//
// 시험이 정한 도구 모양(계획 I-11은 이름 [가정]과 찾을 모양만 적었다. 다른 tools/ci 검사처럼 함수 export + 명령줄):
//   scanSource(text: string, file: string) → { file, line, rule }[]     rule ∈ 'log' | 'response' | 'error'
//   scanRepo({ root }) → { files: number, findings: { file, line, rule }[] }   기본 범위: payment-svc settlement 모듈·core-svc catalog·partner 정산 화면
//   명령줄 `node tools/ci/settlement-secrets-scan.mjs [--root <저장소>]` → 찾으면 끝 코드 1(찾은 자리를 표준 오류에), 없으면 0, 모르는 인자 2
// 찾을 이름: accountNumber·securityKey·jwe·compact(계획 I-11). 끝 4자리(accountLast4·last4)는 찾지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'settlement-secrets-scan.mjs');
const REPO = resolve(here, '..', '..');
const { scanRepo, scanSource } = await import('./settlement-secrets-scan.mjs');

const lines = (...xs) => xs.join('\n');
const at = (findings) => findings.map((f) => [f.line, f.rule]);

test('J-T14 정적 검사 1: 로그 호출 인자의 계좌번호·보안 키·JWE 원문 이름을 찾는다(logger·log·this.log·console)', () => {
  const src = lines(
    "import { x } from './x.js';",
    'logger.info({ promoterId, accountNumber });',
    "this.log.warn('결제사 응답', securityKey);",
    'log.error({ jwe });',
    'console.log(compact);',
    "deps.log?.failed?.({ reason: 'x', accountNumber: body.accountNumber });",
  );
  assert.deepEqual(at(scanSource(src, 'services/payment-svc/src/modules/settlement/application/x.ts')), [
    [2, 'log'],
    [3, 'log'],
    [4, 'log'],
    [5, 'log'],
    [6, 'log'],
  ]);
});

test('J-T14 정적 검사 2: 끝 4자리·마스킹 값·이름이 비슷한 다른 칸은 찾지 않는다', () => {
  const src = lines(
    'logger.info({ promoterId, accountLast4 });',
    "log.info({ last4: account.last4, bankCode: '088' });",
    "this.log.warn('계좌 변경', { holderMatched: true });",
    "const compactView = view; log.info({ view: compactView.id });",
    "logger.debug({ jweHeaderAlg: 'dir' });",
  );
  assert.deepEqual(scanSource(src, 'services/payment-svc/src/modules/settlement/application/y.ts'), []);
});

test('J-T14 정적 검사 3: 응답 스키마의 accountNumber 칸은 찾고, 요청 본문 스키마의 칸은 찾지 않는다', () => {
  const src = lines(
    "import { z } from 'zod';",
    'export const PayoutRegistrationBody = z.object({ account: z.object({ bankCode: z.string(), accountNumber: z.string(), holderName: z.string() }) });',
    'export const PayoutRegistrationResponse = z.object({',
    '  bankCode: z.string(),',
    '  accountNumber: z.string(),',
    '});',
  );
  assert.deepEqual(at(scanSource(src, 'services/payment-svc/src/modules/settlement/inbound/internal-settlement.controller.ts')), [[5, 'response']]);
});

test('J-T14 정적 검사 4: 예외 메시지에 계좌번호를 넣으면 찾는다(ADR-0370 결정 1 "예외 메시지에 없음")', () => {
  const src = lines(
    'throw new Error(`예금주 조회 실패: ${input.accountNumber}`);',
    "throw new PayoutAgencyError({ agency: 'PORTONE', status: 502 });",
    "throw new SettlementProblem('payout-account-holder-mismatch', 422, '예금주가 판매자 상호나 대표자와 다릅니다');",
  );
  assert.deepEqual(at(scanSource(src, 'services/payment-svc/src/modules/settlement/application/payout-agencies.ts')), [[1, 'error']]);
});

test('J-T14 정적 검사 5: 실제 저장소의 검사 범위(payment settlement·core catalog·partner 정산 화면)는 0건이고 빈 범위로 통과하지 않는다', () => {
  const out = scanRepo({ root: REPO });
  assert.deepEqual(out.findings, []);
  // 범위를 잘못 잡아 파일 0개로 '통과'하지 않는다: 지금 settlement 모듈만 해도 20개가 넘는다
  assert.ok(out.files > 20, `검사한 파일이 ${out.files}개뿐이다`);
});

test('J-T14 정적 검사 6: 명령줄: 찾으면 끝 코드 1과 자리, 없으면 0, 모르는 인자는 2', () => {
  const root = tempDir('peaket-secrets-scan-');
  const dir = join(root, 'services', 'payment-svc', 'src', 'modules', 'settlement', 'application');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'leak.ts');
  writeFileSync(file, lines('export const a = 1;', 'logger.info({ accountNumber });'));
  let err;
  try {
    execFileSync(process.execPath, [TOOL, '--root', root], { stdio: 'pipe', encoding: 'utf8' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '찾았는데 끝 코드 0이다');
  assert.equal(err.status, 1);
  assert.match(String(err.stderr), /leak\.ts:2/);
  // 계좌번호 값 자체를 출력하지 않는다(이름과 자리만)
  writeFileSync(file, lines('export const a = 1;', "logger.info({ accountNumber: '98765432101234' });"));
  let leaked;
  try {
    execFileSync(process.execPath, [TOOL, '--root', root], { stdio: 'pipe', encoding: 'utf8' });
  } catch (e) {
    leaked = e;
  }
  assert.ok(leaked, '찾았는데 끝 코드 0이다');
  assert.equal(leaked.status, 1);
  assert.equal(String(leaked.stderr).includes('98765432101234'), false);
  assert.equal(String(leaked.stdout).includes('98765432101234'), false);
  writeFileSync(file, lines('export const a = 1;', 'logger.info({ accountLast4 });'));
  execFileSync(process.execPath, [TOOL, '--root', root], { stdio: 'pipe', encoding: 'utf8' });
  assert.throws(() => execFileSync(process.execPath, [TOOL, '--bogus'], { stdio: 'pipe' }), (e) => e.status === 2);
});

#!/usr/bin/env node
// 진단 증거 보존 규칙 정적 검사(기능 F-01-1, OPS-030, 시험 D-T52 ①, ADR-0070 결정 1, ASVS v5.0.0-14.1.2·14.2.7).
// 수명 주기 규칙 원천 infra/modules/evidence-bucket/lifecycle.json(S3 PutBucketLifecycleConfiguration의 JSON 꼴, {"Rules":[…]})이
// docs/observability.md §9 보존 표 '진단 증거' 행과 같은지 본다. 값은 그 행에서 읽고 이 파일에 적지 않는다.
// - 보존 태그 standard 규칙: 켜져 있고 그 태그만 거르며 §9의 보존 일수에 지운다
// - 보존 태그 hold 규칙: 켜져 있고 그 태그만 거르며 §9의 연장 일수에 지운다
// - 빈 앞머리({"Prefix": ""}) 정리 규칙: 이전 판 지우기(§9의 일수), 끝나지 않은 여러 조각 올리기 지우기(§9의 일수), 남은 삭제 표시 치우기
//   (버전 관리를 켠 버킷의 만료는 이전 판을 남기므로 이 규칙이 없으면 실제로 지워지지 않는다)
// - 모든 규칙이 켜져 있고(Enabled), 다른 저장 등급으로 옮기지 않으며(Transitions·NoncurrentVersionTransitions 없음),
//   위 셋 밖의 규칙이 없다(연장 일수보다 오래 두거나 다른 태그로 거르는 규칙을 막는다)
// 쓰는 법: node tools/ci/evidence-retention.mjs --check [--root <저장소>]
//   끝 코드 0 통과, 1 어긋남(모두 '막음: <파일>: <까닭>'으로 찍는다), 2 인자 오류·§9 행이나 원천을 읽지 못함
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './entry.mjs';

const USAGE = '쓰는 법: node tools/ci/evidence-retention.mjs --check [--root <저장소>]';
export const RETENTION_DOC = 'docs/observability.md';
export const LIFECYCLE_FILE = 'infra/modules/evidence-bucket/lifecycle.json';
const ROW_HEAD = '| 진단 증거(진단 보고서';

/** 읽기 실패(끝 코드 2) */
class ReadError extends Error {}

/**
 * §9 보존 표 '진단 증거' 행에서 보존 규칙 값을 읽는다. 읽지 못하면 던진다
 * @param {string} root 저장소 뿌리
 */
export function readRetentionPolicy(root) {
  let text;
  try {
    text = readFileSync(join(root, RETENTION_DOC), 'utf8');
  } catch (err) {
    throw new ReadError(`${RETENTION_DOC}을(를) 읽지 못했다: ${err.code ?? err.message}`);
  }
  const row = text.split(/\r?\n/).find((l) => l.startsWith(ROW_HEAD));
  if (!row) throw new ReadError(`${RETENTION_DOC} §9 보존 표에 '진단 증거' 행이 없다`);
  const num = (re, what) => {
    const m = re.exec(row);
    if (!m) throw new ReadError(`${RETENTION_DOC} §9 '진단 증거' 행에서 ${what}을(를) 읽지 못했다`);
    return Number(m[1]);
  };
  const tag = (re, what) => {
    const m = re.exec(row);
    if (!m) throw new ReadError(`${RETENTION_DOC} §9 '진단 증거' 행에서 ${what} 태그를 읽지 못했다`);
    return { key: m[1], value: m[2] };
  };
  const standard = tag(/보존 태그 `([a-z][a-z0-9-]*)=([a-z]+)`를 달/, '올릴 때 다는(standard)');
  const hold = tag(/`([a-z][a-z0-9-]*)=([a-z]+)`로 바꾸/, '연장(hold)');
  if (standard.key !== hold.key) throw new ReadError(`${RETENTION_DOC} §9 '진단 증거' 행의 두 보존 태그 이름이 다르다(${standard.key}, ${hold.key})`);
  return {
    standardDays: num(/(\d+)일 \[가정\] 뒤 수명 주기 규칙으로 삭제/, '보존 일수'),
    holdDays: num(/(\d+)일 \[가정\]까지 연장/, '연장 일수'),
    noncurrentDays: num(/이전 판이 된 객체는 (\d+)일/, '이전 판 지우기 일수'),
    abortMultipartDays: num(/여러 조각 올리기는 (\d+)일/, '남은 조각 지우기 일수'),
    tagKey: standard.key,
    standardValue: standard.value,
    holdValue: hold.value,
  };
}

/** 원천을 읽는다. 읽지 못하거나 {"Rules":[…]} 꼴이 아니면 던진다 */
function readLifecycle(root) {
  let text;
  try {
    text = readFileSync(join(root, LIFECYCLE_FILE), 'utf8');
  } catch (err) {
    throw new ReadError(`${LIFECYCLE_FILE}을(를) 읽지 못했다: ${err.code ?? err.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    throw new ReadError(`${LIFECYCLE_FILE}이(가) JSON이 아니다: ${err.message}`);
  }
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.Rules)) throw new ReadError(`${LIFECYCLE_FILE}에 Rules 배열이 없다`);
  return cfg;
}

/** 규칙의 태그 거르개(Filter.Tag 또는 Filter.And.Tags) */
function tagsOf(rule) {
  const f = rule?.Filter ?? {};
  if (f.Tag) return [f.Tag];
  if (Array.isArray(f.And?.Tags)) return f.And.Tags;
  return [];
}
const isCleanup = (rule) => rule?.Filter && Object.keys(rule.Filter).length === 1 && rule.Filter.Prefix === '';

/**
 * 원천과 §9 행의 어긋남 목록(빈 배열이면 통과). 읽지 못하면 던진다
 * @param {string} root 저장소 뿌리
 * @returns {string[]}
 */
export function checkEvidenceRetention(root) {
  const p = readRetentionPolicy(root);
  const cfg = readLifecycle(root);
  const problems = [];
  const name = (r, i) => (typeof r?.ID === 'string' && r.ID ? r.ID : `Rules[${i}]`);

  // 모든 규칙에 공통: 켜짐, 다른 저장 등급으로 옮기지 않음, 정한 셋 가운데 하나
  cfg.Rules.forEach((r, i) => {
    if (r?.Status !== 'Enabled') problems.push(`규칙 ${name(r, i)}이(가) 켜져 있지 않다(Status ${JSON.stringify(r?.Status)})`);
    if (r?.Transitions !== undefined || r?.Transition !== undefined) problems.push(`규칙 ${name(r, i)}이(가) 다른 저장 등급으로 옮긴다(Transitions). 진단 증거는 옮기지 않고 지운다`);
    if (r?.NoncurrentVersionTransitions !== undefined || r?.NoncurrentVersionTransition !== undefined)
      problems.push(`규칙 ${name(r, i)}이(가) 이전 판을 다른 저장 등급으로 옮긴다(NoncurrentVersionTransitions)`);
    const tags = tagsOf(r);
    const known = isCleanup(r) || (tags.length === 1 && tags[0]?.Key === p.tagKey && [p.standardValue, p.holdValue].includes(tags[0]?.Value));
    if (!known) {
      const days = r?.Expiration?.Days;
      const why = typeof days === 'number' && days > p.holdDays ? `연장 일수 ${p.holdDays}일보다 오래(${days}일) 둔다` : '보존 태그 규칙 둘·빈 앞머리 정리 규칙 밖의 규칙이다';
      problems.push(`규칙 ${name(r, i)}: ${why}(§9 '진단 증거' 행)`);
    }
  });

  // 보존 태그 규칙 둘
  for (const [value, days, what] of [
    [p.standardValue, p.standardDays, '보존 일수'],
    [p.holdValue, p.holdDays, '연장 일수'],
  ]) {
    const rules = cfg.Rules.filter((r) => tagsOf(r).some((t) => t?.Key === p.tagKey && t?.Value === value));
    if (rules.length === 0) {
      problems.push(`보존 태그 ${p.tagKey}=${value}로 거르는 규칙이 없다(§9 '진단 증거' 행의 ${what} ${days}일)`);
      continue;
    }
    if (rules.length > 1) problems.push(`보존 태그 ${p.tagKey}=${value}로 거르는 규칙이 ${rules.length}개다(하나여야 한다)`);
    for (const r of rules) {
      if (tagsOf(r).length !== 1) problems.push(`규칙 ${r.ID}이(가) ${p.tagKey}=${value} 말고 다른 태그도 거른다`);
      if (r.Expiration?.Days !== days) problems.push(`규칙 ${r.ID}의 지우는 날이 ${JSON.stringify(r.Expiration?.Days)}이다(§9 '진단 증거' 행의 ${what} ${days}일)`);
      if (r.Filter?.Prefix || r.Filter?.And?.Prefix) problems.push(`규칙 ${r.ID}이(가) 앞머리로도 거른다(태그만 걸러야 모든 서비스 접두사에 든다)`);
    }
  }

  // 빈 앞머리 정리 규칙: 이전 판·남은 조각·남은 삭제 표시
  const cleanup = cfg.Rules.filter(isCleanup);
  if (cleanup.length === 0) {
    problems.push(`빈 앞머리({"Prefix": ""}) 정리 규칙이 없다(이전 판 ${p.noncurrentDays}일·남은 조각 ${p.abortMultipartDays}일·남은 삭제 표시 치우기)`);
  } else {
    const noncurrent = cleanup.map((r) => r.NoncurrentVersionExpiration?.NoncurrentDays).filter((d) => d !== undefined);
    if (noncurrent.length === 0) problems.push(`정리 규칙에 이전 판 지우기(NoncurrentVersionExpiration)가 없다(§9 '진단 증거' 행의 ${p.noncurrentDays}일)`);
    else if (noncurrent.some((d) => d !== p.noncurrentDays)) problems.push(`이전 판 지우기 날이 ${noncurrent.join(', ')}이다(§9 '진단 증거' 행의 ${p.noncurrentDays}일)`);
    const abort = cleanup.map((r) => r.AbortIncompleteMultipartUpload?.DaysAfterInitiation).filter((d) => d !== undefined);
    if (abort.length === 0) problems.push(`정리 규칙에 남은 조각 지우기(AbortIncompleteMultipartUpload)가 없다(§9 '진단 증거' 행의 ${p.abortMultipartDays}일)`);
    else if (abort.some((d) => d !== p.abortMultipartDays)) problems.push(`남은 조각 지우기 날이 ${abort.join(', ')}이다(§9 '진단 증거' 행의 ${p.abortMultipartDays}일)`);
    if (!cleanup.some((r) => r.Expiration?.ExpiredObjectDeleteMarker === true)) problems.push('정리 규칙에 남은 삭제 표시 치우기(Expiration.ExpiredObjectDeleteMarker: true)가 없다');
    for (const r of cleanup) {
      if (r.Expiration?.Days !== undefined || r.Expiration?.Date !== undefined) problems.push(`정리 규칙 ${r.ID}이(가) 태그와 상관없이 현재 판을 지운다(Expiration.Days·Date)`);
    }
  }
  return problems;
}

function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--root' && argv[i + 1] && !argv[i + 1].startsWith('--')) root = resolve(argv[++i]);
    else {
      console.error(`모르는 인자: ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!check) {
    console.error(USAGE);
    return 2;
  }
  let problems;
  try {
    problems = checkEvidenceRetention(root);
  } catch (err) {
    if (err instanceof ReadError) {
      console.error(`읽기 오류: ${err.message}`);
      return 2;
    }
    throw err;
  }
  for (const p of problems) console.log(`막음: ${LIFECYCLE_FILE}: ${p}`);
  if (problems.length) return 1;
  console.log(`진단 증거 보존 규칙: ${LIFECYCLE_FILE}이(가) ${RETENTION_DOC} §9 '진단 증거' 행과 같다`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));

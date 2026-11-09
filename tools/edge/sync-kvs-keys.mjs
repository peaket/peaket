#!/usr/bin/env node
// 엣지 키 값 저장소의 도착 시각 쿠키 서명 키 항목을 Secrets Manager 값과 맞춘다(docs/security/secrets-and-keys.md, ADR-0223 결정 10, BUILD_ORDER HOT-020).
// 배포 파이프라인이 배포 역할로 돌린다. 키 이름은 arr:cur, arr:key:{kid}만 다룬다(sale:·mode: 키는 건드리지 않는다, ADR-0219 결정 4).
// 값은 어디에도 찍지 않고 명령줄에도 싣지 않는다(권한 좁은 임시 파일을 --cli-input-json으로 넘기고 지운다). 오류 문구는 고정 글과 AWS 오류 이름만이다.
// 종료 코드: 0 같음·없어서 넣음·교체, 3 달라서 다시 넣음(경보), 2 인자·호출 실패.
//   node tools/edge/sync-kvs-keys.mjs --kvs-arn <저장소 ARN> --entries <항목 JSON 파일> [--rotate]
// --rotate: 이번 배포가 지금 kid를 바꾸는 정상 교체다(arr:cur가 달라도 경보하지 않는다. 서명 키 값이 다르면 그래도 경보한다).
// 항목 JSON: { "arr:cur": "k2", "arr:key:k1": "<키 글자>", "arr:key:k2": "<키 글자>" }
// 실제 저장소는 aws cloudfront-keyvaluestore CLI로 부른다(AWS 계정이 생겨 배포할 때 동작을 확인한다, HOT-012).
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const CUR = 'arr:cur';
const KEY_NAME = /^arr:key:([A-Za-z0-9_-]{1,32})$/;
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_VALUE = /^[A-Za-z0-9_-]+$/;
const MIN_KEY_BYTES = 32;

/** 값·명령줄을 싣지 않는 오류(이름만) */
class KvsError extends Error {
  constructor(message, awsName) {
    super(awsName ? `${message}(${awsName})` : message);
    this.name = 'KvsError';
    this.awsName = awsName;
  }
}

/** aws 오류 문구에서 오류 이름만 뽑는다. An error occurred (Name) when calling… */
const awsErrorName = (e) => /\(([A-Za-z]+(?:Exception|Error))\)/.exec(String(e?.stderr ?? ''))?.[1] ?? null;

/** aws 명령을 부르는 저장소 드라이버. 값은 임시 파일로 넘기고, 응답은 값으로만 쓴다. exec는 시험이 바꿔 넣는다 */
export const awsDriver = (arn, exec = promisify(execFile)) => {
  const aws = async (op, args) => {
    try {
      return await exec('aws', ['cloudfront-keyvaluestore', op, ...args, '--output', 'json'], { maxBuffer: 1_000_000 });
    } catch (e) {
      throw new KvsError(`엣지 저장소 호출 실패: ${op}`, awsErrorName(e));
    }
  };
  const parsed = (op, stdout) => {
    try {
      return JSON.parse(stdout || '{}');
    } catch {
      throw new KvsError(`엣지 저장소 응답을 읽지 못했다: ${op}`);
    }
  };
  return {
    async get(key) {
      try {
        return parsed('get-key', (await aws('get-key', ['--kvs-arn', arn, '--key', key])).stdout).Value ?? null;
      } catch (e) {
        if (e.awsName === 'ResourceNotFoundException') return null;
        throw e;
      }
    },
    async put(key, value, etag) {
      const dir = mkdtempSync(join(tmpdir(), 'kvs-put-'));
      const file = join(dir, 'input.json');
      try {
        writeFileSync(file, JSON.stringify({ KvsARN: arn, Key: key, Value: value, IfMatch: etag }), { mode: 0o600 });
        await aws('put-key', ['--cli-input-json', `file://${file}`]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async etag() {
      return parsed('describe-key-value-store', (await aws('describe-key-value-store', ['--kvs-arn', arn])).stdout).ETag;
    },
  };
};

/** 항목의 이름·꼴을 본다(값은 문구에 싣지 않는다). 지금 kid는 그 키가 항목에 있어야 한다 */
function validate(entries) {
  for (const [k, v] of Object.entries(entries)) {
    if (k !== CUR && !KEY_NAME.test(k)) throw new KvsError('저장소 키 이름이 규칙에 맞지 않는다');
    if (typeof v !== 'string' || v.length === 0) throw new KvsError('저장소 키의 값이 비었다');
    if (k === CUR && !KID.test(v)) throw new KvsError('arr:cur의 꼴이 kid가 아니다');
    if (k !== CUR && (!KEY_VALUE.test(v) || Buffer.from(v, 'base64url').length < MIN_KEY_BYTES)) throw new KvsError('서명 키는 base64url 글자로 32바이트 이상이어야 한다');
  }
  const cur = entries[CUR];
  if (cur !== undefined && entries[`arr:key:${cur}`] === undefined) throw new KvsError('arr:cur가 가리키는 키가 항목에 없다');
}

/**
 * 원하는 항목을 저장소와 맞춘다. 서명 키를 먼저 넣고 arr:cur를 마지막에 넣는다(엣지가 없는 키를 가리키지 않게).
 * 없는 키는 missing, 다른 키는 changed(경보), arr:cur만 다르고 교체 뜻이 있으면 rotated다.
 */
export async function syncEntries(driver, entries, { rotating = false } = {}) {
  validate(entries);
  const names = Object.keys(entries).sort((a, b) => (a === CUR) - (b === CUR));
  const report = { missing: [], changed: [], same: [], rotated: [] };
  let etag = await driver.etag();
  for (const k of names) {
    const cur = await driver.get(k);
    if (cur === entries[k]) {
      report.same.push(k);
      continue;
    }
    if (cur === null) report.missing.push(k);
    else if (k === CUR && rotating) report.rotated.push(k);
    else report.changed.push(k);
    await driver.put(k, entries[k], etag);
    etag = await driver.etag();
  }
  return report;
}

/** 경보 문구: 키 이름만 싣는다 */
export function reportLines(report) {
  const out = [];
  if (report.missing.length > 0) out.push(`엣지 저장소에 없던 키를 넣었다: ${report.missing.join(', ')}`);
  if (report.rotated.length > 0) out.push(`지금 서명 kid를 교체했다: ${report.rotated.join(', ')}`);
  if (report.changed.length > 0) out.push(`경보: 엣지 저장소의 키가 Secrets Manager와 달라 다시 넣었다(누군가 바꿨을 수 있다): ${report.changed.join(', ')}`);
  return out;
}

export async function main(argv, { exec, console: log = console } = {}) {
  const at = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const arn = at('--kvs-arn');
  const file = at('--entries');
  if (!arn || !file) {
    log.error('쓰는 법: node tools/edge/sync-kvs-keys.mjs --kvs-arn <저장소 ARN> --entries <항목 JSON 파일> [--rotate]');
    return 2;
  }
  let entries;
  try {
    entries = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    log.error('항목 파일을 읽지 못했다(JSON 꼴을 확인한다)');
    return 2;
  }
  try {
    const report = await syncEntries(awsDriver(arn, exec), entries, { rotating: argv.includes('--rotate') });
    for (const line of reportLines(report)) log.error(line);
    return report.changed.length > 0 ? 3 : 0;
  } catch (e) {
    log.error(e instanceof KvsError ? e.message : '엣지 저장소 맞추기 실패');
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));

#!/usr/bin/env node
// 외부 보안 검사 도구의 고정 표와 실행(docs/devops.md §3.1 gitleaks·Trivy 줄·§4.4 '외부 보안 검사 게이트', ADR-0263 결정 1·2·7,
// BUILD_ORDER BAS-011 ②). 판정은 하지 않는다: 결과 파일(SARIF)을 만들고, 막는 판정은 tools/ci/scan-gate.mjs가 한다.
// - 고정 표(PINS)가 판·주소·SHA-256·이미지 다이제스트의 정본이다(처음 값과 찾은 방법은 ADR-0263 결정 1). 올릴 때는 게시 뒤 3일이 지난 판을
//   고르고(devops §4.4 '새 버전 대기') 체크섬·다이제스트를 공식 배포에서 다시 읽는다(devops §3.1). 워크플로에는 이미지 글을 두지 않는다.
// - gitleaks: GitHub 릴리스의 linux 묶음을 Node 내장 fetch로 받아 SHA-256을 맞춘 뒤에만 풀고, 묶음에서 실행 파일 gitleaks 하나만 꺼낸다.
//   받아 둔 묶음도 쓸 때마다 다시 잰다(옆 파일을 믿지 않는다). 검사 전에 실행 때 만든 미끼 비밀을 같은 설정으로 찾게 해, 못 찾으면 이력을
//   보지 않고 실패한다. 이력은 지금 커밋에서 닿는 전체(--full-history HEAD)를, 예약 실행(--all-refs)은 모든 가지·태그(--all)를 보고, 병합 커밋의
//   차이(-m)도 본다. 보고서에는 비밀을 가린다(--redact). 줄 안 허용 주석(gitleaks:allow)은 받지 않는다(허용은 설정 파일과 무시 목록에만, ADR-0263 결정 2).
//   허용 블록은 targetRules가 있고(경로와 함께 AND면 예외) 값 꼴은 ^…$로 묶으며 넓은 꼴과 8자 [가정] 미만 stopwords를 두지 않는다(ADR-0263 결정 13 ⑤).
// - Trivy: 다이제스트 고정 이미지(GHCR)를 docker run --network none으로 띄우고 검사 규칙·취약점 자료를 받지 않는다(--skip-check-update,
//   이미지 검사는 --skip-db-update·--offline-scan도). 설정 검사는 저장소를 읽기 전용으로 붙이고, 결과 SARIF는 표준 출력으로 받는다.
//   두 검사 모두 실행 때 만든 미끼(높음이 나와야 할 설정, 가짜 비밀을 담은 작은 이미지 묶음)를 같은 인자로 먼저 돌려 도구가 실제로 보는지 확인하고,
//   못 찾으면 대상을 보지 않고 실패한다. IaC 대상 안의 Trivy 줄 안 무시 주석(trivy:ignore·tfsec:ignore)은 막는다(ADR-0263 결정 13 ③④).
// 쓰는 법:
//   node tools/ci/scan-tools.mjs fetch-gitleaks --out <폴더>
//   node tools/ci/scan-tools.mjs gitleaks --bin <gitleaks> --sarif <결과 파일> [--work <미끼 폴더>] [--repo <저장소>] [--all-refs]
//        종료 코드: gitleaks의 이력 검사 종료 코드(0 누출 없음, GITLEAKS_LEAK_EXIT 누출 있음, 그 밖은 오류), 미끼·설정 실패는 DECOY_EXIT
//   node tools/ci/scan-tools.mjs trivy-config --out <폴더> [--repo <저장소>]   → <폴더>/<대상 이름>.sarif
//   node tools/ci/scan-tools.mjs trivy-image --input <OCI 묶음 tar> --sarif <결과 파일> [--work <미끼 폴더>]
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { runIfMain } from './entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 고정 표(ADR-0263 결정 1, 2026-11-10 조회). 판을 올리면 체크섬·다이제스트를 공식 배포에서 다시 읽는다 */
export const PINS = Object.freeze({
  gitleaks: Object.freeze({
    version: '8.30.1',
    assets: Object.freeze({
      x64: Object.freeze({
        url: 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz',
        sha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
      }),
      arm64: Object.freeze({
        url: 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_arm64.tar.gz',
        sha256: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
      }),
    }),
  }),
  // 여러 플랫폼 묶음 다이제스트(amd64·arm64 러너가 자기 것을 고른다). Docker Hub aquasec/trivy:0.76.1과 같은 값이고 GHCR에서 받는다(ADR-0263 결정 13 ④)
  trivy: Object.freeze({ image: 'ghcr.io/aquasecurity/trivy', version: '0.76.1', digest: 'sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c' }),
});

/** gitleaks가 누출을 찾았을 때의 종료 코드. 오류(설정·git 실패)는 1로 끝나므로 누출과 겹치지 않는 값을 준다 */
export const GITLEAKS_LEAK_EXIT = 99;
/** 미끼 비밀을 못 찾았거나 설정·무시 목록이 틀려 이력을 보지 않고 끝낼 때의 종료 코드 */
export const DECOY_EXIT = 3;
/** 미끼가 걸려야 하는 기본 규칙(gitleaks 기본 설정의 GitHub 개인 접근 토큰) */
export const DECOY_RULE = 'github-pat';

export const GITLEAKS_CONFIG = join(HERE, 'gitleaks.toml');
export const GITLEAKS_IGNORE = join(HERE, 'gitleaks-ignore');
export const TRIVY_SECRET_CONFIG = join(HERE, 'trivy-secret.yaml');
/** Trivy 0.76.1의 내장 비밀 허용 규칙(pkg/fanal/secret/builtin-allow-rules.go). 이미지 비밀 검사는 trivy-secret.yaml의 disable-allow-rules로 모두 끈다 */
export const TRIVY_BUILTIN_ALLOW_RULES = Object.freeze(['dist-info', 'tests', 'examples', 'vendor', 'usr-dirs', 'locale-dir', 'markdown', 'node.js', 'golang', 'python', 'rubygems', 'wordpress', 'anaconda-log']);

/** 컨테이너 안에서 저장소를 붙이는 자리. 판정 도구가 SARIF 경로를 저장소 기준으로 바꿀 때 쓴다 */
export const SRC_MOUNT = '/src';

/**
 * Trivy 설정 검사의 대상(ADR-0263 결정 7, devops §4.4 '외부 보안 검사 게이트'): infra/, deploy/(로컬 kind 전용 deploy/local 뺌),
 * 운영 이미지의 Dockerfile(services/, packages/platform/template). 도구·부하 시험용 Dockerfile(tools/·loadtest/)은 운영으로 가지 않아 뺀다.
 * 공용 차트는 값이 없으면 그리지 못해 건너뛰므로(서비스 이름·이미지가 필수) 이미 있는 v0 배포 값으로 그려 보고, 모든 템플릿의 켜는 조건을 켠 CI 값
 * 파일(tools/ci/trivy-chart-values.yaml)로도 그린다(ADR-0263 결정 13 ④).
 */
export const IAC_TARGETS = Object.freeze([
  Object.freeze({ name: 'infra', path: 'infra' }),
  Object.freeze({ name: 'deploy', path: 'deploy', skipDirs: Object.freeze(['deploy/local']), helmValues: Object.freeze(['deploy/envs/local/v0-monolith.yaml']) }),
  Object.freeze({ name: 'services-dockerfile', path: 'services', scanners: Object.freeze(['dockerfile']) }),
  Object.freeze({ name: 'template-dockerfile', path: 'packages/platform/template', scanners: Object.freeze(['dockerfile']) }),
  Object.freeze({ name: 'chart-ci', path: 'deploy/charts', helmValues: Object.freeze(['tools/ci/trivy-chart-values.yaml']) }),
]);

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const trivyImage = (pins = PINS) => `${pins.trivy.image}@${pins.trivy.digest}`;

/** 이 기계 아키텍처의 gitleaks 묶음. 표에 없으면 던진다 */
export function gitleaksAsset(arch = process.arch, pins = PINS) {
  const a = pins.gitleaks.assets[arch];
  if (!a) throw new Error(`gitleaks 고정 표에 ${arch} 묶음이 없다(linux x64·arm64만)`);
  return a;
}

/**
 * gzip을 푼 tar에서 이름이 name인 일반 파일 하나의 내용을 꺼낸다(다른 항목은 쓰지 않는다). 없거나 둘 이상이거나 일반 파일이 아니면 던진다
 * @param {Buffer} tar
 * @param {string} name
 */
export function extractTarMember(tar, name) {
  /** @type {Buffer | null} */
  let found = null;
  let count = 0;
  let longName = null;
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(str(124, 136).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('tar 머리의 크기를 읽지 못했다');
    const type = str(156, 157) || '0';
    const prefix = str(345, 500);
    const body = tar.subarray(off + 512, off + 512 + size);
    const entry = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type !== 'x' && type !== 'g' && entry.replace(/^\.\//, '') === name) {
      count++;
      if (type !== '0') throw new Error(`묶음의 ${name}이 일반 파일이 아니다(종류 ${type})`);
      found = Buffer.from(body);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  if (count === 0 || !found) throw new Error(`묶음에 ${name}이 없다`);
  if (count > 1) throw new Error(`묶음에 ${name}이 ${count}개 있다`);
  return found;
}

async function httpsDownload(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`받기 실패: ${url} HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * gitleaks 묶음을 받아(또는 받아 둔 것을 다시 재어) SHA-256이 고정 값과 같을 때만 실행 파일을 꺼낸다. 다르면 풀지 않고 던진다
 * @param {{ out: string, arch?: string, pins?: typeof PINS, download?: (url: string) => Promise<Buffer> }} o
 * @returns {Promise<{ bin: string, archive: string, version: string }>}
 */
export async function fetchGitleaks({ out, arch = process.arch, pins = PINS, download = httpsDownload }) {
  const asset = gitleaksAsset(arch, pins);
  if (!asset.url.startsWith('https://')) throw new Error(`https 주소만 받는다: ${asset.url}`);
  if (!/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`고정 표의 SHA-256이 64자리 16진이 아니다: ${asset.url}`);
  const archive = join(out, basename(new URL(asset.url).pathname));
  let bytes;
  if (existsSync(archive)) {
    bytes = readFileSync(archive);
    if (sha256(bytes) !== asset.sha256) throw new Error(`받아 둔 묶음의 SHA-256이 고정 값과 다르다(풀지 않는다): ${archive}`);
  } else {
    bytes = await download(asset.url);
    if (sha256(bytes) !== asset.sha256) throw new Error(`받은 묶음의 SHA-256이 고정 값과 다르다(풀지 않는다): ${asset.url}`);
    mkdirSync(out, { recursive: true });
    writeFileSync(`${archive}.part`, bytes);
    renameSync(`${archive}.part`, archive);
  }
  const body = extractTarMember(gunzipSync(bytes), 'gitleaks');
  const bin = join(out, 'gitleaks');
  writeFileSync(`${bin}.part`, body, { mode: 0o755 });
  renameSync(`${bin}.part`, bin);
  return { bin, archive, version: pins.gitleaks.version };
}

// ---------- gitleaks 설정·무시 목록 ----------

/**
 * gitleaks.toml을 읽는다. 이 저장소가 쓰는 꼴만 받는다: 주석, [extend], [[allowlists]], 한 줄 키 = 값(글자·참거짓·글자 목록, 목록은 여러 줄도).
 * 그 밖의 꼴(사용자 규칙 [[rules]], 규칙 끄기 등)은 던진다. 판정이 아니라 설정을 좁게 지키는 검사다
 * @returns {{ extend: Record<string, unknown>, allowlists: Record<string, unknown>[] }}
 */
export function readGitleaksConfig(text) {
  const lines = String(text).split(/\r?\n/);
  const out = { extend: {}, allowlists: [] };
  /** @type {Record<string, unknown> | null} */
  let table = null;
  const value = (raw, at) => {
    const v = raw.trim();
    if (v === 'true' || v === 'false') return v === 'true';
    if (v.startsWith("'''")) {
      const m = /^'''([\s\S]*?)'''$/.exec(v);
      if (!m) throw new Error(`${at}: 글자가 닫히지 않았다`);
      return m[1];
    }
    if (v.startsWith("'")) {
      const m = /^'([^']*)'$/.exec(v);
      if (!m) throw new Error(`${at}: 글자가 닫히지 않았다`);
      return m[1];
    }
    if (v.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
      if (!m) throw new Error(`${at}: 글자가 닫히지 않았다`);
      return JSON.parse(`"${m[1]}"`);
    }
    if (v.startsWith('[')) {
      const inner = v.replace(/^\[/, '').replace(/\]$/, '');
      const items = [];
      const re = /\s*('''[\s\S]*?'''|'[^']*'|"(?:[^"\\]|\\.)*")\s*(,|$)/gy;
      let m;
      let pos = 0;
      while (pos < inner.length && (m = re.exec(inner))) {
        items.push(value(m[1], at));
        pos = re.lastIndex;
        if (m[2] === '') break;
      }
      if (inner.slice(pos).trim() !== '') throw new Error(`${at}: 목록에는 글자만 둔다`);
      return items;
    }
    throw new Error(`${at}: 모르는 값 꼴: ${v}`);
  };
  for (let i = 0; i < lines.length; i++) {
    const at = `gitleaks.toml:${i + 1}`;
    const line = lines[i].replace(/^\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    if (line === '[extend]') {
      table = out.extend;
      continue;
    }
    if (line === '[[allowlists]]') {
      table = {};
      out.allowlists.push(table);
      continue;
    }
    if (line.startsWith('[')) throw new Error(`${at}: 이 설정은 [extend]와 [[allowlists]]만 쓴다(사용자 규칙·규칙 끄기는 두지 않는다): ${line}`);
    const kv = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(line);
    if (!kv || !table) throw new Error(`${at}: 표 안의 '키 = 값' 꼴이 아니다`);
    let raw = kv[2].replace(/\s+#[^'"]*$/, '');
    // 여러 줄 목록: ]로 끝날 때까지 잇는다(줄 주석은 뗀다)
    if (raw.trim().startsWith('[') && !raw.trim().endsWith(']')) {
      while (++i < lines.length) {
        const next = lines[i].trim();
        if (next.startsWith('#') || next === '') continue;
        raw += ` ${next.replace(/\s+#[^'"]*$/, '')}`;
        if (next.endsWith(']')) break;
      }
    }
    if (kv[1] in table) throw new Error(`${at}: 키 ${kv[1]}가 겹친다`);
    table[kv[1]] = value(raw.replace(/,\s*\]$/, ']'), at);
  }
  return out;
}

/** 모든 파일·폴더를 통째로 가리키는 꼴(경로 허용 목록에 두지 않는다) */
const TOO_BROAD = /^(\^?\.?[*+]?\$?|\^?\(\?:?\.\*\)\$?|\^?\.\*\$?|\^?\.\+\$?|\^?\/?\$?|\^?\\S\*\$?|\^?\[\^\/?\]\*\$?)$/;
const ALLOWLIST_KEYS = ['description', 'condition', 'paths', 'regexes', 'regexTarget', 'stopwords', 'commits', 'targetRules'];

/**
 * gitleaks 설정의 규칙(ADR-0263 결정 2, devops §4.4): 기본 규칙을 잇고(useDefault = true, 규칙 끄기 없음), 허용 목록마다 까닭(description)과
 * 좁은 경로·꼴이 있다. 모든 파일·폴더를 통째로 가리키는 경로 꼴, 커밋 통째 허용은 두지 않는다
 * @returns {string[]} 틀린 곳(비면 맞다)
 */
export function gitleaksConfigProblems(text) {
  let c;
  try {
    c = readGitleaksConfig(text);
  } catch (e) {
    return [e.message];
  }
  const problems = [];
  if (c.extend.useDefault !== true) problems.push('[extend] useDefault = true가 없다(기본 규칙을 잇는다)');
  for (const k of Object.keys(c.extend)) if (k !== 'useDefault') problems.push(`[extend]에 ${k}를 두지 않는다(기본 규칙을 끄거나 다른 설정을 잇지 않는다)`);
  c.allowlists.forEach((a, i) => {
    const at = `허용 목록 ${i + 1}번째`;
    for (const k of Object.keys(a)) if (!ALLOWLIST_KEYS.includes(k)) problems.push(`${at}의 모르는 키: ${k}`);
    if (typeof a.description !== 'string' || a.description.trim().length < 10) problems.push(`${at}에 까닭(description)이 없다`);
    if ('commits' in a) problems.push(`${at}: 커밋 통째 허용(commits)은 두지 않는다. 교체를 마친 누출은 gitleaks-ignore에 지문으로 둔다`);
    const paths = a.paths ?? [];
    const regexes = a.regexes ?? [];
    const stopwords = a.stopwords ?? [];
    if (![paths, regexes, stopwords].every(Array.isArray)) problems.push(`${at}의 paths·regexes·stopwords는 글자 목록이다`);
    else {
      if (paths.length + regexes.length + stopwords.length === 0) problems.push(`${at}에 경로·꼴이 없다`);
      // 경로만으로 풀면 그 파일의 진짜 비밀도 지나간다. 경로는 값 꼴과 함께(condition = 'AND')만 쓴다
      if (paths.length > 0 && regexes.length + stopwords.length === 0) problems.push(`${at}: 경로만으로 푸는 블록은 두지 않는다(값 꼴 regexes와 함께 쓴다)`);
      if (paths.length > 0 && a.condition !== 'AND') problems.push(`${at}: 경로를 쓰면 condition = 'AND'다(기본 OR은 경로만 맞아도 푼다)`);
      for (const p of paths) {
        if (TOO_BROAD.test(p.trim())) problems.push(`${at}의 경로 꼴 ${JSON.stringify(p)}는 모든 파일·폴더를 가리킨다`);
        try {
          new RegExp(p.replace(/^\(\?i\)/, ''));
        } catch {
          problems.push(`${at}의 경로 꼴 ${JSON.stringify(p)}가 정규식이 아니다`);
        }
      }
      for (const r of regexes) if (TOO_BROAD.test(r.trim())) problems.push(`${at}의 꼴 ${JSON.stringify(r)}는 모든 글자를 받는다`);
      // targetRules: 규칙을 좁히지 않은 블록은 모든 규칙의 결과를 푼다. 경로와 함께 AND로 좁힌 블록만 예외다
      const rules = a.targetRules;
      const pathAnd = paths.length > 0 && a.condition === 'AND';
      if (rules !== undefined && (!Array.isArray(rules) || rules.some((x) => typeof x !== 'string' || x === ''))) problems.push(`${at}의 targetRules는 규칙 ID 목록이다`);
      if (!pathAnd && (!Array.isArray(rules) || rules.length === 0)) problems.push(`${at}에 targetRules가 없다(어느 규칙의 오탐인지 좁힌다. 경로와 함께 condition = 'AND'로 좁혔으면 없어도 된다)`);
      for (const r of regexes) for (const m of valuePatternProblems(r)) problems.push(`${at}의 꼴 ${JSON.stringify(r)}: ${m}`);
      for (const w of stopwords) if (typeof w !== 'string' || w.length < STOPWORD_MIN) problems.push(`${at}의 stopwords ${JSON.stringify(w)}는 ${STOPWORD_MIN}자 미만이다(짧은 낱말은 그 글자가 든 비밀을 모두 푼다)`);
    }
  });
  return problems;
}

/** stopwords의 최소 길이 [가정](devops §4.4 '리뷰 뒤 더한 규칙' ⑤) */
const STOPWORD_MIN = 8;

/**
 * 값 꼴(regexes)의 규칙: (?i)를 뗀 꼴이 ^로 시작해 $로 끝나고, 맨 위에 |가 없으며(묶음 밖으로 빠져나간다), 넓은 글자(아무 글자나 받는 한 자리)를
 * 되풀이하지 않는다. 넓은 글자는 .·\S·\w·\W·\D, 부정 글자 묶음([^…]), \S·\w·\W·\D가 든 글자 묶음([\s\S]·[\S] 등), 그런 것이 든 묶음((?:.)·(.|\n))이고,
 * 되풀이는 *·+·?와 상한이 있든 없든 {n,m}·{n,}·{n}(1보다 큰 것)이다(devops §4.4 '리뷰 뒤 더한 규칙' ⑤, 다시 보기 2)
 * @returns {string[]}
 */
export function valuePatternProblems(pattern) {
  const out = [];
  const body = String(pattern).replace(/^\(\?i\)/, '');
  try {
    new RegExp(body);
  } catch {
    return ['정규식이 아니다'];
  }
  if (!body.startsWith('^') || !body.endsWith('$') || body.endsWith('\\$')) out.push('값 꼴은 ^…$로 처음과 끝을 묶는다');
  const broad = [];
  if (scanPattern(body, broad, true)) out.push('맨 위에 |를 두지 않는다(^(?:a|b)$처럼 묶는다)');
  if (broad.length > 0) out.push(`넓은 꼴(${[...new Set(broad)].join(' ')})이 있다`);
  return out;
}

const BROAD_ESCAPES = new Set(['S', 'w', 'W', 'D']);
/** 글자 묶음 [...]의 끝(닫는 ]의 자리). 맨 앞 ]·^] 와 이스케이프를 건너 읽는다 */
function classEnd(body, i) {
  let j = i + 1;
  if (body[j] === '^') j++;
  if (body[j] === ']') j++;
  for (; j < body.length; j++) {
    if (body[j] === '\\') j++;
    else if (body[j] === ']') return j;
  }
  return -1;
}
/** 묶음 (...)의 끝(짝이 맞는 닫는 괄호 자리) */
function groupEnd(body, i) {
  let depth = 0;
  for (let j = i; j < body.length; j++) {
    const c = body[j];
    if (c === '\\') j++;
    else if (c === '[') {
      const e = classEnd(body, j);
      if (e < 0) return -1;
      j = e;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}
/** 되풀이 표시(*·+·?·{…}, 뒤의 ? 포함)의 길이와 한 자리보다 많이 받는지(many). 없으면 null */
function quantifierAt(body, i) {
  const m = /^(?:([*+?])|\{(\d+)(,(\d*))?\})\??/.exec(body.slice(i));
  if (!m) return null;
  let many;
  if (m[1]) many = m[1] !== '?';
  else {
    const lo = Number(m[2]);
    const hi = m[3] === undefined ? lo : m[4] === '' ? Infinity : Number(m[4]);
    many = hi > 1;
  }
  return { length: m[0].length, many };
}
/**
 * 꼴을 원자 단위로 읽어 넓은 글자의 되풀이를 broad에 담고, 넓은 글자가 하나라도 있었는지를 돌려준다(묶음 판정용).
 * top이 참이면 맨 위 |가 있었는지를 돌려준다
 */
function scanPattern(body, broad, top = false) {
  let hasBroad = false;
  let topBar = false;
  for (let i = 0; i < body.length; ) {
    const c = body[i];
    let atom;
    let isBroad = false;
    if (c === '\\') {
      atom = body.slice(i, i + 2);
      isBroad = BROAD_ESCAPES.has(body[i + 1]);
      i += 2;
    } else if (c === '[') {
      const e = classEnd(body, i);
      if (e < 0) break;
      atom = body.slice(i, e + 1);
      isBroad = atom.startsWith('[^') || /\\[SwWD]/.test(atom);
      i = e + 1;
    } else if (c === '(') {
      const e = groupEnd(body, i);
      if (e < 0) break;
      atom = body.slice(i, e + 1);
      const inner = atom.slice(1, -1).replace(/^\?(?:[:=!]|<[=!]|<\w+>)/, '');
      isBroad = scanPattern(inner, broad);
      i = e + 1;
    } else {
      if (c === '|' && top) topBar = true;
      atom = c;
      isBroad = c === '.';
      i += 1;
    }
    if (isBroad) hasBroad = true;
    const q = quantifierAt(body, i);
    if (q) {
      if (isBroad && q.many) broad.push(`${atom}${body.slice(i, i + q.length)}`);
      i += q.length;
    }
  }
  return top ? topBar : hasBroad;
}

/**
 * 지문 무시 목록(gitleaks-ignore)의 규칙(ADR-0263 결정 2): 지문 줄(커밋:파일:규칙:줄)마다 바로 앞 주석에 이슈 번호(#번호)와 교체한 날(YYYY-MM-DD)이 있다
 * @returns {string[]} 틀린 곳(비면 맞다)
 */
export function gitleaksIgnoreProblems(text) {
  const problems = [];
  const lines = String(text).split(/\r?\n/);
  let note = null;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') {
      note = null;
      return;
    }
    if (line.startsWith('#')) {
      note = line;
      return;
    }
    const at = `gitleaks-ignore:${i + 1}`;
    if (!/^[0-9a-f]{40}:[^:]+:[a-z0-9-]+:\d+$/.test(line)) problems.push(`${at}: 지문은 '커밋 40자리:파일:규칙:줄' 꼴이다`);
    if (!note || !/#\d+\b/.test(note) || !/\b\d{4}-\d{2}-\d{2}\b/.test(note)) problems.push(`${at}: 바로 앞 주석에 이슈 번호(#번호)와 교체한 날(YYYY-MM-DD)이 없다`);
    note = null;
  });
  return problems;
}

// ---------- gitleaks 실행 ----------

const COMMON = (config, sarif) => ['--config', config, '--report-format', 'sarif', '--report-path', sarif, '--redact', '--exit-code', String(GITLEAKS_LEAK_EXIT), '--no-banner', '--no-color', '--ignore-gitleaks-allow'];

/**
 * 이력 검사 인자: 지금 커밋에서 닿는 전체 이력(allRefs면 모든 가지·태그 --all), 병합 커밋의 차이(-m), 설정·무시 목록, 가림, 누출 종료 코드
 */
export function gitleaksHistoryArgs({ config = GITLEAKS_CONFIG, ignore = GITLEAKS_IGNORE, sarif, repo = '.', allRefs = false }) {
  return ['git', ...COMMON(config, sarif), '--gitleaks-ignore-path', ignore, '--log-opts', `--full-history -m ${allRefs ? '--all' : 'HEAD'}`, repo];
}

/** 미끼 검사 인자: 같은 설정으로 미끼 폴더를 본다 */
export function gitleaksDecoyArgs({ config = GITLEAKS_CONFIG, sarif, dir }) {
  return ['dir', ...COMMON(config, sarif), dir];
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** 실행 때 만든 미끼 비밀. 저장소에 비밀 꼴 글자를 두지 않도록 조각을 이어 만든다 */
export function decoySecret() {
  return ['g', 'h', 'p', '_'].join('') + [...randomBytes(36)].map((b) => BASE62[b % BASE62.length]).join('');
}

/** SARIF 글에서 그 규칙의 결과가 있는가(미끼 확인용. 판정은 scan-gate.mjs) */
function sarifHasRule(text, rule) {
  try {
    const j = JSON.parse(text);
    return Array.isArray(j?.runs) && j.runs.some((r) => Array.isArray(r?.results) && r.results.some((x) => x?.ruleId === rule));
  } catch {
    return false;
  }
}

export class DecoyError extends Error {}

const defaultRun = (bin, args) => spawnSync(bin, args, { stdio: ['ignore', 'inherit', 'inherit'] });

/**
 * 미끼를 먼저 찾게 하고, 찾았을 때만 이력을 본다. 미끼를 못 찾거나 설정·무시 목록이 틀리면 DecoyError(이력은 보지 않는다)
 * @param {{ bin: string, sarif: string, work: string, repo?: string, config?: string, ignore?: string, run?: (bin: string, args: string[]) => { status: number | null } }} o
 * @returns {number} 이력 검사의 종료 코드
 */
export function runGitleaks({ bin, sarif, work, repo = '.', config = GITLEAKS_CONFIG, ignore = GITLEAKS_IGNORE, run = defaultRun, allRefs = false }) {
  // gitleaks는 검사하는 저장소 뿌리의 .gitleaksignore도 스스로 읽는다. 무시 목록은 tools/ci/gitleaks-ignore 하나뿐이다
  if (existsSync(join(repo, '.gitleaksignore'))) throw new DecoyError(`저장소 뿌리의 .gitleaksignore는 쓰지 않는다(무시 목록은 ${GITLEAKS_IGNORE} 하나다): ${join(repo, '.gitleaksignore')}`);
  const configProblems = gitleaksConfigProblems(readFileSync(config, 'utf8'));
  const ignoreProblems = gitleaksIgnoreProblems(readFileSync(ignore, 'utf8'));
  if (configProblems.length || ignoreProblems.length) throw new DecoyError(`gitleaks 설정·무시 목록이 규칙에 맞지 않는다: ${[...configProblems, ...ignoreProblems].join('; ')}`);
  const decoyDir = join(work, 'decoy');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(decoyDir, { recursive: true });
  const decoySarif = join(work, 'decoy.sarif');
  writeFileSync(join(decoyDir, 'settings.js'), `export const githubToken = '${decoySecret()}';\n`);
  try {
    const d = run(bin, gitleaksDecoyArgs({ config, sarif: decoySarif, dir: decoyDir }));
    const found = existsSync(decoySarif) && sarifHasRule(readFileSync(decoySarif, 'utf8'), DECOY_RULE);
    if (d.status !== GITLEAKS_LEAK_EXIT || !found) {
      throw new DecoyError(`실행 때 만든 미끼 비밀(${DECOY_RULE})을 찾지 못했다(종료 코드 ${d.status}, 결과 ${found ? '있음' : '없음'}). 설정이 기본 규칙을 잇는지 본다`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const h = run(bin, gitleaksHistoryArgs({ config, ignore, sarif, repo, allRefs }));
  return h.status ?? 1;
}

// ---------- Trivy ----------

const TRIVY_COMMON = ['--skip-check-update', '--skip-version-check', '--disable-telemetry', '--quiet', '--format', 'sarif'];

/** 설정 검사 한 대상의 docker 인자. 저장소는 읽기 전용, 네트워크 없음, 결과는 표준 출력 */
export function trivyConfigArgs({ repo, target, pins = PINS }) {
  return [
    'run', '--rm', '--network', 'none', '-v', `${repo}:${SRC_MOUNT}:ro`, trivyImage(pins),
    'config', ...TRIVY_COMMON,
    '--skip-dirs', '**/node_modules',
    ...(target.skipDirs ?? []).flatMap((d) => ['--skip-dirs', `${SRC_MOUNT}/${d}`]),
    ...(target.scanners ? ['--misconfig-scanners', target.scanners.join(',')] : []),
    ...(target.helmValues ?? []).flatMap((v) => ['--helm-values', `${SRC_MOUNT}/${v}`]),
    `${SRC_MOUNT}/${target.path}`,
  ];
}

/**
 * 설정 검사 대상이 저장소에 있는지 본다. 붙이는 자리가 틀려 빈 폴더를 보면 Trivy는 결과 없이 끝나 통과로 보이므로 먼저 막는다(닫힘 실패)
 * @returns {string[]} 틀린 곳
 */
export function missingIacTargets(repo, targets = IAC_TARGETS) {
  const out = [];
  for (const t of targets) {
    const dir = join(repo, t.path);
    let entries = null;
    try {
      entries = readdirSync(dir);
    } catch {
      out.push(`설정 검사 대상 폴더가 없다: ${t.path}`);
    }
    if (entries?.length === 0) out.push(`설정 검사 대상 폴더가 비었다: ${t.path}`);
    for (const v of t.helmValues ?? []) if (!existsSync(join(repo, v))) out.push(`차트를 그릴 값 파일이 없다: ${v}`);
  }
  return out;
}

/** 이미지 비밀 검사의 docker 인자: OCI 묶음과 비밀 규칙 설정을 읽기 전용으로 붙이고 secret 검사만, 자료·규칙을 받지 않는다 */
export function trivyImageArgs({ input, secretConfig = TRIVY_SECRET_CONFIG, pins = PINS }) {
  const file = resolve(input);
  return [
    'run', '--rm', '--network', 'none', '-v', `${dirname(file)}:/in:ro`, '-v', `${resolve(secretConfig)}:/cfg/trivy-secret.yaml:ro`, trivyImage(pins),
    'image', '--input', `/in/${basename(file)}`, '--scanners', 'secret', '--secret-config', '/cfg/trivy-secret.yaml',
    '--skip-db-update', '--skip-java-db-update', '--offline-scan', ...TRIVY_COMMON,
  ];
}

/** docker를 돌려 표준 출력(SARIF)을 돌려준다. 0이 아니게 끝나거나 출력이 비면 던진다 */
function dockerStdout(args) {
  const r = spawnSync('docker', args, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Trivy가 ${r.status}로 끝났다(docker ${args.slice(0, 8).join(' ')} …)`);
  if (!r.stdout || r.stdout.length === 0) throw new Error('Trivy 결과가 비었다');
  return r.stdout;
}

const DOCKERFILE = /^(?:Dockerfile|Containerfile)(?:\..+)?$|\.(?:Dockerfile|Containerfile)$/i;
const INLINE_IGNORE = /\b(?:trivy|tfsec):ignore\b/i;

/**
 * IaC 대상(과 그 차트 값 파일) 안의 Trivy 줄 안 무시 주석(trivy:ignore·tfsec:ignore). 예외는 예외 파일로만 두므로 찾으면 막는다.
 * Dockerfile만 보는 대상은 Dockerfile만, node_modules·건너뛰는 폴더는 보지 않는다
 * @returns {string[]} '저장소 기준 경로:줄'
 */
export function findInlineIgnores(repo, targets = IAC_TARGETS) {
  const found = new Set();
  const scan = (rel) => {
    let text;
    try {
      text = readFileSync(join(repo, rel), 'utf8');
    } catch {
      return;
    }
    text.split(/\r?\n/).forEach((l, i) => {
      if (INLINE_IGNORE.test(l)) found.add(`${rel}:${i + 1}`);
    });
  };
  for (const t of targets) {
    const skip = new Set((t.skipDirs ?? []).map((d) => d.replace(/\/$/, '')));
    const walk = (rel) => {
      let entries;
      try {
        entries = readdirSync(join(repo, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && !skip.has(r)) walk(r);
        } else if (e.isFile() && (!t.scanners?.includes('dockerfile') || DOCKERFILE.test(e.name))) scan(r);
      }
    };
    walk(t.path);
    for (const v of t.helmValues ?? []) scan(v);
  }
  return [...found].sort();
}

/** SARIF 글을 읽어 결과마다 [경로, 등급]. 못 읽으면 null */
function sarifFindings(text) {
  try {
    const j = JSON.parse(String(text));
    if (!Array.isArray(j?.runs)) return null;
    const out = [];
    for (const run of j.runs) {
      const sev = new Map((run?.tool?.driver?.rules ?? []).map((r) => [r.id, Number(r?.properties?.['security-severity'])]));
      for (const r of run?.results ?? []) out.push({ rule: r.ruleId, uri: String(r?.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? ''), severity: sev.get(r.ruleId) });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 설정 검사 미끼: 높음이 나와야 할 Dockerfile(USER 없음, root로 돈다), Terraform(공개 저장소), 값 파일로만 그려지는 작은 차트(required로 값을 묻고,
 * 그 값이 권한 상승 컨테이너를 켠다). 차트를 그리지 못하면 Trivy는 차트를 건너뛰고 결과 없이 끝나므로 그 경우도 잡는다(다시 보기 1). 대상은 <뿌리>/decoy
 */
export const CONFIG_DECOY = Object.freeze({
  target: Object.freeze({ name: 'decoy', path: 'decoy', helmValues: Object.freeze(['decoy/chart-values.yaml']) }),
  files: Object.freeze({
    Dockerfile: 'FROM scratch\nCOPY app /app\nENTRYPOINT ["/app/run"]\n',
    'main.tf': 'resource "github_repository" "decoy" {\n  name       = "decoy"\n  visibility = "public"\n}\n',
    'chart/Chart.yaml': 'apiVersion: v2\nname: decoy\nversion: 0.1.0\n',
    'chart/templates/pod.yaml': [
      '{{- if .Values.enabled }}',
      'apiVersion: v1',
      'kind: Pod',
      'metadata:',
      '  name: {{ required "name이 필요하다" .Values.name }}',
      'spec:',
      '  containers:',
      '    - name: app',
      '      image: registry.invalid/decoy@sha256:0000000000000000000000000000000000000000000000000000000000000000',
      '      securityContext:',
      '        privileged: {{ .Values.privileged }}',
      '        allowPrivilegeEscalation: true',
      '{{- end }}',
      '',
    ].join('\n'),
    'chart-values.yaml': 'enabled: true\nname: decoy\nprivileged: true\n',
  }),
  /** 높음 이상이 나와야 하는 미끼 파일 */
  expect: Object.freeze(['Dockerfile', 'main.tf', 'chart/templates/pod.yaml']),
});

/** 설정 검사 미끼 결과에서 미끼 파일마다 등급 7.0 이상 결과가 있는가 */
export function configDecoyProblems(text) {
  const f = sarifFindings(text);
  if (f === null) return ['설정 검사 미끼 결과를 읽지 못했다'];
  return CONFIG_DECOY.expect
    .filter((name) => !f.some((x) => (x.uri === name || x.uri.endsWith(`/${name}`)) && x.severity >= 7))
    .map((name) => `설정 검사 미끼 ${name}에서 높음 이상 결과가 나오지 않았다(검사 규칙이 실려 있는지, 그 꼴의 파일을 읽는지 본다)`);
}

/**
 * Trivy 설정 검사: 줄 안 무시 주석·대상 확인 → 미끼(같은 인자) → 대상마다 <out>/<이름>.sarif. 미끼가 높음을 내지 않으면 DecoyError
 * @param {{ repo: string, out: string, docker?: (args: string[]) => Buffer }} o
 */
export function runTrivyConfig({ repo, out, docker = dockerStdout }) {
  const ignores = findInlineIgnores(repo);
  if (ignores.length > 0) throw new Error(`IaC 대상 안에 Trivy 줄 안 무시 주석이 있다(예외는 tools/ci/scan-exceptions.json에만 둔다): ${ignores.join(', ')}`);
  const missing = missingIacTargets(repo);
  if (missing.length > 0) throw new Error(missing.join('; '));
  const work = mkdtempSync(join(tmpdir(), 'trivy-config-decoy-'));
  try {
    for (const [name, body] of Object.entries(CONFIG_DECOY.files)) {
      mkdirSync(dirname(join(work, CONFIG_DECOY.target.path, name)), { recursive: true });
      writeFileSync(join(work, CONFIG_DECOY.target.path, name), body);
    }
    const problems = configDecoyProblems(docker(trivyConfigArgs({ repo: work, target: CONFIG_DECOY.target })));
    if (problems.length > 0) throw new DecoyError(problems.join('; '));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  const files = [];
  for (const target of IAC_TARGETS) {
    const file = join(out, `${target.name}.sarif`);
    writeFileSync(file, docker(trivyConfigArgs({ repo, target })));
    files.push(file);
  }
  return files;
}

/** ustar 묶음(이름, 내용, 종류 '0' 파일·'5' 폴더) */
export function makeTar(entries) {
  const blocks = [];
  for (const [name, body, type = '0'] of entries) {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write(type === '5' ? '0000755\0' : '0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    const sum = [...h].reduce((a, b) => a + b, 0);
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** 이미지 비밀 검사 미끼에서 찾아야 하는 내장 규칙 */
export const IMAGE_DECOY_RULES = Object.freeze(['aws-access-key-id', 'github-pat']);
/** Trivy 내장 허용 규칙(usr-dirs·tests)이 건너뛰는 자리. 이 아래 미끼를 찾으면 그 규칙을 끈 설정이다(다시 보기 6) */
export const IMAGE_DECOY_ALLOW_PATH = 'usr/lib/peaket-decoy/test/';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * 이미지 비밀 검사 미끼: 실행 때 조립한 가짜 비밀(AWS 접근 키 ID, GitHub 개인 토큰)을 층 하나에 담은 docker save 꼴 묶음 <dir>/decoy.tar
 * @returns {string} 묶음 경로
 */
export function writeImageDecoy(dir) {
  const aws = `${['A', 'K', 'I', 'A'].join('')}${[...randomBytes(16)].map((b) => BASE32[b % 32]).join('')}`;
  const settings = `AWS_ACCESS_KEY_ID=${aws}\nGITHUB_TOKEN=${decoySecret()}\n`;
  const layer = makeTar([
    ['srv/', '', '5'],
    ['srv/decoy/', '', '5'],
    ['srv/decoy/settings.env', settings],
    ['usr/', '', '5'],
    ['usr/lib/', '', '5'],
    ['usr/lib/peaket-decoy/', '', '5'],
    [IMAGE_DECOY_ALLOW_PATH, '', '5'],
    [`${IMAGE_DECOY_ALLOW_PATH}token.env`, `GITHUB_TOKEN=${decoySecret()}\n`],
  ]);
  const config = JSON.stringify({ architecture: 'amd64', os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [`sha256:${sha256(layer)}`] }, history: [{ created_by: 'peaket image secret decoy' }] });
  const configName = `${sha256(config)}.json`;
  const manifest = JSON.stringify([{ Config: configName, RepoTags: ['peaket-decoy:latest'], Layers: ['layer.tar'] }]);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'decoy.tar');
  writeFileSync(file, makeTar([['manifest.json', manifest], [configName, config], ['layer.tar', layer]]));
  return file;
}

/** 이미지 비밀 검사 미끼 결과에서 두 내장 규칙이 모두 걸렸는가 */
export function imageDecoyProblems(text) {
  const f = sarifFindings(text);
  if (f === null) return ['이미지 비밀 검사 미끼 결과를 읽지 못했다'];
  const problems = IMAGE_DECOY_RULES.filter((id) => !f.some((x) => x.rule === id)).map((id) => `이미지 비밀 검사 미끼의 가짜 비밀(${id})을 찾지 못했다(비밀 규칙 설정이 내장 규칙을 끄거나 그 자리를 허용하는지 본다)`);
  if (!f.some((x) => x.uri.includes(IMAGE_DECOY_ALLOW_PATH))) problems.push(`내장 허용 경로(${IMAGE_DECOY_ALLOW_PATH}) 아래 미끼 비밀을 찾지 못했다(trivy-secret.yaml의 disable-allow-rules가 내장 허용 규칙을 모두 끄는지 본다)`);
  return problems;
}

/**
 * Trivy 이미지 비밀 검사: 미끼 묶음을 같은 설정으로 먼저 보고, 찾았을 때만 실제 묶음을 본다. 못 찾으면 DecoyError(결과 파일을 쓰지 않는다)
 * @param {{ input: string, sarif: string, work: string, docker?: (args: string[]) => Buffer }} o
 */
export function runTrivyImage({ input, sarif, work, docker = dockerStdout }) {
  rmSync(work, { recursive: true, force: true });
  try {
    const decoy = writeImageDecoy(work);
    const problems = imageDecoyProblems(docker(trivyImageArgs({ input: decoy })));
    if (problems.length > 0) throw new DecoyError(problems.join('; '));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const out = docker(trivyImageArgs({ input }));
  mkdirSync(dirname(sarif), { recursive: true });
  writeFileSync(sarif, out);
  return sarif;
}

// ---------- 명령줄 ----------

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      out: { type: 'string' },
      bin: { type: 'string' },
      sarif: { type: 'string' },
      work: { type: 'string' },
      repo: { type: 'string', default: '.' },
      input: { type: 'string' },
      'all-refs': { type: 'boolean', default: false },
    },
  });
  const need = (k) => {
    if (!values[k]) throw new Error(`--${k}가 없다`);
    return values[k];
  };
  if (cmd === 'fetch-gitleaks') {
    const r = await fetchGitleaks({ out: need('out') });
    console.log(`gitleaks ${r.version}: ${r.bin} (SHA-256 맞음)`);
    return 0;
  }
  if (cmd === 'gitleaks') {
    try {
      return runGitleaks({ bin: need('bin'), sarif: need('sarif'), work: values.work ?? join(process.env.RUNNER_TEMP ?? dirname(need('sarif')), 'gitleaks-decoy'), repo: values.repo, allRefs: values['all-refs'] });
    } catch (e) {
      if (!(e instanceof DecoyError)) throw e;
      console.log(process.env.GITHUB_ACTIONS === 'true' ? `::error::${e.message}` : `실패: ${e.message}`);
      return DECOY_EXIT;
    }
  }
  if (cmd === 'trivy-config' || cmd === 'trivy-image') {
    try {
      if (cmd === 'trivy-config') {
        for (const f of runTrivyConfig({ repo: resolve(values.repo), out: need('out') })) console.log(`Trivy 설정 검사(미끼 확인 뒤): ${f}`);
      } else {
        const sarif = runTrivyImage({ input: need('input'), sarif: need('sarif'), work: values.work ?? join(process.env.RUNNER_TEMP ?? dirname(need('sarif')), 'trivy-image-decoy') });
        console.log(`Trivy 이미지 비밀 검사(미끼 확인 뒤) ${values.input}: ${sarif}`);
      }
      return 0;
    } catch (e) {
      if (!(e instanceof DecoyError)) throw e;
      console.log(process.env.GITHUB_ACTIONS === 'true' ? `::error::${e.message}` : `실패: ${e.message}`);
      return DECOY_EXIT;
    }
  }
  throw new Error(`모르는 하위 명령: ${cmd ?? '(없음)'} (fetch-gitleaks·gitleaks·trivy-config·trivy-image)`);
}

// 직접 실행 판별이 틀리면 통과가 아니라 실패로 끝낸다(ADR-0263 결정 13 ⑦)
await runIfMain(import.meta.url, async () => {
  try {
    return await main(process.argv.slice(2));
  } catch (e) {
    console.log(process.env.GITHUB_ACTIONS === 'true' ? `::error::${e.message}` : `실패: ${e.message}`);
    return 1;
  }
});

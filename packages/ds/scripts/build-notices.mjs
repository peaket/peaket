// SEED 제3자 고지 파일 만들기(ADR-0040 결정 7, wbs 0.6.2, BUILD_ORDER BAS-180).
// 앱 번들에 SEED(@seed-design/*, Apache-2.0)가 들어가므로 Apache-2.0 제4조대로 라이선스 사본과 NOTICE의 귀속 고지를
// 고지 파일(packages/ds/THIRD-PARTY-NOTICES.txt)에 싣는다. @peaket/ds의 직접 의존성 가운데 @seed-design/* 와 그 하위 SEED 패키지를
// 모두 찾아, 붙인 판의 NOTICE·LICENSE를 글자 그대로 옮긴다(같은 글은 한 번만 싣고 패키지 이름을 함께 적는다).
// SEED 밖 JS 의존성의 고지는 이 파일이 다루지 않는다. 앱 배포에 이 파일을 싣고 번들러의 라이선스 주석 추출을 확인하는 일은 HOT-390이 한다.
//   node scripts/build-notices.mjs           만든다
//   node scripts/build-notices.mjs --check   다르면 종료 코드 1
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES_PATH = join(dsDir, 'THIRD-PARTY-NOTICES.txt');

/** 줄바꿈을 LF로 맞추고 끝 공백만 지운다(앞 공백은 글자 그대로 둔다) */
const read = (p) => readFileSync(p, 'utf8').replaceAll('\r\n', '\n').replace(/\s+$/, '');

/** from 폴더에서 Node처럼 node_modules를 거슬러 올라가며 패키지 폴더를 찾는다(내보내기 표와 상관없이) */
function packageDir(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const cand = join(dir, 'node_modules', name);
    if (existsSync(join(cand, 'package.json'))) return realpathSync(cand);
    if (dirname(dir) === dir) throw new Error(`${name}을 ${from}에서 찾지 못했다(pnpm install)`);
  }
}

/** ds가 잇는 @seed-design/* 패키지 전부(직접 의존성과 그 하위 SEED 패키지), 이름 차례 */
export function seedPackages() {
  const ds = JSON.parse(readFileSync(join(dsDir, 'package.json'), 'utf8'));
  const found = new Map();
  const visit = (name, from) => {
    const dir = packageDir(name, from);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (found.has(key)) return;
    const file = (f) => (existsSync(join(dir, f)) ? join(dir, f) : null);
    found.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      repo: String(pkg.repository?.url ?? pkg.repository ?? '').replace(/^git\+/, '').replace(/\.git$/, ''),
      noticePath: file('NOTICE'),
      licensePath: file('LICENSE') ?? file('LICENSE.md') ?? file('LICENSE.txt'),
    });
    for (const dep of Object.keys({ ...pkg.dependencies })) if (dep.startsWith('@seed-design/')) visit(dep, dir);
  };
  for (const dep of Object.keys({ ...ds.dependencies })) if (dep.startsWith('@seed-design/')) visit(dep, dsDir);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** 같은 글을 쓰는 패키지끼리 묶는다 */
function groupBy(pkgs, pathKey) {
  const groups = new Map();
  for (const p of pkgs) {
    if (!p[pathKey]) continue;
    const text = read(p[pathKey]);
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(`${p.name} ${p.version}`);
  }
  return [...groups.entries()];
}

/** 고지 파일 내용 */
export function renderNotices() {
  const pkgs = seedPackages();
  const rule = '='.repeat(72);
  const out = [
    'PEAKET 제3자 고지 — SEED Design(THIRD-PARTY NOTICES)',
    '',
    '이 파일은 @peaket/ds를 쓰는 앱 묶음에 들어가는 SEED Design 패키지의 고지다. SEED 밖 의존성의 고지는 이 파일에 없다.',
    'packages/ds/scripts/build-notices.mjs가 붙인 판의 패키지 파일에서 만든다(손으로 고치지 않는다).',
    'PEAKET은 SEED Design을 쓰지만 당근마켓과 제휴·후원·보증 관계가 없다. 당근마켓의 브랜드 리소스(로고·상호·캐릭터)는 쓰지 않는다.',
    '',
    rule,
    '패키지',
    rule,
    ...pkgs.map((p) => `- ${p.name} ${p.version} (${p.license})${p.repo ? ` ${p.repo}` : ''}`),
  ];
  for (const [text, names] of groupBy(pkgs, 'noticePath')) out.push('', rule, `NOTICE — ${names.join(', ')}`, rule, '', text);
  for (const [text, names] of groupBy(pkgs, 'licensePath')) out.push('', rule, `LICENSE — ${names.join(', ')}`, rule, '', text);
  out.push('');
  return out.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = renderNotices();
  if (process.argv.includes('--check')) {
    const onDisk = existsSync(NOTICES_PATH) ? readFileSync(NOTICES_PATH, 'utf8').replaceAll('\r\n', '\n') : null;
    if (onDisk !== text) {
      console.error("THIRD-PARTY-NOTICES.txt가 붙인 SEED 판과 다르다. 'pnpm --filter @peaket/ds notices'로 다시 만든다.");
      process.exit(1);
    }
    console.log('제3자 고지 파일이 붙인 판과 같다.');
  } else {
    writeFileSync(NOTICES_PATH, text, 'utf8');
    console.log(`만듦: ${NOTICES_PATH}`);
  }
}

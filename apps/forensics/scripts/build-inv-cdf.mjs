// F-04-9 역누적분포 표 생성기. 정본: docs/features/forensic-replay.md §5.3.
// 실행 중 생성기는 이 표를 정수로만 읽고 보간한다. 로그·지수·정규분포 계산은 빌드 때만 한다.
// 사용: node apps/forensics/scripts/build-inv-cdf.mjs --write | --check
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TABLE_SIZE = 4_096;
const SCALE = 1_000_000;

/** Acklam의 역정규분포 근사. 표를 만들 때만 쓴다. */
function invNormal(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function quantile(index) {
  return (index + 0.5) / TABLE_SIZE;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function makeTable(fn) {
  const values = new Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i += 1) {
    values[i] = Math.round(clamp(fn(quantile(i), invNormal(quantile(i))), -2_000_000_000, 2_000_000_000) * SCALE);
  }
  return values;
}

export function buildTables() {
  return {
    exponential: makeTable((p) => -Math.log(1 - p)),
    responseHuman: makeTable((_p, z) => clamp(Math.exp(Math.log(1_200) + 0.5 * z), 50, 7_000)),
    responseBot: makeTable((_p, z) => clamp(Math.exp(Math.log(150) + 0.35 * z), 20, 1_600)),
    entropyHuman: makeTable((_p, z) => clamp(1.8 + 0.45 * z, 0.05, 3.5)),
    entropyBot: makeTable((_p, z) => clamp(0.35 + 0.18 * z, 0.02, 1.2)),
  };
}

function block(name, values) {
  const lines = [];
  for (let i = 0; i < values.length; i += 16) lines.push(`  ${values.slice(i, i + 16).join(', ')},`);
  return `export const ${name}: readonly number[] = [\n${lines.join('\n')}\n];\n`;
}

export function renderTables(tables) {
  return [
    '// 자동 생성: node apps/forensics/scripts/build-inv-cdf.mjs --write',
    '// 정본: docs/features/forensic-replay.md §5.3. 실행 중 생성기는 이 정수 표만 보간한다.',
    '// 값은 100만 배율의 정수다. 빌드 스크립트 출력과 다르면 FX-T1 시험이 실패한다.',
    '',
    block('INV_EXP_Q6', tables.exponential),
    block('INV_RESPONSE_HUMAN_Q6', tables.responseHuman),
    block('INV_RESPONSE_BOT_Q6', tables.responseBot),
    block('INV_ENTROPY_HUMAN_Q6', tables.entropyHuman),
    block('INV_ENTROPY_BOT_Q6', tables.entropyBot),
  ].join('\n');
}

const target = fileURLToPath(new URL('../src/lib/forensics/inv-cdf-table.ts', import.meta.url));
const cli = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (cli) {
  const text = renderTables(buildTables());
  if (process.argv.includes('--write')) {
    writeFileSync(target, text);
    console.log(`표를 다시 썼다: ${target}`);
  } else if (process.argv.includes('--check')) {
    const actual = readFileSync(target, 'utf8');
    if (actual !== text) {
      console.error('표가 소스와 다릅니다. --write로 다시 만드세요.');
      process.exitCode = 1;
    } else {
      console.log('표가 소스와 같습니다.');
    }
  } else {
    process.stdout.write(text);
  }
}

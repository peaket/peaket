// 운영 좌석 저장소(services/purchase-svc …/adapters/redis-seat-store.ts RedisSeatStore)를 가짜 HotRedis로 불러, 보낸 명령·KEYS·ARGV를 JSON으로 낸다.
// loadtest/test/poc-seat.test.mjs가 측정 도구의 조립(loadtest/poc/bench/src/seat-contract.mjs)과 견줄 때 자식 프로세스로 띄운다:
//   node --experimental-transform-types --no-warnings loadtest/test/fixtures/seat-store-probe.mjs < {"ops":[…]}
// loadtest 시험은 패키지를 설치하지 않고 돈다(CI loadtest-check). 그래서 모듈 훅으로
// - '@nestjs/common'·'@peaket/platform'은 가져오는 파일이 쓰는 이름만 내보내는 대역으로 바꾸고(redisScript는 { lua }를, is…는 false를 돌려준다),
// - purchase-svc 원본의 데코레이터 줄(@Injectable()·@Inject(…))을 지운 뒤 형 지우기(+ 매개변수 속성 변환)로 읽고,
// - 원본의 상대 경로 '….js'를 같은 이름의 '.ts'로 잇는다. 원본 파일은 바꾸지 않는다.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../../../services/purchase-svc/src/', import.meta.url).href;
const ADAPTERS = new URL('modules/inventory/adapters/', SRC);
const DOMAIN = new URL('modules/inventory/domain/', SRC);
const STUBS = new Set(['@nestjs/common', '@peaket/platform']);

/** 가져오는 파일 원문에서 그 패키지로부터 값으로 가져오는 이름들 */
function importedNames(parentUrl, spec) {
  const src = readFileSync(fileURLToPath(parentUrl), 'utf8');
  const names = new Set();
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${spec.replace(/[/@]/g, (c) => `\\${c}`)}['"]`, 'g');
  for (const m of src.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p || p.startsWith('type ')) continue;
      names.add(p.split(/\s+as\s+/)[0].trim());
    }
  }
  return [...names];
}

function stubSource(spec, names) {
  return names
    .map((n) => {
      if (spec === '@nestjs/common') return `export const ${n} = () => () => {};`;
      if (n === 'redisScript') return 'export const redisScript = (lua) => ({ lua });';
      if (/^is[A-Z]/.test(n)) return `export const ${n} = () => false;`;
      return `export class ${n} {}`;
    })
    .join('\n');
}

registerHooks({
  resolve(spec, ctx, next) {
    if (STUBS.has(spec)) return { url: `peaket-stub:${spec}?from=${encodeURIComponent(ctx.parentURL ?? '')}`, shortCircuit: true };
    if (spec.startsWith('.') && spec.endsWith('.js') && ctx.parentURL?.startsWith(SRC) && ctx.parentURL.endsWith('.ts')) {
      const js = new URL(spec, ctx.parentURL);
      const ts = new URL(js.href.replace(/\.js$/, '.ts'));
      if (!existsSync(fileURLToPath(js)) && existsSync(fileURLToPath(ts))) return { url: ts.href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.startsWith('peaket-stub:')) {
      const u = new URL(url);
      const spec = u.pathname;
      const from = u.searchParams.get('from');
      return { format: 'module', source: stubSource(spec, from ? importedNames(from, spec) : []), shortCircuit: true };
    }
    if (url.startsWith(SRC) && url.endsWith('.ts')) {
      const src = readFileSync(fileURLToPath(url), 'utf8')
        .replace(/^[ \t]*@[\w.]+(\(.*\))?[ \t]*\r?\n/gm, '')
        .replace(/@[\w.]+\((?:[^()]|\([^()]*\))*\)\s+(?=(?:private|public|protected|readonly)\b)/g, '');
      return { format: 'module-typescript', source: src, shortCircuit: true };
    }
    return next(url, ctx);
  },
});

const store = await import(new URL('redis-seat-store.ts', ADAPTERS).href);
const hold = await import(new URL('hold.ts', DOMAIN).href);
const expiry = await import(new URL('expiry.ts', DOMAIN).href);

/** 가짜 HotRedis: 부른 차례대로 적고, 명령 이름(evalScript는 EVAL)별 답 줄에서 하나씩 꺼내 돌려준다 */
function fakeRedis(replies = {}) {
  const calls = [];
  const queues = Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, [...v]]));
  const take = (name) => (queues[name]?.length ? queues[name].shift() : null);
  return {
    calls,
    redis: {
      async evalScript(script, keys, args) {
        calls.push({ type: 'eval', lua: script?.lua ?? null, keys, args });
        return take('EVAL');
      },
      async command(args, o) {
        calls.push({ type: 'command', args, key: o?.key ?? null });
        return take(String(args[0]).toUpperCase());
      },
      async close() {},
    },
  };
}

const input = JSON.parse(readFileSync(0, 'utf8'));
const results = [];
for (const op of input.ops) {
  const f = fakeRedis(op.replies);
  const s = new store.RedisSeatStore(f.redis);
  try {
    let result;
    if (op.op === 'keys') {
      result = Object.fromEntries(Object.entries(store.seatKeys).map(([name, fn]) => [name, fn(...op.args)]));
    } else {
      result = await s[op.op](op.input);
    }
    results.push({ op: op.op, calls: f.calls, result });
  } catch (err) {
    const message = String(err?.message ?? err);
    results.push({ op: op.op, calls: f.calls, error: message });
  }
}
process.stdout.write(
  JSON.stringify({
    constants: {
      HOLD_TTL_MS: hold.HOLD_TTL_MS,
      REHOLD_WAIT_MS: hold.REHOLD_WAIT_MS,
      EXPIRY_BATCH_SIZE: expiry.EXPIRY_BATCH_SIZE,
      EXPIRY_MAX_BATCHES_PER_TICK: expiry.EXPIRY_MAX_BATCHES_PER_TICK,
      EXPIRY_TICK_MS: expiry.EXPIRY_TICK_MS,
      EXPIRY_CONCURRENCY: expiry.EXPIRY_CONCURRENCY,
      EXPIRY_BACKOFF_MS: expiry.EXPIRY_BACKOFF_MS,
    },
    results,
  }),
);

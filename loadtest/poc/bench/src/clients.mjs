// Redis 클라이언트 셋을 같은 모양으로 감싼다(V-T33, docs/architecture.md §9.4). 핫패스 설정은 정본 §5의 이름 그대로다:
// node-redis `disableOfflineQueue: true`·`commandOptions.timeout`, ioredis `enableOfflineQueue: false`·`maxRetriesPerRequest: 1`·
// `commandTimeout`, GLIDE `requestTimeout`(GLIDE는 연결이 끊기면 다시 잇는 동안 요청을 받지 않는다).
import { readFileSync } from 'node:fs';
import { createCluster, defineScript } from 'redis';
import { Cluster } from 'ioredis';
import { GlideClusterClient, GlideClusterClientConfiguration, Script } from '@valkey/valkey-glide';

const LUA_DIR = new URL('../lua/', import.meta.url);
export const lua = (name) => readFileSync(new URL(`${name}.lua`, LUA_DIR), 'utf8');

/**
 * @param {'node-redis'|'ioredis'|'glide'} kind
 * @param {{ nodes: string[], tls: boolean, ca?: string, timeoutMs?: number, scripts?: string[], onShard?: (ch: string, msg: string) => void, shardChannels?: string[] }} o
 */
export async function connect(kind, o) {
  const timeoutMs = o.timeoutMs ?? 100;
  const ca = o.tls ? (o.ca ?? readFileSync(process.env.PEAKET_POC_CA ?? '/tls/ca.crt', 'utf8')) : undefined;
  const scriptNames = o.scripts ?? [];
  if (kind === 'node-redis') return connectNodeRedis(o, timeoutMs, ca, scriptNames);
  // node-redis의 명령 시간 초과는 소켓에 쓰기 전까지만 듣는다(쓴 뒤 답을 기다리는 동안은 떼어 낸다, @redis/client 6.3.0
  // client/commands-queue.js). 그래서 핫패스는 호출 쪽 마감(같은 100ms)을 함께 건다. 마감에 걸린 명령도 나중에 서버에 닿으면 실행된다
  if (kind === 'node-redis-deadline') return withDeadline(await connectNodeRedis(o, timeoutMs, ca, scriptNames), timeoutMs);
  if (kind === 'ioredis') return connectIoredis(o, timeoutMs, ca, scriptNames);
  if (kind === 'glide') return connectGlide(o, timeoutMs, ca, scriptNames);
  throw new Error(`모르는 클라이언트: ${kind}`);
}

class DeadlineError extends Error {
  name = 'DeadlineError';
}
function withDeadline(c, ms) {
  const race = (p) => {
    let t;
    return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new DeadlineError(`${ms}ms 마감`)), ms)))]).finally(() => clearTimeout(t));
  };
  return { ...c, kind: 'node-redis-deadline', incr: (k) => race(c.incr(k)), incrBy: (k, n) => race(c.incrBy(k, n)), run: (name, keys, args) => race(c.run(name, keys, args)) };
}

async function connectNodeRedis(o, timeoutMs, ca, scriptNames) {
  const scripts = {};
  for (const name of scriptNames) {
    scripts[name] = defineScript({
      SCRIPT: lua(name),
      parseCommand(parser, keys, args) {
        // 키 수와 키를 함께 넣는다
        parser.pushKeysLength(keys);
        parser.push(...args.map(String));
      },
      transformReply: (r) => r,
    });
  }
  const c = createCluster({
    rootNodes: o.nodes.map((n) => ({ url: `${o.tls ? 'rediss' : 'redis'}://${n}` })),
    defaults: {
      socket: o.tls ? { tls: true, ca, reconnectStrategy: (n) => Math.min(50 * 2 ** n, 2000) } : { reconnectStrategy: (n) => Math.min(50 * 2 ** n, 2000) },
      disableOfflineQueue: true,
    },
    // 클러스터 연결의 명령 시간 초과는 맨 위에 둔다. defaults 안의 값은 클러스터가 명령마다 넘기는 기본 5초에 덮인다
    // (@redis/client 6.3.0 cluster/index.js의 _commandOptions, 2026-11-01 V-T33 ⑤에서 찾음)
    commandOptions: { timeout: timeoutMs },
    scripts,
  });
  c.on('error', () => {});
  await c.connect();
  return {
    kind: 'node-redis',
    incr: (k) => c.incr(k),
    incrBy: (k, n) => c.incrBy(k, n),
    get: (k) => c.get(k),
    set: (k, v) => c.set(k, v),
    run: (name, keys, args) => c[name](keys, args),
    spublish: (ch, msg) => c.sPublish(ch, msg),
    ssubscribe: (ch, cb) => c.sSubscribe(ch, (msg, chan) => cb(chan, msg)),
    close: () => c.close().catch(() => c.destroy()),
    raw: c,
  };
}

async function connectIoredis(o, timeoutMs, ca, scriptNames) {
  const nodes = o.nodes.map((n) => {
    const [host, port] = n.split(':');
    return { host, port: Number(port) };
  });
  const scripts = {};
  for (const name of scriptNames) scripts[name] = { lua: lua(name) };
  const c = new Cluster(nodes, {
    enableAutoPipelining: true,
    enableOfflineQueue: false,
    shardedSubscribers: Boolean(o.shardChannels?.length),
    clusterNodeRetryStrategy: (n) => Math.min(50 * 2 ** n, 2000),
    redisOptions: {
      tls: o.tls ? { ca } : undefined,
      maxRetriesPerRequest: 1,
      commandTimeout: timeoutMs,
    },
    scripts,
  });
  c.on('error', () => {});
  await new Promise((resolve, reject) => {
    c.once('ready', resolve);
    c.once('end', () => reject(new Error('ioredis 연결 실패')));
  });
  if (o.shardChannels?.length) {
    c.on('smessage', (chan, msg) => o.onShard?.(chan, msg));
    await c.ssubscribe(...o.shardChannels);
  }
  return {
    kind: 'ioredis',
    incr: (k) => c.incr(k),
    incrBy: (k, n) => c.incrby(k, n),
    get: (k) => c.get(k),
    set: (k, v) => c.set(k, v),
    run: (name, keys, args) => c[name](keys.length, ...keys, ...args.map(String)),
    spublish: (ch, msg) => c.spublish(ch, msg),
    ssubscribe: async (ch, cb) => {
      c.on('smessage', (chan, msg) => cb(chan, msg));
      await c.ssubscribe(ch);
    },
    close: () => c.quit().catch(() => c.disconnect()),
    raw: c,
  };
}

async function connectGlide(o, timeoutMs, ca, scriptNames) {
  const addresses = o.nodes.map((n) => {
    const [host, port] = n.split(':');
    return { host, port: Number(port) };
  });
  const scripts = Object.fromEntries(scriptNames.map((n) => [n, new Script(lua(n))]));
  const config = {
    addresses,
    useTLS: o.tls,
    requestTimeout: timeoutMs,
    advancedConfiguration: o.tls ? { tlsAdvancedConfiguration: { rootCertificates: ca } } : undefined,
  };
  if (o.shardChannels?.length) {
    config.pubsubSubscriptions = {
      channelsAndPatterns: { [GlideClusterClientConfiguration.PubSubChannelModes.Sharded]: new Set(o.shardChannels) },
      callback: (msg) => o.onShard?.(String(msg.channel), String(msg.message)),
    };
  }
  const c = await GlideClusterClient.createClient(config);
  return {
    kind: 'glide',
    incr: (k) => c.incr(k),
    incrBy: (k, n) => c.incrBy(k, n),
    get: (k) => c.get(k),
    set: (k, v) => c.set(k, v),
    run: (name, keys, args) => c.invokeScript(scripts[name], { keys, args: args.map(String) }),
    spublish: (ch, msg) => c.publish(msg, ch, true),
    ssubscribe: async () => {
      throw new Error('GLIDE는 만들 때 구독을 준다(shardChannels)');
    },
    close: async () => c.close(),
    raw: c,
  };
}

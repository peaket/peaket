// 측정용 Valkey 클러스터(주 노드 셋·복제 셋, 클러스터 모드). 노드는 컨테이너 망 이름(valkey-sN)을 알려 주므로, 이 PC의 측정 프로세스는
// 노드마다 연 이 PC 포트로 바꿔 붙는다(HotRedis nodeAddressMap). 노드 사이(클러스터 버스·복제)는 컨테이너 망으로 오간다.
// 자동 장애 전환에는 주 노드 과반이 필요해 셋을 둔다(loadtest/poc/stack.mjs와 같은 모양, cluster-node-timeout 5초).
import { execFile, execFileSync } from 'node:child_process';
import { VALKEY_IMAGE } from '../test-int/valkey.js';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryDocker = (...args: string[]) => {
  try {
    return docker(...args);
  } catch {
    return null;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SIM_NET = 'peaket-sim';
const NAMES = [1, 2, 3, 4, 5, 6].map((i) => `valkey-s${i}`);

export interface SimCluster {
  clusterUrls: string[];
  nodeAddressMap: Record<string, { host: string; port: number }>;
  cli(node: string, ...args: string[]): string;
  /** 그 키 슬롯의 주 노드와 그 복제(컨테이너 이름) */
  ownerOf(key: string): { master: string; replica: string | null };
  kill(node: string): void;
  pause(node: string): void;
  unpause(node: string): void;
  /** 측정 중에 부르는 것(기다리는 동안 이벤트 루프를 막지 않는다) */
  dockerAsync(...args: string[]): Promise<void>;
  down(): void;
}

export function simDown(): void {
  for (const n of NAMES) tryDocker('rm', '-f', n);
  tryDocker('network', 'rm', SIM_NET);
}

export async function simCluster(): Promise<SimCluster> {
  simDown();
  docker('network', 'create', SIM_NET);
  for (const [i, name] of NAMES.entries()) {
    docker('run', '-d', '--name', name, '--hostname', name, '--network', SIM_NET, '--cpus', i < 3 ? '2' : '1', '-p', '127.0.0.1::6379', VALKEY_IMAGE, 'valkey-server',
      '--cluster-enabled', 'yes', '--cluster-config-file', 'nodes.conf', '--cluster-node-timeout', '5000',
      '--cluster-announce-hostname', name, '--cluster-preferred-endpoint-type', 'hostname',
      '--appendonly', 'no', '--save', '', '--protected-mode', 'no');
  }
  const cli = (node: string, ...args: string[]) => docker('exec', node, 'valkey-cli', ...args);
  for (let i = 0; i < 50 && !NAMES.every((n) => tryDocker('exec', n, 'valkey-cli', 'PING') === 'PONG'); i += 1) await sleep(200);
  const ips = NAMES.map((n) => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${SIM_NET}").IPAddress}}`, n));
  docker('exec', NAMES[0]!, 'valkey-cli', '--cluster', 'create', ...ips.map((ip) => `${ip}:6379`), '--cluster-replicas', '1', '--cluster-yes');
  let ok = false;
  for (let i = 0; i < 100 && !ok; i += 1) {
    ok = NAMES.every((n) => /cluster_state:ok/.test(tryDocker('exec', n, 'valkey-cli', 'CLUSTER', 'INFO') ?? ''));
    if (!ok) await sleep(300);
  }
  if (!ok) throw new Error('측정 클러스터가 ok가 되지 않았다');
  const nodeAddressMap: Record<string, { host: string; port: number }> = {};
  for (const n of NAMES) {
    const mapped = docker('port', n, '6379/tcp').split('\n')[0]!;
    nodeAddressMap[`${n}:6379`] = { host: '127.0.0.1', port: Number(mapped.slice(mapped.lastIndexOf(':') + 1)) };
  }
  const ownerOf = (key: string) => {
    const slot = Number(cli(NAMES[0]!, 'CLUSTER', 'KEYSLOT', key));
    // CLUSTER NODES: id 주소@버스,이름 깃발 주인 ... 슬롯들
    const lines = NAMES.map((n) => tryDocker('exec', n, 'valkey-cli', 'CLUSTER', 'NODES')).find((x) => x) ?? '';
    const rows = lines.split('\n').map((l) => l.trim().split(' '));
    const hostOf = (r: string[]) => (r[1] ?? '').split(',')[1] ?? '';
    const master = rows.find((r) => r[2]?.includes('master') && !r[2]?.includes('fail') && r.slice(8).some((s) => {
      const [x, y] = s.split('-').map(Number);
      return y === undefined ? x === slot : slot >= x! && slot <= y;
    }));
    if (!master) throw new Error(`슬롯 ${slot}의 주 노드를 찾지 못했다`);
    const replica = rows.find((r) => r[3] === master[0] && r[2]?.includes('slave') && !r[2]?.includes('fail'));
    return { master: hostOf(master), replica: replica ? hostOf(replica) : null };
  };
  return {
    clusterUrls: [`redis://127.0.0.1:${nodeAddressMap[`${NAMES[0]}:6379`]!.port}`],
    nodeAddressMap,
    cli,
    ownerOf,
    kill: (node) => void docker('kill', node),
    pause: (node) => void docker('pause', node),
    // 이미 풀렸으면 그대로 둔다(정리에서 한 번 더 부른다)
    unpause: (node) => void tryDocker('unpause', node),
    dockerAsync: (...args) => new Promise<void>((res) => execFile('docker', args, () => res())),
    down: simDown,
  };
}

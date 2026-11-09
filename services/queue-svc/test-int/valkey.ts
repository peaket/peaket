// 통합 시험용 Valkey 컨테이너(packages/platform/test-int/containers.ts와 같은 방식: 라이브러리 없이 docker 명령). Docker 엔진이 떠 있어야 한다.
import { execFileSync } from 'node:child_process';

export const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface ValkeyContainer {
  url: string;
  stop(): void;
}

/**
 * cluster: 노드 하나짜리 클러스터 모드(모든 슬롯을 맡는다). 스크립트의 CLUSTER MYID·cluster_my_epoch를 시험할 때 쓴다(ADR-0181).
 * configEpoch를 주면 빈 노드의 설정 세대를 그 값으로 둔다(CLUSTER SET-CONFIG-EPOCH)
 */
export async function startValkey(o: { cluster?: boolean; configEpoch?: number } = {}): Promise<ValkeyContainer> {
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::6379', VALKEY_IMAGE, ...(o.cluster ? ['valkey-server', '--cluster-enabled', 'yes'] : [])]);
  if (o.cluster) {
    const cli = (...a: string[]) => docker(['exec', id, 'valkey-cli', ...a]);
    for (let i = 0; i < 50 && cli('PING') !== 'PONG'; i++) await new Promise((r) => setTimeout(r, 100));
    if (o.configEpoch !== undefined) cli('CLUSTER', 'SET-CONFIG-EPOCH', String(o.configEpoch));
    cli('CLUSTER', 'ADDSLOTSRANGE', '0', '16383');
    for (let i = 0; i < 50 && !cli('CLUSTER', 'INFO').includes('cluster_state:ok'); i++) await new Promise((r) => setTimeout(r, 100));
  }
  const mapped = docker(['port', id, '6379/tcp']).split('\n')[0]!;
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  return {
    url: `redis://127.0.0.1:${port}`,
    stop: () => {
      try {
        docker(['rm', '-f', '-v', id]);
      } catch {
        // 이미 없다
      }
    },
  };
}

export interface ValkeyPair {
  /** 주 노드 주소 */
  url: string;
  /** 복제본 프로세스를 멈춘다(연결은 남아 주 노드는 붙어 있는 복제본으로 센다, docker pause) */
  pauseReplica(): void;
  resumeReplica(): void;
  stop(): void;
}

/** 주 노드 하나와 그 복제본 하나(단일 노드 모드, 같은 docker 망). RB-05 복제 확인(WAIT)을 실제 복제로 볼 때 쓴다(ADR-0186) */
export async function startValkeyPair(): Promise<ValkeyPair> {
  const net = `peaket-it-${process.pid}-${Date.now()}`;
  docker(['network', 'create', net]);
  const ids: string[] = [];
  const stop = () => {
    for (const id of ids) {
      try {
        docker(['rm', '-f', '-v', id]);
      } catch {
        // 이미 없다
      }
    }
    try {
      docker(['network', 'rm', net]);
    } catch {
      // 이미 없다
    }
  };
  try {
    const primary = docker(['run', '-d', '--rm', '--network', net, '--network-alias', 'primary', '-p', '127.0.0.1::6379', VALKEY_IMAGE]);
    ids.push(primary);
    const replica = docker(['run', '-d', '--rm', '--network', net, VALKEY_IMAGE, 'valkey-server', '--replicaof', 'primary', '6379']);
    ids.push(replica);
    let online = false;
    for (let i = 0; i < 100 && !online; i++) {
      online = /slave0:[^\r\n]*state=online/.test(docker(['exec', primary, 'valkey-cli', 'INFO', 'replication']));
      if (!online) await new Promise((r) => setTimeout(r, 100));
    }
    if (!online) throw new Error('복제본이 주 노드에 붙지 않았다');
    const mapped = docker(['port', primary, '6379/tcp']).split('\n')[0]!;
    return {
      url: `redis://127.0.0.1:${Number(mapped.slice(mapped.lastIndexOf(':') + 1))}`,
      pauseReplica: () => void docker(['pause', replica]),
      resumeReplica: () => void docker(['unpause', replica]),
      stop,
    };
  } catch (e) {
    stop();
    throw e;
  }
}

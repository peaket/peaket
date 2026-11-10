// 합본의 관리 포트(BUILD_ORDER PRF-215). 파드에는 관리 포트가 하나라(차트의 managementPort, 로컬 Prometheus는 파드 주석의 포트 하나를 긁는다)
// 서비스마다 연 관리 포트를 이 프로세스 안 루프백으로 불러 모은다.
// - /livez: 이벤트 루프가 답하는지만 본다(서비스를 부르지 않는다, docs/architecture.md §5 '프로브 규칙')
// - /ready: 모든 서비스가 켜졌고 각 서비스의 /ready가 200일 때만 200이다. 아니면 503과 아직인 서비스 이름
// - /metrics: 서비스들의 Prometheus 글을 지표 묶음(family)별로 합친다. 같은 이름·같은 꼬리표의 표본은 처음 것만 둔다
//   (process_*·nodejs_* 같은 프로세스 기본 지표는 서비스마다 같은 값이라 하나만 남고, service 꼬리표가 다른 표본은 모두 남는다)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** 서비스 관리 포트를 부르는 시간 한도 [가정](준비 프로브 timeoutSeconds 2초 안) */
export const SERVICE_PROBE_TIMEOUT_MS = 1_500;

interface Family {
  help?: string;
  type?: string;
  samples: Map<string, string>;
}

/** 표본 줄의 이름·꼬리표 부분(값 앞까지). 꼬리표 값 안의 공백·}는 따옴표 안이라 건너뛴다 */
function sampleKey(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuote) {
      if (c === '\\') i += 1;
      else if (c === '"') inQuote = false;
    } else if (c === '"') inQuote = true;
    else if (c === ' ' || c === '\t') return line.slice(0, i);
  }
  return line;
}

const baseName = (key: string): string => key.split('{', 1)[0]!;

/**
 * Prometheus 글(0.0.4) 여럿을 하나로 합친다. 묶음 차례는 처음 나온 차례이고, 묶음마다 HELP·TYPE 한 번 뒤에 표본을 둔다.
 * HELP·TYPE 없이 나온 표본은 그 이름을 묶음 이름으로 쓴다. 표본은 그 앞의 HELP·TYPE 묶음에 속한다(_bucket·_sum·_count도 그 묶음이다)
 */
export function mergeExposition(texts: readonly string[]): string {
  const families = new Map<string, Family>();
  const family = (name: string): Family => {
    let f = families.get(name);
    if (!f) families.set(name, (f = { samples: new Map() }));
    return f;
  };
  for (const text of texts) {
    let current: string | undefined;
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
      const line = raw.trimEnd();
      if (line === '') continue;
      const meta = /^# (HELP|TYPE) (\S+)(?: (.*))?$/.exec(line);
      if (meta) {
        const [, kind, name, rest = ''] = meta;
        current = name!;
        const f = family(current);
        if (kind === 'HELP') f.help ??= rest;
        else f.type ??= rest;
        continue;
      }
      if (line.startsWith('#')) continue;
      const key = sampleKey(line);
      const name = baseName(key);
      // 앞의 묶음 이름으로 시작하지 않는 표본은 제 이름의 묶음이다
      const owner = current && (name === current || name.startsWith(`${current}_`)) ? current : name;
      const f = family(owner);
      if (!f.samples.has(key)) f.samples.set(key, line);
    }
  }
  const out: string[] = [];
  for (const [name, f] of families) {
    if (f.help !== undefined) out.push(`# HELP ${name} ${f.help}`);
    if (f.type !== undefined) out.push(`# TYPE ${name} ${f.type}`);
    for (const s of f.samples.values()) out.push(s);
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

export interface ManagementTargets {
  /** 아직 켜지 않은 서비스 이름(켜는 중이면 비지 않는다) */
  pending(): readonly string[];
  /** 켠 서비스와 관리 포트 */
  services(): readonly { service: string; managementPort: number }[];
}

async function get(port: number, path: string): Promise<{ status: number; text: string }> {
  const ctl = AbortSignal.timeout(SERVICE_PROBE_TIMEOUT_MS);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctl });
  return { status: res.status, text: await res.text() };
}

/** 합본 관리 서버를 연다(0.0.0.0, 주어진 포트). 돌려준 close는 듣기를 멈춘다 */
export async function startManagement(port: number, targets: ManagementTargets, host = '0.0.0.0'): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: string, type = 'application/json; charset=utf-8'): void => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (req.method !== 'GET') return send(405, JSON.stringify({ status: 'method-not-allowed' }));
    const path = (req.url ?? '/').split('?', 1)[0];
    if (path === '/livez') return send(200, JSON.stringify({ status: 'live' }));
    if (path === '/ready') {
      const waiting = [...targets.pending()];
      const answers = await Promise.all(targets.services().map(async (s) => ({ s, ok: await get(s.managementPort, '/ready').then((r) => r.status === 200, () => false) })));
      for (const a of answers) if (!a.ok) waiting.push(a.s.service);
      if (waiting.length === 0 && targets.services().length > 0) return send(200, JSON.stringify({ status: 'ready' }));
      return send(503, JSON.stringify({ status: 'starting', pending: waiting }));
    }
    if (path === '/metrics') {
      const texts = await Promise.all(targets.services().map((s) => get(s.managementPort, '/metrics').then((r) => (r.status === 200 ? r.text : ''), () => '')));
      return send(200, mergeExposition(texts), 'text/plain; version=0.0.4; charset=utf-8');
    }
    return send(404, JSON.stringify({ status: 'not-found' }));
  };
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error' }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  return {
    server,
    port: typeof addr === 'object' && addr ? addr.port : port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

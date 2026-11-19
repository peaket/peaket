// 진단 수집(ADR-0070 결정 1 '수동(RB-31)' 1~6, docs/infra.md §10 RB-31, docs/devops.md D-T18 ①, BUILD_ORDER BAS-080).
// 운영자가 파드에 주석 peaket.io/diagnose=<report|heap>@<UTC 시각>을 달면 Downward API 파일로 그 값이 들어온다. 이 모듈은 파일을 pollMs마다 읽고 차례대로 한다:
//   준비 내림(남은 작업 diagnosing)·새 일 멈춤(onStopWork) → unreadyWaitMs 기다림(준비 프로브 5초 × (6회 + 1) + 퍼짐 여유 5초 = 40초 [가정]로
//   Service에서 빠질 시간, 그동안 HTTP는 그대로 받는다, 리뷰 RV-01) → 진행 중 일 최대 drainMs 마감 → 표시 파일에 '<값> started'
//   → 진단 보고서 → heap이면 (메모리 한도 − RSS) > 2 × 쓰는 힙일 때만 힙 스냅샷(*.partial로 쓰고 끝나면 이름을 바꾼다. 아니면 건너뛴 까닭을 로그·지표에)
//   → 증거 저장소에 올리기 → 올린 파일만 지우기 → 처리한 값을 표시 파일에 → 끝내기(exit, 서비스 뼈대는 자기에게 SIGTERM을 보내 종료 차례로 끝난다)
// - 표시 파일의 값과 주석 값이 같으면 아무것도 하지 않는다(다시 뜬 뒤 되풀이하지 않는다). 같은 값이 'started'로 남아 있으면(수집 도중 죽음)
//   다시 하지 않고 result="interrupted"로 센다(리뷰 SEC-03). 형식에 안 맞는 값은 값마다 경고 한 번과 result="invalid_request" 한 번이다
// - 보고서에 환경 변수(environmentVariables)·네트워크 칸을 남기지 않는다: 시작하자마자 process.report의 excludeEnv·excludeNetwork를 켜고(치명 오류
//   보고서도), 쓴 보고서와 시작 때 남은 .json 보고서를 씻은 뒤 올린다. 씻지 못한 남은 보고서는 올리지 않는다(리뷰 SEC-02). 객체 이름은
//   <서비스>/<파드>/<요청 시각>/<파일>뿐이다(ASVS v5.0.0-14.2.1)
// - 올리기에 성공한 파일만 지운다. 시작할 때 /diag에 남은 파일(치명 오류 보고서, 올리지 못한 파일)을 올리고 지운다. 남은 *.partial(끝내지 못한
//   스냅샷)은 올리지 않고 지운다(ASVS v5.0.0-14.2.2)
import { existsSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import type { Clock } from './clock.js';
import { PlatformConfigError, type PeaketEnv } from './config.js';
import type { EvidenceStore } from './evidence-store.js';
import type { PlatformLogger } from './log.js';
import type { PlatformMetrics } from './metrics.js';
import { READINESS_DIAGNOSING, type Readiness } from './readiness.js';

/** 진단 요청 주석 이름 */
export const DIAGNOSE_ANNOTATION = 'peaket.io/diagnose';
/** 처리한 요청 값을 적는 표시 파일(/diag 안). 올리지 않는다. 무거운 일 전에 '<값> started', 끝나면 '<값>'이다 */
export const DIAGNOSE_HANDLED_FILE = '.diagnose-handled';
/** 표시 파일에서 수집을 시작했지만 끝내지 못한 값의 꼬리 */
export const DIAGNOSE_STARTED_SUFFIX = ' started';
/** 끝내지 못한 스냅샷의 꼬리. 남은 것은 올리지 않고 지운다 */
export const DIAGNOSE_PARTIAL_SUFFIX = '.partial';

/** 진단 수집 기본값 [가정](추천 적용 2026-11-19, BAT-075 계획) */
export const DIAGNOSE_DEFAULTS = Object.freeze({
  /** 주석 파일을 읽는 간격(ms) */
  pollMs: 5_000,
  /** 준비를 내린 뒤 기다리는 시간(ms). 준비 프로브 5초 × (연속 6회 + 첫 실패까지 한 주기) + 끝점 퍼짐 여유 5초(리뷰 RV-01, ADR-0303 결정 3) */
  unreadyWaitMs: 40_000,
  /** 진행 중 일의 마감(ms) */
  drainMs: 10_000,
});

/** diagnose_collections_total의 result 값 */
export const DIAGNOSE_RESULTS = ['report', 'heap', 'heap_skipped_low_memory', 'heap_skipped_no_limit', 'heap_failed', 'report_failed', 'upload_failed', 'leftover_uploaded', 'leftover_unreadable', 'interrupted', 'invalid_request'] as const;
export type DiagnoseResult = (typeof DIAGNOSE_RESULTS)[number];

/** 요청 값: report 또는 heap, @, 분까지(ADR-0070 보기 heap@2026-11-02T20:10Z)·초까지·밀리초 세 자리까지 적은 UTC 시각(리뷰 SEC-05) */
const REQUEST = /^(report|heap)@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z)$/;

export interface DiagnoseRequest {
  kind: 'report' | 'heap';
  /** 요청 시각(주석에 적힌 글 그대로, 객체 이름에 쓴다) */
  at: string;
}

/** 요청 값을 읽는다. 형식이 틀리거나 없는 날짜(2026-13-01 등)면 undefined */
export function parseDiagnoseRequest(value: string): DiagnoseRequest | undefined {
  const m = REQUEST.exec(value);
  if (!m) return undefined;
  const at = m[2]!;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return undefined;
  // Date.parse가 넘치는 값(2월 30일 등)을 다음 달로 넘기지 않았는지 적힌 자리까지 되돌려 본다
  if (new Date(t).toISOString().slice(0, at.length - 1) !== at.slice(0, -1)) return undefined;
  return { kind: m[1] as 'report' | 'heap', at };
}

/** Downward API 주석 파일(줄마다 key="value", 값은 Go %q 꼴)에서 진단 주석 값을 찾는다 */
export function diagnoseAnnotationOf(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq) !== DIAGNOSE_ANNOTATION) continue;
    const raw = line.slice(eq + 1).trim();
    if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return raw;
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return undefined;
}

export interface DiagnoseHeap {
  /** 쓰는 힙(바이트) */
  used(): number;
  /** 프로세스 RSS(바이트) */
  rss(): number;
  snapshot(file: string): Promise<void>;
}

export type DiagnoseLogger = Pick<PlatformLogger, 'info' | 'warn' | 'error'>;

export interface StartDiagnoseOptions {
  service: string;
  pod: string;
  readiness: Readiness;
  /** Downward API 주석 파일 경로 */
  annotationsFile: string;
  /** 보고서·스냅샷·표시 파일을 두는 폴더(차트의 /diag emptyDir) */
  diagDir: string;
  store: EvidenceStore;
  /** 컨테이너 메모리 한도(바이트). 없으면 힙 스냅샷을 건너뛴다 */
  memoryLimitBytes?: number;
  clock: Clock;
  /** 새 일(Kafka 소비 등)을 멈춘다. 돌려준 약속은 진행 중 일이 끝나면 풀린다(drainMs까지 기다린다) */
  onStopWork?: () => Promise<void>;
  /** 수집을 마친 뒤 한 번 부른다 */
  exit: () => void;
  pollMs?: number;
  unreadyWaitMs?: number;
  drainMs?: number;
  heap?: DiagnoseHeap;
  /** 진단 보고서를 file에 쓴다. 기본은 환경 변수·네트워크 칸을 뺀 process.report */
  report?: (file: string) => void;
  logger: DiagnoseLogger;
  /** 있으면 diagnose_collections_total{service, result}를 낸다 */
  metrics?: PlatformMetrics;
  /** 기다리기(시험은 가짜 타이머로 민다). 기본 setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

const defaultHeap: DiagnoseHeap = {
  used: () => process.memoryUsage().heapUsed,
  rss: () => process.memoryUsage().rss,
  snapshot: async (file) => {
    writeHeapSnapshot(file);
  },
};

/** process.report의 환경 변수·네트워크 빼기를 켠다(실행 옵션 --report-exclude-env·--report-exclude-network와 같은 값을 코드에서도 켜 두 겹으로 둔다) */
function excludeReportSecrets(): void {
  const report = process.report as NodeJS.ProcessReport & { excludeEnv?: boolean; excludeNetwork?: boolean };
  report.excludeEnv = true;
  report.excludeNetwork = true;
}

/**
 * process.report.writeReport에 넘길 경로를 고른다(BAT-080 RV-20). `--report-directory`가 켜진 Node 24(차트의
 * NODE_OPTIONS=--report-directory=/diag)는 절대 경로를 받으면 보고서를 쓰지 못하고 errno 2로 실패한다(PR #43 kind 로그).
 * 디렉터리 안의 파일은 그 디렉터리 기준 상대 이름(같은 디렉터리면 basename)으로 바꾸고, 디렉터리 밖이거나 디렉터리가 비면 그대로 둔다
 */
export function reportTarget(file: string, directory: string): string {
  if (!directory) return file;
  const rel = relative(directory, file);
  // 빈 값은 file이 directory 자체인 때다. ..으로 시작하거나(디렉터리 밖) 다른 드라이브의 절대 경로면 바꾸지 않는다
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return file;
  return rel;
}

/** 환경 변수·네트워크 칸을 빼고 진단 보고서를 쓴다. 파일이 실제로 생겼는지까지 확인한다(RV-20) */
function writeSafeReport(file: string): void {
  excludeReportSecrets();
  process.report.writeReport(reportTarget(file, process.report.directory ?? ''));
  if (!existsSync(file)) throw new Error('report-not-written');
}

/**
 * 보고서 JSON에서 환경 변수·네트워크 칸을 지운다(쓰는 함수를 바꿔 끼워도 남지 않게). JSON 객체로 읽지 못하면 false이고 파일은 그대로다
 */
async function scrubReport(file: string): Promise<boolean> {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return false;
  let changed = 'environmentVariables' in doc;
  delete doc.environmentVariables;
  const header = doc.header as Record<string, unknown> | undefined;
  if (header && typeof header === 'object' && 'networkInterfaces' in header) {
    delete header.networkInterfaces;
    changed = true;
  }
  if (changed) await writeFile(file, JSON.stringify(doc));
  return true;
}

const fileStamp = (at: string): string => at.replace(/:/g, '-');

/** 진단 파일 이름의 시각(`report-<stamp>.json`·`heap-<stamp>.heapsnapshot`, stamp는 ':'를 '-'로 바꾼 요청 시각) */
const STAMPED_FILE = /^(?:report|heap)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}(?:-\d{2}(?:\.\d{3})?)?Z)\.(?:json|heapsnapshot)$/;
/** Node가 치명 오류 때 쓰는 보고서 이름(`report.YYYYMMDD.HHMMSS.<pid>.<seq>.json`, --report-on-fatalerror) */
const NODE_REPORT_FILE = /^report\.(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})(\d{2})\.\d+\.\d+\.json$/;

/**
 * 남은 파일 이름에서 요청 시각을 읽는다(ADR-0303 결정 3, BAT-080 DG-09). 진단 수집이 쓴 파일은 요청 시각을 이름에 담고,
 * Node의 치명 오류 보고서는 시각이 다른 꼴(YYYYMMDD.HHMMSS)로 담는다. 읽지 못하면 undefined다
 */
export function requestTimeOfFile(name: string): string | undefined {
  const stamped = STAMPED_FILE.exec(name);
  if (stamped) {
    const [date, time] = stamped[1]!.split('T');
    return parseDiagnoseRequest(`report@${date}T${time!.replaceAll('-', ':')}`)?.at;
  }
  const node = NODE_REPORT_FILE.exec(name);
  if (node) return parseDiagnoseRequest(`report@${node[1]}-${node[2]}-${node[3]}T${node[4]}:${node[5]}:${node[6]}Z`)?.at;
  return undefined;
}

/**
 * 진단 수집을 시작한다. 시작하자마자 /diag에 남은 파일을 올리고, 주석 파일을 pollMs마다 읽는다.
 * stop()은 읽기를 멈춘다(돌던 수집은 끝내기를 부르지 않고 멈춘다)
 */
export function startDiagnose(o: StartDiagnoseOptions): { stop(): void } {
  const pollMs = o.pollMs ?? DIAGNOSE_DEFAULTS.pollMs;
  const unreadyWaitMs = o.unreadyWaitMs ?? DIAGNOSE_DEFAULTS.unreadyWaitMs;
  const drainMs = o.drainMs ?? DIAGNOSE_DEFAULTS.drainMs;
  const heap = o.heap ?? defaultHeap;
  const report = o.report ?? writeSafeReport;
  const markerFile = join(o.diagDir, DIAGNOSE_HANDLED_FILE);
  const count = (result: DiagnoseResult) => o.metrics?.diagnoseResults.inc({ service: o.service, result });
  // 치명 오류 보고서(--report-on-fatalerror)도 환경 변수·네트워크 칸을 빼도록 시작하자마자 켠다(리뷰 SEC-02)
  excludeReportSecrets();

  let stopped = false;
  let busy = false;
  let pollTimer: NodeJS.Timeout | undefined;
  const waits = new Set<{ timer: NodeJS.Timeout; done: () => void }>();
  /** stop()이 풀어 주는 기다리기 */
  const sleep =
    o.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const w = {
          timer: setTimeout(() => {
            waits.delete(w);
            resolve();
          }, ms),
          done: resolve,
        };
        waits.add(w);
      }));
  let handled: string | null | undefined; // undefined: 아직 표시 파일을 읽지 않음, null: 표시 없음
  const warned = new Set<string>();

  const keyOf = (at: string, file: string) => `${o.service}/${o.pod}/${at}/${basename(file)}`;

  /** 올리고, 성공한 파일만 지운다. 성공 여부를 돌려준다 */
  const upload = async (key: string, file: string): Promise<boolean> => {
    try {
      await o.store.put(key, file);
    } catch (err) {
      count('upload_failed');
      o.logger.error({ err, kind: 'diagnose', file: basename(file) }, '진단 증거를 올리지 못했다(파일은 남긴다)');
      return false;
    }
    await rm(file, { force: true }).catch((err: unknown) => o.logger.error({ err, kind: 'diagnose', file: basename(file) }, '올린 진단 파일을 지우지 못했다'));
    return true;
  };

  const uploadLeftovers = async (): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(o.diagDir, { withFileTypes: true })).filter((d) => d.isFile() && !d.name.startsWith('.')).map((d) => d.name);
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'ENOENT') o.logger.warn({ err, kind: 'diagnose' }, '진단 폴더를 읽지 못했다');
      return;
    }
    const mark = await readHandled();
    const markerValue = mark?.endsWith(DIAGNOSE_STARTED_SUFFIX) ? mark.slice(0, -DIAGNOSE_STARTED_SUFFIX.length) : mark;
    const markerAt = markerValue ? parseDiagnoseRequest(markerValue)?.at : undefined;
    let unreadable = 0;
    for (const name of names.sort()) {
      if (stopped) return;
      const file = join(o.diagDir, name);
      // 끝내지 못한 스냅샷은 잘린 파일이라 올리지 않고 지운다(리뷰 SEC-03)
      if (name.endsWith(DIAGNOSE_PARTIAL_SUFFIX)) {
        await rm(file, { force: true }).catch((err: unknown) => o.logger.error({ err, kind: 'diagnose', file: name }, '끝내지 못한 진단 파일을 지우지 못했다'));
        continue;
      }
      // 남은 보고서도 환경 변수·네트워크 칸을 지운 뒤 올린다. 읽지 못하면 올리지 않는다(리뷰 SEC-02)
      if (name.endsWith('.json') && !(await scrubReport(file))) {
        count('leftover_unreadable');
        unreadable += 1;
        o.logger.warn({ kind: 'diagnose', file: name }, '남은 진단 보고서를 읽지 못해 올리지 않는다(환경 변수를 지웠는지 알 수 없다)');
        continue;
      }
      // 객체 키의 요청 시각은 파일 이름(진단 수집·치명 오류 보고서)이나 표시 파일의 @ 시각에서 읽는다.
      // 시작 시각을 쓰면 다시 뜰 때마다 같은 증거가 다른 접두사에 쌓인다(BAT-080 DG-09, ADR-0303 결정 3)
      const at = requestTimeOfFile(name) ?? markerAt;
      if (!at) {
        count('leftover_unreadable');
        unreadable += 1;
        o.logger.warn({ kind: 'diagnose', file: name }, '남은 진단 파일 이름에서 요청 시각을 읽지 못해 올리지 않는다(표시 파일에도 없다)');
        continue;
      }
      if (await upload(keyOf(at, name), file)) count('leftover_uploaded');
    }
    if (names.length > 0) o.logger.info({ kind: 'diagnose', files: names.length, unreadable }, '시작할 때 남은 진단 파일을 처리했다');
  };

  const readHandled = async (): Promise<string | null> => {
    if (handled !== undefined) return handled;
    try {
      handled = (await readFile(markerFile, 'utf8')).trim();
    } catch {
      handled = null;
    }
    return handled;
  };

  const collect = async (value: string, request: DiagnoseRequest): Promise<void> => {
    const started = o.clock.monotonicMs();
    o.logger.warn({ kind: 'diagnose', request: request.kind, at: request.at }, '진단 수집을 시작한다(준비 상태를 내린다)');
    o.readiness.register(READINESS_DIAGNOSING);
    let stopWork: Promise<void> = Promise.resolve();
    try {
      stopWork = (o.onStopWork?.() ?? Promise.resolve()).catch((err: unknown) => o.logger.error({ err, kind: 'diagnose' }, '진단 수집 중 새 일을 멈추지 못했다'));
    } catch (err) {
      o.logger.error({ err, kind: 'diagnose' }, '진단 수집 중 새 일을 멈추지 못했다');
    }
    await sleep(unreadyWaitMs);
    if (stopped) return;
    await Promise.race([stopWork, sleep(drainMs)]);
    if (stopped) return;

    // 무거운 일 전에 시작 표시를 먼저 쓴다. 스냅샷 중에 죽으면 다시 뜬 프로세스가 되풀이하지 않는다(리뷰 SEC-03)
    try {
      await writeFile(markerFile, `${value}${DIAGNOSE_STARTED_SUFFIX}`);
      handled = `${value}${DIAGNOSE_STARTED_SUFFIX}`;
    } catch (err) {
      o.logger.error({ err, kind: 'diagnose' }, '진단 시작 표시를 쓰지 못했다');
    }
    const stamp = fileStamp(request.at);
    const files: string[] = [];
    const reportFile = join(o.diagDir, `report-${stamp}.json`);
    try {
      report(reportFile);
      // 바꿔 끼운 report 콜백이 파일을 만들지 않았으면 성공으로 세지 않고 올리지도 않는다(BAT-080 RV-20)
      if (!existsSync(reportFile)) throw new Error('report-not-written');
      await scrubReport(reportFile); // JSON이 아니면(바꿔 끼운 쓰는 함수) 그대로 둔다
      files.push(reportFile);
      count('report');
    } catch (err) {
      count('report_failed');
      o.logger.error({ err, kind: 'diagnose' }, '진단 보고서를 쓰지 못했다');
    }
    if (request.kind === 'heap') {
      const used = heap.used();
      const free = o.memoryLimitBytes === undefined ? undefined : o.memoryLimitBytes - heap.rss();
      if (free === undefined) {
        count('heap_skipped_no_limit');
        o.logger.warn({ kind: 'diagnose', reason: 'no-memory-limit' }, '메모리 한도를 몰라 힙 스냅샷을 건너뛰었다');
      } else if (!(free > 2 * used)) {
        count('heap_skipped_low_memory');
        o.logger.warn({ kind: 'diagnose', reason: 'low-memory', freeBytes: free, heapUsedBytes: used }, '메모리 여유가 힙의 두 배보다 적어 힙 스냅샷을 건너뛰었다');
      } else {
        const heapFile = join(o.diagDir, `heap-${stamp}.heapsnapshot`);
        const partial = `${heapFile}${DIAGNOSE_PARTIAL_SUFFIX}`;
        try {
          // 끝까지 쓴 것만 .heapsnapshot 이름을 받는다(쓰다 죽으면 .partial로 남아 올리지 않는다)
          await heap.snapshot(partial);
          await rename(partial, heapFile);
          files.push(heapFile);
          count('heap');
        } catch (err) {
          count('heap_failed');
          o.logger.error({ err, kind: 'diagnose' }, '힙 스냅샷을 쓰지 못했다');
        }
      }
    }
    let uploaded = 0;
    for (const f of files) if (await upload(keyOf(request.at, f), f)) uploaded += 1;
    try {
      await writeFile(markerFile, value);
      handled = value;
    } catch (err) {
      o.logger.error({ err, kind: 'diagnose' }, '진단 표시 파일을 쓰지 못했다(다시 뜨면 같은 수집을 되풀이한다)');
    }
    o.logger.warn({ kind: 'diagnose', request: request.kind, at: request.at, files: files.length, uploaded, elapsedMs: Math.round(o.clock.monotonicMs() - started) }, '진단 수집을 마쳤다(프로세스를 끝낸다)');
    if (!stopped) o.exit();
  };

  const poll = async (): Promise<void> => {
    if (stopped || busy) return;
    let text: string;
    try {
      text = await readFile(o.annotationsFile, 'utf8');
    } catch {
      return; // 파일이 아직 없으면(주석 없음) 다음에 다시 읽는다
    }
    const value = diagnoseAnnotationOf(text);
    if (value === undefined || value === '' || stopped) return;
    const mark = await readHandled();
    if (value === mark) return;
    if (mark === `${value}${DIAGNOSE_STARTED_SUFFIX}`) {
      // 같은 요청을 하다 죽었다(스냅샷 중 생존 프로브 재시작·OOM). 되풀이하면 CrashLoop로 가므로 끝난 것으로 적고 센다(리뷰 SEC-03)
      count('interrupted');
      o.logger.error({ kind: 'diagnose', annotation: DIAGNOSE_ANNOTATION }, '지난 진단 수집이 끝나지 못했다(되풀이하지 않는다)');
      try {
        await writeFile(markerFile, value);
      } catch (err) {
        o.logger.error({ err, kind: 'diagnose' }, '진단 표시 파일을 쓰지 못했다');
      }
      handled = value;
      return;
    }
    const request = parseDiagnoseRequest(value);
    if (!request) {
      if (!warned.has(value)) {
        warned.add(value);
        count('invalid_request');
        o.logger.warn({ kind: 'diagnose', annotation: DIAGNOSE_ANNOTATION }, '진단 주석 값의 형식이 틀려 무시한다(report@<UTC 시각> 또는 heap@<UTC 시각>, 분·초·밀리초 세 자리까지)');
      }
      return;
    }
    busy = true;
    await collect(value, request).catch((err: unknown) => {
      // 준비 상태를 내린 채 남지 않게 끝낸다(다시 뜬 프로세스가 표시 파일을 보고 정한다)
      o.logger.error({ err, kind: 'diagnose' }, '진단 수집이 실패했다(프로세스를 끝낸다)');
      if (!stopped) o.exit();
    });
  };

  const loop = () => {
    if (stopped) return;
    void poll().finally(() => {
      if (stopped || busy) return;
      pollTimer = setTimeout(loop, pollMs);
      pollTimer.unref();
    });
  };

  void uploadLeftovers().finally(loop);

  return {
    stop() {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      for (const w of waits) {
        clearTimeout(w.timer);
        w.done();
      }
      waits.clear();
    },
  };
}

/** 진단 수집을 켜는 환경 값(차트 deploy/charts/peaket-service가 넣는다) */
export const DIAGNOSE_ENV = Object.freeze({
  /** Downward API 주석 파일. 없으면 수집을 켜지 않는다(차트 밖에서 띄운 프로세스) */
  annotationsFile: 'PEAKET_DIAG_ANNOTATIONS_FILE',
  /** 진단 폴더(기본 /diag) */
  dir: 'PEAKET_DIAG_DIR',
  /** 증거 버킷 이름 */
  bucket: 'PEAKET_DIAG_BUCKET',
  /** 흉내 서버 주소(local·ci의 moto S3). 그 밖의 환경에서 주면 시작하지 않는다 */
  s3Endpoint: 'PEAKET_DIAG_S3_ENDPOINT',
  /** 컨테이너 메모리 한도(바이트, Downward API resourceFieldRef limits.memory) */
  memoryLimitBytes: 'PEAKET_MEMORY_LIMIT_BYTES',
} as const);

/** 증거 저장소 설정이 없을 때 경고만 하고 수집을 끄는 환경. 그 밖은 시작하지 않는다 */
export const DIAGNOSE_STORE_OPTIONAL: readonly PeaketEnv[] = ['local', 'ci'];

export interface DiagnoseEnvConfig {
  annotationsFile: string;
  diagDir: string;
  bucket?: string;
  s3Endpoint?: string;
  memoryLimitBytes?: number;
}

/**
 * 진단 수집 환경 값을 읽는다. 주석 파일 값이 없으면 undefined(수집 안 함).
 * 증거 저장소(버킷, local·ci는 moto 주소까지)가 없으면 local·ci는 missing에 빠진 이름을 담아 돌려주고(부르는 쪽이 경고 한 줄과 함께 끈다),
 * 그 밖의 환경은 빠진 이름을 대며 던진다(시작 실패). storeGiven이면 저장소 환경 값을 보지 않는다
 * @throws PlatformConfigError 운영 쪽 환경에서 버킷이 없음, 메모리 한도 값이 양의 정수가 아님
 */
export function diagnoseConfigFromEnv(env: Record<string, string | undefined>, peaketEnv: PeaketEnv, o: { storeGiven?: boolean } = {}): (DiagnoseEnvConfig & { missing: string[] }) | undefined {
  const annotationsFile = env[DIAGNOSE_ENV.annotationsFile];
  if (!annotationsFile) return undefined;
  const rawLimit = env[DIAGNOSE_ENV.memoryLimitBytes];
  let memoryLimitBytes: number | undefined;
  if (rawLimit !== undefined && rawLimit !== '') {
    if (!/^[1-9]\d{0,15}$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit))) throw new PlatformConfigError(`${DIAGNOSE_ENV.memoryLimitBytes}는 양의 정수(바이트)여야 한다: ${rawLimit}`);
    memoryLimitBytes = Number(rawLimit);
  }
  const bucket = env[DIAGNOSE_ENV.bucket] || undefined;
  const s3Endpoint = env[DIAGNOSE_ENV.s3Endpoint] || undefined;
  const optional = DIAGNOSE_STORE_OPTIONAL.includes(peaketEnv);
  // 흉내 S3 주소는 local·ci에서만 받는다. 그 밖에서는 증거를 전용 버킷 밖(http 포함)으로 보내지 않게 시작하지 않는다(리뷰 SEC-01)
  if (s3Endpoint && !optional) {
    throw new PlatformConfigError(`${DIAGNOSE_ENV.s3Endpoint}(흉내 S3 주소)는 ${DIAGNOSE_STORE_OPTIONAL.join('·')}에서만 쓴다(지금 ${peaketEnv}, 증거는 전용 버킷으로만 보낸다)`);
  }
  // 저장소를 코드로 넘겼으면(시험·다른 저장소) 저장소 환경 값을 보지 않는다
  const missing = o.storeGiven ? [] : [...(bucket ? [] : [DIAGNOSE_ENV.bucket]), ...(optional && !s3Endpoint ? [DIAGNOSE_ENV.s3Endpoint] : [])];
  if (!optional && missing.length > 0) {
    throw new PlatformConfigError(`진단 증거 저장소 설정이 없다: ${missing.join('·')}(${DIAGNOSE_ENV.annotationsFile}가 있는 ${peaketEnv}에서는 필요하다, RB-31)`);
  }
  return {
    annotationsFile,
    diagDir: env[DIAGNOSE_ENV.dir] || '/diag',
    ...(bucket ? { bucket } : {}),
    ...(s3Endpoint ? { s3Endpoint } : {}),
    ...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }),
    missing,
  };
}

// F-02-3 변경 동결 달력 단위 시험(정본: docs/devops.md §8.1·§8.2, D-T1·D-T4, OPS-320).
// 시험 이름의 값은 정본에서 가져온다. 이 파일은 시험 담당 몫이고 구현 담당은 고치지 않는다.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARGOCD_PROJECTS,
  activeWindowsAt,
  parseSchedule,
  renderCalendar,
  runCalendarOnce,
  windowsOf,
  type CalendarRun,
  type ScheduleSource,
} from '../src/calendar.js';

const E_LARGE = '0192f3a4-1111-7abc-8def-0123456789ab';
const E_MEDIUM = '0192f3a4-2222-7abc-8def-0123456789ab';
const E_SMALL = '0192f3a4-3333-7abc-8def-0123456789ab';
const E_OTHER = '0192f3a4-4444-7abc-8def-0123456789ab';
/** D-T1의 대형 회차: 2026-11-24 20:00 KST = 11:00Z */
const OPENS_LARGE = '2026-11-24T20:00:00+09:00';
const NOW = Date.parse('2026-11-24T09:00:00Z');

const iso = (s: string) => new Date(s).toISOString();
const entry = (eventId: string, opensAt: string, scale: 'large' | 'medium' | 'small') => ({ eventId, opensAt, scale });
const scheduleText = (onsales: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    revision: 7,
    generatedAt: '2026-11-24T08:55:00Z',
    onsales,
    ...extra,
  });

/** 파일 하나를 쓰는 임시 폴더(구현이 실제로 쓰는 경로를 본다) */
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'f023-calendar-'));
}

describe('F-02-3 동결 달력 — D-T1 창·렌더', () => {
  it('D-T1 ① 대형 회차(20:00 KST)를 승인하면 18:30~21:00 KST 창이 되고 ArgoCD deny 창(09:30 UTC·150분·manualSync)과 모든 NodePool 예산 0이 그려진다', () => {
    const schedule = parseSchedule(scheduleText([entry(E_LARGE, OPENS_LARGE, 'large')]));
    const windows = windowsOf(schedule, NOW);
    expect(windows).toHaveLength(1);
    const w = windows[0]!;
    expect(w.eventId).toBe(E_LARGE);
    expect(w.scale).toBe('large');
    expect(w.scope).toBe('all');
    expect(w.opensAt).toBe('2026-11-24T11:00:00.000Z');
    // 20:00 KST의 T-90분 = 18:30 KST = 09:30Z, T+60분 = 21:00 KST = 12:00Z
    expect(w.startsAt).toBe('2026-11-24T09:30:00.000Z');
    expect(w.endsAt).toBe('2026-11-24T12:00:00.000Z');
    expect(w.abortAt).toBe('2026-11-24T10:15:00.000Z');
    expect(w.argocd).toMatchObject({ kind: 'deny', schedule: '30 9 24 11 *', duration: '150m', manualSync: true });
    expect(w.argocd.applications).toEqual(['*']);
    expect(w.argocd.namespaces).toEqual(['*']);
    expect(w.argocd.clusters).toEqual(['*']);
    expect(w.karpenter).toEqual({ schedule: '30 9 24 11 *', duration: '150m', nodes: '0' });

    const render = renderCalendar(schedule, NOW);
    expect(render.argocd.projects.map((p) => p.project).sort()).toEqual([...ARGOCD_PROJECTS].sort());
    for (const p of render.argocd.projects) {
      expect(p.windows).toHaveLength(1);
      expect(p.windows[0]).toMatchObject({ kind: 'deny', schedule: '30 9 24 11 *', duration: '150m', manualSync: true });
    }
    expect(render.karpenter).toMatchObject({ allNodePools: true });
    expect(render.karpenter.budgets).toEqual([{ schedule: '30 9 24 11 *', duration: '150m', nodes: '0' }]);
    expect(render.calendar.schemaVersion).toBe(1);
    expect(render.calendar.revision).toBe(7);
    expect(render.calendar.renderedAt).toBe(new Date(NOW).toISOString());
    expect(render.calendar.windows).toEqual(windows);
  });

  it('D-T1 ② 중형은 대형과 같은 창·ArgoCD·Karpenter 값을 쓴다', () => {
    const schedule = parseSchedule(scheduleText([entry(E_MEDIUM, OPENS_LARGE, 'medium')]));
    const w = windowsOf(schedule, NOW)[0]!;
    expect(w.scope).toBe('all');
    expect(w.startsAt).toBe('2026-11-24T09:30:00.000Z');
    expect(w.abortAt).toBe('2026-11-24T10:15:00.000Z');
    expect(w.argocd.duration).toBe('150m');
    expect(w.karpenter.duration).toBe('150m');
  });

  it('D-T1 ③ 소형은 T-50분~T+60분·110분·hotpath 범위다', () => {
    const schedule = parseSchedule(scheduleText([entry(E_SMALL, OPENS_LARGE, 'small')]));
    const w = windowsOf(schedule, NOW)[0]!;
    expect(w.scope).toBe('hotpath');
    expect(w.startsAt).toBe('2026-11-24T10:10:00.000Z');
    expect(w.endsAt).toBe('2026-11-24T12:00:00.000Z');
    expect(w.abortAt).toBe('2026-11-24T10:45:00.000Z');
    expect(w.argocd.duration).toBe('110m');
    expect(w.argocd.schedule).toBe('10 10 24 11 *');
    expect(w.karpenter).toEqual({ schedule: '10 10 24 11 *', duration: '110m', nodes: '0' });
    const render = renderCalendar(schedule, NOW);
    // 소형은 모든 변경을 막지 않는다. all은 168시간 그대로, hotpath만 110분 줄어든다
    expect(render.calendar.deployableHoursNext7d.all).toBe(168);
    expect(render.calendar.deployableHoursNext7d.hotpath).toBeCloseTo(168 - 110 / 60, 6);
  });

  it('D-T1 ④ 7일 밖 회차는 빼고 지난 창은 지우며 배포 가능 시간을 줄인다', () => {
    const past = entry(E_OTHER, '2026-11-24T07:00:00+09:00', 'large'); // 22:00Z 전날, 이미 끝남
    const far = entry(E_MEDIUM, '2026-12-03T20:00:00+09:00', 'large'); // now + 8일 11시간
    const near = entry(E_SMALL, '2026-12-01T20:00:00+09:00', 'small'); // now + 7일 2시간(7일 밖)
    const inWindow = entry(E_LARGE, OPENS_LARGE, 'large');
    const schedule = parseSchedule(scheduleText([past, far, near, inWindow]));
    const windows = windowsOf(schedule, NOW);
    expect(windows.map((w) => w.eventId)).toEqual([E_LARGE]);
    const render = renderCalendar(schedule, NOW);
    expect(render.calendar.windows).toHaveLength(1);
    expect(render.calendar.deployableHoursNext7d.all).toBe(168 - 150 / 60);
    expect(render.calendar.deployableHoursNext7d.hotpath).toBe(168 - 150 / 60);
  });

  it('F023-WIN 경계: 창 시작 −1ms·정각·끝 +1ms와 자정을 넘는 창을 UTC로 센다', () => {
    const schedule = parseSchedule(scheduleText([entry(E_LARGE, OPENS_LARGE, 'large')]));
    const render = renderCalendar(schedule, NOW);
    const w = render.calendar.windows[0]!;
    expect(activeWindowsAt(render.calendar, Date.parse(w.startsAt) - 1)).toEqual([]);
    expect(activeWindowsAt(render.calendar, Date.parse(w.startsAt)).map((x) => x.eventId)).toEqual([E_LARGE]);
    expect(activeWindowsAt(render.calendar, Date.parse(w.endsAt) - 1).map((x) => x.eventId)).toEqual([E_LARGE]);
    expect(activeWindowsAt(render.calendar, Date.parse(w.endsAt))).toEqual([]);

    // 2026-11-25 00:30 KST = 2026-11-24 15:30Z. T-90분 창은 UTC로 11-24 14:00Z에 시작한다
    const midnight = parseSchedule(scheduleText([entry(E_MEDIUM, '2026-11-25T00:30:00+09:00', 'medium')]));
    const mw = windowsOf(midnight, Date.parse('2026-11-24T12:00:00Z'))[0]!;
    expect(mw.startsAt).toBe('2026-11-24T14:00:00.000Z');
    expect(mw.argocd.schedule).toBe('0 14 24 11 *');
    expect(mw.endsAt).toBe('2026-11-24T16:30:00.000Z');
  });

  it('F023-RENDER 겹치는 창은 배포 가능 시간에서 한 번만 빼고 프로젝트 아홉 모두에 같은 창을 건다', () => {
    const schedule = parseSchedule(
      scheduleText([entry(E_LARGE, OPENS_LARGE, 'large'), entry(E_MEDIUM, '2026-11-24T20:30:00+09:00', 'medium'), entry(E_SMALL, '2026-11-24T20:30:00+09:00', 'small')]),
    );
    const render = renderCalendar(schedule, NOW);
    expect(render.calendar.windows).toHaveLength(3);
    expect(render.argocd.projects).toHaveLength(9);
    for (const p of render.argocd.projects) expect(p.windows).toHaveLength(3);
    // 09:30Z~12:30Z(대형·중형·소형 합집합 180분)만 뺀다
    expect(render.calendar.deployableHoursNext7d.all).toBe(168 - 180 / 60);
    expect(render.calendar.deployableHoursNext7d.hotpath).toBe(168 - 180 / 60);
  });
});

describe('F-02-3 동결 달력 — 일정 꼴', () => {
  it('F023-SCHED 승인되지 않은 회차·겹친 eventId·모르는 scale·모르는 칸·대문자 UUID는 거절한다', () => {
    expect(() => parseSchedule(scheduleText([{ ...entry(E_LARGE, OPENS_LARGE, 'large'), approved: false }]))).toThrow();
    expect(() => parseSchedule(scheduleText([entry(E_LARGE, OPENS_LARGE, 'large'), entry(E_LARGE, OPENS_LARGE, 'small')]))).toThrow();
    expect(() => parseSchedule(scheduleText([entry(E_LARGE, OPENS_LARGE, 'huge' as 'large')]))).toThrow();
    expect(() => parseSchedule(scheduleText([{ ...entry(E_LARGE, OPENS_LARGE, 'large'), extra: 1 }]))).toThrow();
    expect(() => parseSchedule(scheduleText([entry(E_LARGE.toUpperCase(), OPENS_LARGE, 'large')]))).toThrow();
    expect(() => parseSchedule(scheduleText([entry(E_LARGE, '2026-11-24 20:00', 'large')]))).toThrow();
    expect(() => parseSchedule(JSON.stringify({ revision: 7, generatedAt: '2026-11-24T08:55:00Z', onsales: [], extra: true }))).toThrow();
    expect(() => parseSchedule('not json')).toThrow();
  });

  it('F023-SCHED 빈 목록은 창 0개이고, 승인 표시가 없으면 승인된 것으로 본다', () => {
    const empty = parseSchedule(scheduleText([]));
    expect(windowsOf(empty, NOW)).toEqual([]);
    expect(renderCalendar(empty, NOW).calendar.deployableHoursNext7d).toEqual({ all: 168, hotpath: 168 });
    expect(() => parseSchedule(scheduleText([entry(E_LARGE, OPENS_LARGE, 'large')]))).not.toThrow();
  });
});

describe('F-02-3 동결 달력 — D-T4 닫힘 실패', () => {
  it('D-T4 ① 일정 파일을 못 읽거나 30분 넘게 낡으면 freeze.json을 바꾸지 않고 정상 종료한다', async () => {
    const root = tempRoot();
    const writes: string[] = [];
    const deps = {
      writer: { write: async (path: string) => void writes.push(path) },
      applier: { apply: async () => void writes.push('argocd') },
      budgetApplier: { apply: async () => void writes.push('karpenter') },
      now: () => NOW,
    };
    const unavailable: ScheduleSource = { read: async () => Promise.reject(new Error('S3 down')) };
    const a = await runCalendarOnce({ ...deps, source: unavailable, root });
    expect(a).toMatchObject({ result: 'skipped', reason: 'source-unavailable' });
    expect(writes).toEqual([]);

    const stale: ScheduleSource = {
      read: async () => ({ text: scheduleText([entry(E_LARGE, OPENS_LARGE, 'large')], { generatedAt: '2026-11-24T08:29:59.999Z' }) }),
    };
    const b = await runCalendarOnce({ ...deps, source: stale, root });
    expect(b).toMatchObject({ result: 'skipped', reason: 'source-stale' });
    expect(writes).toEqual([]);

    const boundary: ScheduleSource = {
      read: async () => ({ text: scheduleText([entry(E_LARGE, OPENS_LARGE, 'large')], { generatedAt: '2026-11-24T08:30:00.000Z' }) }),
    };
    const c = await runCalendarOnce({ ...deps, source: boundary, root });
    expect(c.result).toBe('rendered');
    expect(writes).toContain('deploy/calendar/freeze.json');
  });

  it('D-T4 ① 일정 JSON이 깨졌으면 조용히 넘기지 않고 실패한다', async () => {
    const root = tempRoot();
    const deps = {
      writer: { write: async () => {} },
      now: () => NOW,
      root,
    };
    await expect(runCalendarOnce({ ...deps, source: { read: async () => ({ text: '{' }) } })).rejects.toThrow();
    await expect(
      runCalendarOnce({ ...deps, source: { read: async () => ({ text: scheduleText([entry('nope', OPENS_LARGE, 'large')]) }) } }),
    ).rejects.toThrow();
  });

  it('D-T4 ① 성공하면 freeze.json·ArgoCD 창·Karpenter 예산을 쓰고 적용 포트를 부른다', async () => {
    const root = tempRoot();
    const files = new Map<string, string>();
    const applied: unknown[] = [];
    const budgets: unknown[] = [];
    const logs: Record<string, unknown>[] = [];
    const run: CalendarRun = await runCalendarOnce({
      root,
      now: () => NOW,
      source: { read: async () => ({ text: scheduleText([entry(E_LARGE, OPENS_LARGE, 'large')]) }) },
      writer: {
        write: async (path, text) => {
          files.set(path, text);
        },
      },
      applier: { apply: async (r) => void applied.push(JSON.parse(JSON.stringify(r))) },
      budgetApplier: { apply: async (b) => void budgets.push(JSON.parse(JSON.stringify(b))) },
      log: (line) => void logs.push(line),
    });
    expect(run.result).toBe('rendered');
    expect([...files.keys()].sort()).toEqual([
      'deploy/calendar/freeze.json',
      'deploy/calendar/rendered/argocd-windows.json',
      'deploy/calendar/rendered/karpenter-budgets.json',
    ]);
    const doc = JSON.parse(files.get('deploy/calendar/freeze.json')!);
    expect(doc.windows).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(budgets).toEqual([{ allNodePools: true, budgets: [{ schedule: '30 9 24 11 *', duration: '150m', nodes: '0' }] }]);
    expect(logs.some((l) => l.event === 'freeze_calendar_rendered')).toBe(true);
  });

  it('D-T4 ③ 달력 장애 중에도 이미 쓴 freeze.json은 그대로 두고 산출물을 다시 쓰지 않는다', async () => {
    const root = tempRoot();
    const path = join(root, 'deploy/calendar/freeze.json');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'deploy/calendar'), { recursive: true });
    writeFileSync(path, '{"schemaVersion":1,"revision":1,"renderedAt":"2026-11-24T08:00:00.000Z","windows":[],"deployableHoursNext7d":{"all":168,"hotpath":168}}');
    let wrote = 0;
    const run = await runCalendarOnce({
      root,
      now: () => NOW,
      source: { read: async () => Promise.reject(new Error('S3 down')) },
      writer: { write: async () => void (wrote += 1) },
    });
    expect(run.result).toBe('skipped');
    expect(wrote).toBe(0);
  });
});

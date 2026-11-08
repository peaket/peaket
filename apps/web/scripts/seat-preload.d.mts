export function seatPreloadFrom(m: { rootMainFiles: string[]; entryJSFiles: Record<string, string[]>; entryCSSFiles: Record<string, { path: string; inlined: boolean }[]> }): { v: 1; assets: string[] };
export function writeSeatPreload(o: { distDir: string }): { assets: number };

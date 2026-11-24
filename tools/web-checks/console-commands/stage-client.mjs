// F-03-4 실제 서버 무대의 시험 쪽 도우미(console-commands/stage.mjs가 여는 제어 HTTP).
export const STAGE_URL = process.env.PEAKET_CONSOLE_COMMANDS_STAGE ?? 'http://127.0.0.1:4281';

async function json(path, init) {
  const r = await fetch(`${STAGE_URL}${path}`, init);
  const body = await r.json().catch(() => undefined);
  if (!r.ok) throw new Error(`${path} ${r.status}: ${JSON.stringify(body)}`);
  return body;
}

export const stageStatus = () => json('/stage/status');
export const stageLogs = () => json('/stage/logs');
export const storesOf = (eventId, commandId) => json(`/stage/stores?event=${encodeURIComponent(eventId)}&commandId=${encodeURIComponent(commandId)}`);
export const restartOps = (body) => json('/stage/ops/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

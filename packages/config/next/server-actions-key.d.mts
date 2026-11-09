// server-actions-key.mjs의 타입(next.config.ts가 가져온다)
export declare const KEY_ENV: 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY';
export declare const KEY_BYTES: 32;
export declare function checkServerActionsKey(value: string | undefined): { ok: true } | { ok: false; reason: string };
export declare function assertServerActionsKey(env?: Record<string, string | undefined>): void;

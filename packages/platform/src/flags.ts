// 릴리스 플래그 파일 모드 감싸개(docs/devops.md §5.4, ADR-0386 결정 5, BAS-060, F-09-2).
// - flagd 파일 모드 정의(JSON)를 프로세스 안에서 읽는다. 네트워크를 부르지 않는다.
// - 정의가 깨지거나 공급자 평가가 실패하면 코드 기본값(꺼짐)으로 동작한다.
// - 플래그마다 소유자·만료일·기본 꺼짐이 있어야 한다(검사기는 tools/ci/release-flags.mjs).
import { readFile } from 'node:fs/promises';

export interface FlagDefinition {
  state: 'ENABLED' | 'DISABLED';
  variants: { on: boolean; off: boolean };
  defaultVariant: 'off';
  metadata: { owner: string; expiresAt: string };
  targeting?: unknown;
}

export interface FlagDefinitions {
  flags: Record<string, FlagDefinition>;
}

export type FlagErrorCode = 'FLAG_METADATA_REQUIRED' | 'FLAG_DEFAULT_NOT_OFF' | 'FLAG_VARIANTS_INVALID';

export class FlagError extends Error {
  readonly code: FlagErrorCode;

  constructor(code: FlagErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FlagError';
    this.code = code;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export function parseFlagDefinitions(json: unknown): FlagDefinitions {
  const root = asRecord(json);
  const flags = asRecord(root?.flags);
  if (!flags) return { flags: {} };
  const parsed: Record<string, FlagDefinition> = {};
  for (const [name, raw] of Object.entries(flags)) {
    const flag = asRecord(raw);
    if (!flag) throw new FlagError('FLAG_VARIANTS_INVALID', `${name} 정의가 객체가 아니다`);
    const metadata = asRecord(flag.metadata);
    const owner = typeof metadata?.owner === 'string' ? metadata.owner.trim() : '';
    const expiresAt = typeof metadata?.expiresAt === 'string' ? metadata.expiresAt.trim() : '';
    if (!owner || !expiresAt) throw new FlagError('FLAG_METADATA_REQUIRED', `${name}에 metadata.owner·metadata.expiresAt이 필요하다`);
    if (flag.defaultVariant !== 'off') throw new FlagError('FLAG_DEFAULT_NOT_OFF', `${name}의 defaultVariant는 off여야 한다`);
    const variants = asRecord(flag.variants);
    if (variants?.on !== true || variants?.off !== false) {
      throw new FlagError('FLAG_VARIANTS_INVALID', `${name}의 variants는 {on:true, off:false}여야 한다`);
    }
    parsed[name] = {
      state: flag.state === 'DISABLED' ? 'DISABLED' : 'ENABLED',
      variants: { on: true, off: false },
      defaultVariant: 'off',
      metadata: { owner, expiresAt },
      targeting: flag.targeting,
    };
  }
  return { flags: parsed };
}

export interface ReleaseFlags {
  getBoolean(name: string, defaultValue?: boolean, context?: { account?: string }): boolean;
  close(): Promise<void>;
}

export interface CreateReleaseFlagsOptions {
  configPath: string;
  now?: () => Date;
  provider?: unknown;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

const chooseVariant = (flag: FlagDefinition, context?: { account?: string }): 'on' | 'off' => {
  if (flag.state === 'DISABLED') return 'off';
  const targeting = asRecord(flag.targeting);
  const rules = Array.isArray(targeting?.if) ? targeting.if : undefined;
  if (!rules || rules.length < 3) return 'off';
  const condition = asRecord(rules[0]);
  const equals = Array.isArray(condition?.['===']) ? condition['==='] : undefined;
  if (!equals || equals.length !== 2) return 'off';
  const left = asRecord(equals[0]);
  const right = equals[1];
  if (left?.var === 'account' && typeof right === 'string' && context?.account === right) {
    return rules[1] === 'on' ? 'on' : 'off';
  }
  return rules[2] === 'on' ? 'on' : 'off';
};

export async function createReleaseFlags(options: CreateReleaseFlagsOptions): Promise<ReleaseFlags> {
  let definitions: FlagDefinitions = { flags: {} };
  try {
    definitions = parseFlagDefinitions(JSON.parse(await readFile(options.configPath, 'utf8')));
  } catch (error) {
    options.log?.(`릴리스 플래그 정의를 읽지 못해 모두 꺼짐으로 동작한다: ${error instanceof Error ? error.name : 'unknown'}`);
  }
  return {
    getBoolean(name, _defaultValue = false, context) {
      try {
        const flag = definitions.flags[name];
        if (!flag) return false;
        const provider = asRecord(options.provider);
        if (typeof provider?.evaluate === 'function') {
          (provider.evaluate as (flagName: string, ctx?: unknown) => unknown)(name, context);
        }
        const variant = chooseVariant(flag, context);
        return variant === 'on' ? flag.variants.on : flag.variants.off;
      } catch {
        return false;
      }
    },
    async close() {
      // 파일 모드 공급자는 닫을 자원이 없다.
    },
  };
}

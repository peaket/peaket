// security-headers.mjs의 타입(앱의 TypeScript 코드가 가져다 쓴다, BUILD_ORDER HOT-290)
export type CspBundle = 'A' | 'A′' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type CspVariant = 'humanCheck' | 'identityForm' | 'partner';
export interface ProdOrigins {
  api: string;
  queue: string;
  queueFiles: string;
  partnerApi: string;
  opsApi: string;
  scannerApi: string;
  apiWs: string;
}
export const PROD_ORIGINS: Readonly<ProdOrigins>;
export const CSP_VARIANTS: Readonly<Record<CspVariant, { add?: Record<string, string[]>; set?: Record<string, string[]> }>>;
export const CSP: Readonly<Record<Exclude<CspBundle, 'E' | 'F'>, string>>;
export const CSP_ADDITIONS: Readonly<Record<'E' | 'F', Record<string, string[]>>>;
export const CLOUDFRONT_CSP_MAX: number;
export const REPORTING_ENDPOINTS: string;
export type PageHeaderSet = Readonly<Record<string, string>>;
export const PAGE_HEADERS: Readonly<Record<'web' | 'seats' | 'checkout' | 'partner' | 'console' | 'scanner' | 'forensics', PageHeaderSet>>;
export function trustedTypesReportOnly(remotes?: string[]): string;
export function renderCsp(
  bundle: CspBundle,
  o?: { nonce?: string; hashes?: string[]; origins?: Partial<ProdOrigins> & { identity?: string }; variants?: CspVariant[]; raw?: boolean },
): string;
export function staticAppHeaders(
  app: 'queue-room' | 'console' | 'scanner' | 'forensics',
  o?: { hashes?: string[]; origins?: Partial<ProdOrigins> & { identity?: string }; remotes?: string[] },
): Record<string, string>;

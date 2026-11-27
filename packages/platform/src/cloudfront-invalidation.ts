// CloudFront 무효화 어댑터(기능 F-09-4, HOT-450, docs/infra.md §4.1 '공연 페이지 배포의 캐시 태그').
// 실제 AWS SDK를 더하지 않고 SigV4 서명과 주입한 fetch로 `CreateInvalidation`을 부른다.
// 태그는 `#event:{id}`처럼 `#` 접두사를 써야 CloudFront가 경로가 아니라 캐시 태그로 읽는다.
import { createHash, createHmac, randomUUID } from 'node:crypto';

export type CloudFrontInvalidationErrorCode = 'CONFIG' | 'INVALIDATION_FAILED';

export class CloudFrontInvalidationError extends Error {
  readonly code: CloudFrontInvalidationErrorCode;
  constructor(code: CloudFrontInvalidationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CloudFrontInvalidationError';
    this.code = code;
  }
}

export interface CloudFrontCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface CloudFrontFetchResponse {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

export type CloudFrontFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<CloudFrontFetchResponse>;

export interface CloudFrontInvalidationOptions {
  distributionId: string;
  credentials: CloudFrontCredentials;
  fetch: CloudFrontFetch;
  /** CloudFront API는 전역이라 기본 us-east-1이다 */
  region?: string;
  now?: () => Date;
}

const API_HOST = 'cloudfront.amazonaws.com';
const API_VERSION = '2020-05-31';

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string): Buffer => createHmac('sha256', key).update(value, 'utf8').digest();

function amzDate(date: Date): { full: string; short: string } {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { full: iso, short: iso.slice(0, 8) };
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** SigV4 Authorization 머리. 서명 대상은 host·x-amz-date·x-amz-content-sha256·content-type이다. */
function authorization(options: {
  method: string;
  path: string;
  body: string;
  region: string;
  credentials: CloudFrontCredentials;
  date: Date;
}): { authorization: string; amzDate: string; payloadHash: string } {
  const { full, short } = amzDate(options.date);
  const payloadHash = sha256Hex(options.body);
  const headers: Record<string, string> = {
    'content-type': 'text/xml',
    host: API_HOST,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': full,
  };
  if (options.credentials.sessionToken) headers['x-amz-security-token'] = options.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [options.method, options.path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${short}/${options.region}/cloudfront/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', full, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${options.credentials.secretAccessKey}`, short);
  const kRegion = hmac(kDate, options.region);
  const kService = hmac(kRegion, 'cloudfront');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate: full,
    payloadHash,
  };
}

export class CloudFrontInvalidation {
  readonly #options: Required<Pick<CloudFrontInvalidationOptions, 'distributionId' | 'credentials' | 'fetch' | 'region'>> & {
    now: () => Date;
  };

  constructor(options: CloudFrontInvalidationOptions) {
    if (!options.distributionId) throw new CloudFrontInvalidationError('CONFIG', 'CloudFront 배포 ID가 비었다');
    if (!options.credentials?.accessKeyId || !options.credentials?.secretAccessKey) {
      throw new CloudFrontInvalidationError('CONFIG', 'CloudFront 자격 증명이 비었다');
    }
    if (typeof options.fetch !== 'function') throw new CloudFrontInvalidationError('CONFIG', 'fetch가 없다');
    this.#options = {
      distributionId: options.distributionId,
      credentials: options.credentials,
      fetch: options.fetch,
      region: options.region ?? 'us-east-1',
      now: options.now ?? (() => new Date()),
    };
  }

  /** 태그 무효화. `event:e1`을 주면 `#event:e1`로 보낸다(이미 `#`이면 그대로). */
  async invalidateTags(tags: string[]): Promise<{ id: string | null }> {
    return this.#invalidate(tags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)));
  }

  /** 경로 무효화. `/v1/search*`처럼 `#` 없이 보낸다. */
  async invalidatePaths(paths: string[]): Promise<{ id: string | null }> {
    return this.#invalidate(paths);
  }

  async #invalidate(items: string[]): Promise<{ id: string | null }> {
    if (items.length === 0) return { id: null };
    const path = `/${API_VERSION}/distribution/${encodeURIComponent(this.#options.distributionId)}/invalidation`;
    const body =
      `<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/${API_VERSION}/">` +
      `<Paths><Quantity>${items.length}</Quantity><Items>` +
      items.map((item) => `<Path>${xmlEscape(item)}</Path>`).join('') +
      `</Items></Paths><CallerReference>${xmlEscape(randomUUID())}</CallerReference></InvalidationBatch>`;
    const signed = authorization({
      method: 'POST',
      path,
      body,
      region: this.#options.region,
      credentials: this.#options.credentials,
      date: this.#options.now(),
    });
    const headers: Record<string, string> = {
      Authorization: signed.authorization,
      'content-type': 'text/xml',
      'x-amz-content-sha256': signed.payloadHash,
      'x-amz-date': signed.amzDate,
    };
    if (this.#options.credentials.sessionToken) headers['x-amz-security-token'] = this.#options.credentials.sessionToken;

    let response: CloudFrontFetchResponse;
    try {
      response = await this.#options.fetch(`https://${API_HOST}${path}`, { method: 'POST', headers, body });
    } catch (error) {
      throw new CloudFrontInvalidationError('INVALIDATION_FAILED', 'CloudFront 무효화 요청이 실패했다', { cause: error });
    }
    if (!response.ok) {
      throw new CloudFrontInvalidationError('INVALIDATION_FAILED', `CloudFront 무효화가 ${response.status}로 실패했다`);
    }
    const parsed = await parseInvalidation(response);
    if (!parsed) throw new CloudFrontInvalidationError('INVALIDATION_FAILED', 'CloudFront 응답에서 무효화 ID를 읽지 못했다');
    return { id: parsed };
  }
}

async function parseInvalidation(response: CloudFrontFetchResponse): Promise<string | null> {
  if (response.json) {
    try {
      const json = (await response.json()) as { Invalidation?: { Id?: unknown } };
      if (typeof json?.Invalidation?.Id === 'string' && json.Invalidation.Id) return json.Invalidation.Id;
    } catch {
      // XML 응답이면 아래에서 읽는다
    }
  }
  if (response.text) {
    try {
      const text = await response.text();
      const xml = /<Id>([^<]+)<\/Id>/.exec(text);
      if (xml?.[1]) return xml[1];
      const json = /"Id"\s*:\s*"([^"]+)"/.exec(text);
      if (json?.[1]) return json[1];
    } catch {
      return null;
    }
  }
  return null;
}

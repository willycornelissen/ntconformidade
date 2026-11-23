import { isAllowedHttpUrl } from '../domain/validators.js';
import { sanitizeLogMessage } from '../privacy/dlp-filter.js';

const DEFAULT_MAX_REDIRECTS = 0;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Signature for injecting `fetch` in unit tests without live network traffic. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Typed HTTP status error preserving numeric status code safely without raw body credential leaks. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, cleanBody: string) {
    super(`Erro HTTP ${status} do provedor remoto: ${cleanBody}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/** Options for sending JSON GET requests with SSRF-guarded manual redirect handling. */
export interface GetJsonRequestOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly allowLoopbackHttp: boolean;
  readonly allowPrivateHttps?: boolean;
  readonly secretToRedact?: string;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly fetchFn?: FetchFn;
}

/** Options for sending JSON POST requests with SSRF-guarded manual redirect handling. */
export interface PostJsonRequestOptions extends GetJsonRequestOptions {
  readonly body: unknown;
}

/** Scrubs literal BYOK/Gitea secret values and token patterns before logging or throwing errors. */
export function scrubSecret(rawText: string, secretToRedact?: string): string {
  let scrubbed = rawText;
  if (secretToRedact && secretToRedact.length >= 4) {
    scrubbed = scrubbed.split(secretToRedact).join('[REDACTED]');
  }
  return sanitizeLogMessage(scrubbed);
}

function validateUrlPolicy(
  rawUrl: string,
  options: { readonly allowLoopbackHttp: boolean; readonly allowPrivateHttps?: boolean },
): URL {
  if (!isAllowedHttpUrl(rawUrl, options)) {
    throw new Error(`URL bloqueada por política SSRF: ${sanitizeLogMessage(rawUrl)}`);
  }
  return new URL(rawUrl);
}

function validateRedirectTarget(
  location: string,
  currentUrl: URL,
  hasAuthHeader: boolean,
  options: { readonly allowLoopbackHttp: boolean; readonly allowPrivateHttps?: boolean },
): string {
  let nextUrl: URL;
  try {
    nextUrl = new URL(location, currentUrl);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Redirecionamento inválido bloqueado por SSRF: ${sanitizeLogMessage(msg)}`);
  }

  validateUrlPolicy(nextUrl.toString(), options);

  if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') {
    throw new Error('Redirecionamento inseguro HTTPS -> HTTP bloqueado por política SSRF');
  }
  if (hasAuthHeader && nextUrl.origin !== currentUrl.origin) {
    throw new Error('Redirecionamento cross-origin com credenciais bloqueado por política SSRF');
  }
  return nextUrl.toString();
}

async function readBoundedResponseText(response: Response, secretToRedact?: string): Promise<string> {
  if (!response.body) {
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error(`Resposta HTTP excede limite de ${MAX_RESPONSE_BYTES} bytes`);
      }
      return text;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Falha ao ler resposta HTTP: ${scrubSecret(msg, secretToRedact)}`);
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Resposta HTTP excede limite de ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Falha ao ler corpo HTTP: ${scrubSecret(msg, secretToRedact)}`);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function hasCredentialHeaders(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((key) =>
    /^(authorization|x-goog-api-key|x-api-key)$/i.test(key),
  );
}

async function requestJsonWithManualRedirects(
  method: 'GET' | 'POST',
  options: GetJsonRequestOptions & { readonly body?: unknown },
): Promise<unknown> {
  const fetchFn: FetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const policy = {
    allowLoopbackHttp: options.allowLoopbackHttp,
    allowPrivateHttps: options.allowPrivateHttps,
  };
  const authPresent = hasCredentialHeaders(options.headers);
  let currentUrl = validateUrlPolicy(options.url, policy).toString();
  const serializedBody = method === 'POST' ? JSON.stringify(options.body) : undefined;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...options.headers,
      };
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
      }
      response = await fetchFn(currentUrl, {
        method,
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Falha de transporte HTTP: ${scrubSecret(msg, options.secretToRedact)}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new Error(`Redirecionamento HTTP ${response.status} sem header Location`);
      }
      const next = validateRedirectTarget(location, new URL(currentUrl), authPresent, policy);
      if (hop === maxRedirects) {
        throw new Error(`Redirecionamento bloqueado (máximo=${maxRedirects})`);
      }
      currentUrl = next;
      continue;
    }

    const rawBody = await readBoundedResponseText(response, options.secretToRedact);
    if (!response.ok) {
      throw new HttpStatusError(response.status, scrubSecret(rawBody.slice(0, 500), options.secretToRedact));
    }

    try {
      return JSON.parse(rawBody) as unknown;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Resposta JSON inválida do provedor HTTP: ${scrubSecret(msg, options.secretToRedact)}`);
    }
  }

  throw new Error('Fluxo de redirecionamento HTTP encerrado inesperadamente');
}

/**
 * Fetches JSON using HTTP GET with `redirect: 'manual'`, SSRF policy enforcement, bounded reads,
 * and automatic secret scrubbing.
 */
export function getJsonWithManualRedirects(options: GetJsonRequestOptions): Promise<unknown> {
  return requestJsonWithManualRedirects('GET', options);
}

/**
 * Posts JSON using `redirect: 'manual'`, rejecting cross-origin or downgrade redirects when credentials
 * are sent, enforcing bounded response reads, and scrubbing secrets from all error messages.
 */
export function postJsonWithManualRedirects(options: PostJsonRequestOptions): Promise<unknown> {
  return requestJsonWithManualRedirects('POST', options);
}

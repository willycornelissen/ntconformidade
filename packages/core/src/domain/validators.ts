import net from 'node:net';

const CONTROL_CHARS_RE = /[\r\n]/;

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 0 && c === 0) {
    return true;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return a === 192 && b === 168;
}

function isPrivateIpv6(rawIp: string): boolean {
  const withoutZone = rawIp.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const lower = withoutZone.toLowerCase();
  if (
    lower === '::1' ||
    lower === '::' ||
    /^fe[89ab][0-9a-f]?:/i.test(lower) ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('ff') ||
    lower.startsWith('64:ff9b::')
  ) {
    return true;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::7f')) {
    const mapped = lower.slice(lower.lastIndexOf(':') + 1);
    if (isPrivateIpv4(mapped)) {
      return true;
    }
    const tail = lower.slice(lower.indexOf('::ffff:') >= 0 ? '::ffff:'.length : 2);
    const hexParts = tail.split(':');
    if (hexParts.length === 2) {
      const hi = Number.parseInt(hexParts[0] ?? '0', 16);
      const lo = Number.parseInt(hexParts[1] ?? '0', 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIpv4(ipv4);
      }
    }
  }
  return false;
}

export function isPrivateOrReservedHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/\.+$/, '');
  const bare = host.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  const ipVersion = net.isIP(bare);
  if (ipVersion === 4) {
    return isPrivateIpv4(bare);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(bare);
  }
  return false;
}

export function isLoopbackHostname(rawHost: string): boolean {
  const lower = rawHost.toLowerCase().replace(/\.+$/, '');
  return lower === 'localhost' || lower.endsWith('.localhost') || lower === '127.0.0.1' || lower === '[::1]';
}

export function isSafeHttpsUrl(rawUrl: string, disallowPrivateHosts = true): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return false;
    }
    if (disallowPrivateHosts && isPrivateOrReservedHost(parsed.hostname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isAllowedByokUrl(rawUrl: string, allowLoopbackHttp: boolean): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password || parsed.hash) {
      return false;
    }
    if (/[?&]key=/i.test(parsed.search)) {
      return false;
    }
    if (parsed.protocol === 'https:') {
      const bareHost = parsed.hostname.replace(/^\[|\]$/g, '');
      return !isPrivateOrReservedHost(parsed.hostname) && net.isIP(bareHost) === 0;
    }
    if (allowLoopbackHttp && parsed.protocol === 'http:') {
      return isLoopbackHostname(parsed.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

export function isAllowedHttpUrl(
  rawUrl: string,
  options: { readonly allowLoopbackHttp?: boolean; readonly allowPrivateHttps?: boolean } = {},
): boolean {
  if (options.allowPrivateHttps) {
    return isSafeHttpsUrl(rawUrl, false);
  }
  return isAllowedByokUrl(rawUrl, options.allowLoopbackHttp ?? false);
}

export function isValidCalendarIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

export function normalizeRepoRelativePath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function isSafeRelativeRepoPath(filePath: string): boolean {
  if (!filePath || filePath.includes('\0') || filePath.includes('\\') || CONTROL_CHARS_RE.test(filePath)) {
    return false;
  }
  if (filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) {
    return false;
  }
  const segments = filePath.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return false;
  }
  return !segments.some((seg) => seg.toLowerCase() === 'test-files');
}

export function hasPdfMagicHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(1024, bytes.length);
  const head = Buffer.from(bytes.subarray(0, limit)).toString('latin1');
  return head.includes('%PDF-');
}

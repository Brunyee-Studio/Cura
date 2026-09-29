import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const OCR_VERSION = 'v1.12.11';

const RELEASES_URL = 'https://github.com/alibaba/open-code-review/releases/download';
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const ARCH_NAMES: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };

export interface ResolveOcrOptions {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  binDir: string;
  which: (cmd: string) => string | null;
  fetch: typeof fetch;
}

export function assetName(platform: NodeJS.Platform, arch: string): string {
  const os = OS_NAMES[platform];
  const cpu = Object.hasOwn(ARCH_NAMES, arch) ? ARCH_NAMES[arch] : undefined;
  if (!os || !cpu) throw new Error(`unsupported platform: ${platform}/${arch}`);
  return `opencodereview-${os}-${cpu}${platform === 'win32' ? '.exe' : ''}`;
}

export function verifyChecksum(data: Uint8Array, sums: string, asset: string): boolean {
  const actual = createHash('sha256').update(data).digest('hex');
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+?)\s*$/.exec(line);
    if (match && match[2] === asset) return match[1].toLowerCase() === actual;
  }
  return false;
}

async function download(fetchFn: typeof fetch, url: string): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`ocr download failed: ${url} returned ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function resolveOcr(opts: ResolveOcrOptions): Promise<string> {
  const existing = opts.which('ocr');
  if (existing) return existing;

  const asset = assetName(opts.platform, opts.arch);
  const base = `${RELEASES_URL}/${opts.version}`;
  const [binary, sums] = await Promise.all([
    download(opts.fetch, `${base}/${asset}`),
    download(opts.fetch, `${base}/sha256sum.txt`),
  ]);
  if (!verifyChecksum(binary, new TextDecoder().decode(sums), asset)) throw new Error('ocr checksum mismatch');

  await mkdir(opts.binDir, { recursive: true });
  const target = join(opts.binDir, opts.platform === 'win32' ? 'ocr.exe' : 'ocr');
  await writeFile(target, binary, { mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}

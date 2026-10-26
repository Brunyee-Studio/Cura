import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const OCR_VERSION = 'v1.12.11';

// The hashes live in Cura, not in the release's own sha256sum.txt: whoever can
// replace a release asset can replace the sums file beside it too.
export const OCR_SHA256: Readonly<Record<string, string>> = {
  'opencodereview-darwin-amd64': '561d59dc929d48f6329df2f653949bd90296fc44d447a29189f2c1199e5ec535',
  'opencodereview-darwin-arm64': '5580b7b2dfec9343dc34951eb185a1e7ee552061f68b06dca7de0b171e8cd204',
  'opencodereview-linux-amd64': 'ae202b88fa03e16926512487bf1051d37ccb3f9690bdd74b889d11ea4dd8099b',
  'opencodereview-linux-arm64': '4db2d5c81c75a0bcbf2dd5d584cee92cfb0774989f7687891752a96c4ebd2b99',
  'opencodereview-windows-amd64.exe': '2bb9ec31b58cea4e8e289c31b41d621ae4d3f55d941b79f14ef3c297fd7f1f5f',
  'opencodereview-windows-arm64.exe': 'e2249699367527f35017e9a7ca3e448047697bf1f755d88b356d3f70f59f9995',
};

const RELEASES_URL = 'https://github.com/alibaba/open-code-review/releases/download';
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const ARCH_NAMES: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };

export interface ResolveOcrOptions {
  version: string;
  /** Expected SHA-256 of the asset; required when `version` is not OCR_VERSION. */
  sha256?: string;
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

export function expectedSha256(version: string, asset: string, override?: string): string {
  if (override) {
    if (!/^[0-9a-fA-F]{64}$/.test(override)) throw new Error('ocr_sha256 must be 64 hex characters');
    return override.toLowerCase();
  }
  const pinned = version === OCR_VERSION && Object.hasOwn(OCR_SHA256, asset) ? OCR_SHA256[asset] : undefined;
  if (!pinned) throw new Error(`ocr ${version} is not the version pinned in Cura (${OCR_VERSION}); set ocr_sha256 to the SHA-256 of ${asset}`);
  return pinned;
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
  const expected = expectedSha256(opts.version, asset, opts.sha256);
  const binary = await download(opts.fetch, `${RELEASES_URL}/${opts.version}/${asset}`);
  if (createHash('sha256').update(binary).digest('hex') !== expected) throw new Error('ocr checksum mismatch');

  await mkdir(opts.binDir, { recursive: true });
  const target = join(opts.binDir, opts.platform === 'win32' ? 'ocr.exe' : 'ocr');
  await writeFile(target, binary, { mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}

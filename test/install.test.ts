import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { assetName, expectedSha256, OCR_SHA256, OCR_VERSION, resolveOcr } from '../src/install.ts';

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const binary = new TextEncoder().encode('#!/bin/sh\necho ocr\n');
const ASSET = 'opencodereview-linux-amd64';
const BASE = `https://github.com/alibaba/open-code-review/releases/download/${OCR_VERSION}`;

describe('assetName', () => {
  test.each([
    ['linux', 'x64', 'opencodereview-linux-amd64'],
    ['linux', 'arm64', 'opencodereview-linux-arm64'],
    ['darwin', 'x64', 'opencodereview-darwin-amd64'],
    ['darwin', 'arm64', 'opencodereview-darwin-arm64'],
    ['win32', 'x64', 'opencodereview-windows-amd64.exe'],
  ] as const)('%s/%s → %s', (platform, arch, expected) => {
    expect(assetName(platform, arch)).toBe(expected);
  });

  test.each([
    ['freebsd', 'x64'],
    ['linux', 'ia32'],
  ] as const)('%s/%s is unsupported', (platform, arch) => {
    expect(() => assetName(platform, arch)).toThrow('unsupported platform');
  });
});

describe('expectedSha256', () => {
  test('pins a hash for every asset of the pinned version', () => {
    for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']] as const) {
      expect(expectedSha256(OCR_VERSION, assetName(platform, arch))).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(OCR_SHA256)).toHaveLength(6);
  });

  test('another version needs an explicit hash', () => {
    expect(() => expectedSha256('v9.9.9', ASSET)).toThrow('set ocr_sha256');
    expect(expectedSha256('v9.9.9', ASSET, 'A'.repeat(64))).toBe('a'.repeat(64));
  });

  test('an explicit hash overrides the pinned one and must be 64 hex characters', () => {
    expect(expectedSha256(OCR_VERSION, ASSET, sha256(binary))).toBe(sha256(binary));
    expect(() => expectedSha256(OCR_VERSION, ASSET, 'abc')).toThrow('64 hex characters');
  });
});

describe('resolveOcr', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cura-install-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeFetch(files: Record<string, Uint8Array<ArrayBuffer> | string>) {
    return vi.fn(async (url: string | URL | Request) => {
      const file = files[String(url)];
      return file === undefined ? new Response('not found', { status: 404 }) : new Response(file);
    });
  }

  test('short-circuits when ocr is already on PATH', async () => {
    const fetch = fakeFetch({});
    const path = await resolveOcr({
      version: OCR_VERSION,
      platform: 'linux',
      arch: 'x64',
      binDir: '/unused',
      which: (cmd) => (cmd === 'ocr' ? '/usr/local/bin/ocr' : null),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(path).toBe('/usr/local/bin/ocr');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('downloads, verifies and installs an executable ocr', async () => {
    const binDir = join(tempDir(), 'bin');
    const fetch = fakeFetch({ [`${BASE}/${ASSET}`]: binary });
    const path = await resolveOcr({
      version: OCR_VERSION,
      sha256: sha256(binary),
      platform: 'linux',
      arch: 'x64',
      binDir,
      which: () => null,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(path).toBe(join(binDir, 'ocr'));
    expect(new Uint8Array(readFileSync(path))).toEqual(binary);
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  test('names the binary ocr.exe on windows', async () => {
    const binDir = tempDir();
    const asset = 'opencodereview-windows-amd64.exe';
    const fetch = fakeFetch({ [`${BASE}/${asset}`]: binary });
    const path = await resolveOcr({
      version: OCR_VERSION,
      sha256: sha256(binary),
      platform: 'win32',
      arch: 'x64',
      binDir,
      which: () => null,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(path).toBe(join(binDir, 'ocr.exe'));
  });

  test('throws when the binary does not match the pinned hash and writes nothing', async () => {
    const binDir = tempDir();
    const fetch = fakeFetch({ [`${BASE}/${ASSET}`]: binary });
    await expect(
      resolveOcr({
        version: OCR_VERSION,
        platform: 'linux',
        arch: 'x64',
        binDir,
        which: () => null,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow('ocr checksum mismatch');
    expect(() => statSync(join(binDir, 'ocr'))).toThrow();
  });

  test('throws when a download fails', async () => {
    const fetch = fakeFetch({});
    await expect(
      resolveOcr({
        version: OCR_VERSION,
        platform: 'linux',
        arch: 'x64',
        binDir: tempDir(),
        which: () => null,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow('404');
  });
});

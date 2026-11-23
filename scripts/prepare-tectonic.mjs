import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { download } from './download.mjs';

// Tectonic is the LaTeX engine bundled for people without TeX Live or MiKTeX. It is
// redistributed as an unmodified upstream release; the manifest pins the version and
// the SHA-256 of each archive, and is read by writing.rs as well.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'tectonic-assets.json'), 'utf8'));

export function tectonicTarget(platform, architecture, override) {
  const triple =
    override ||
    {
      'win32-x64': 'x86_64-pc-windows-msvc',
      'darwin-arm64': 'aarch64-apple-darwin',
      'darwin-x64': 'x86_64-apple-darwin',
      'linux-x64': 'x86_64-unknown-linux-gnu',
      'linux-arm64': 'aarch64-unknown-linux-gnu',
    }[`${platform}-${architecture}`];
  const asset = Object.hasOwn(manifest.assets, triple ?? '') ? manifest.assets[triple] : null;
  if (!asset)
    throw new Error(`Unsupported LaTeX engine target: ${triple || `${platform}-${architecture}`}`);
  return { triple, suffix: triple.endsWith('windows-msvc') ? '.exe' : '', asset };
}

/** The system's own tar: on Windows the bsdtar in System32, which also reads zip files. */
function systemTar() {
  if (process.platform !== 'win32') return 'tar';
  const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (!existsSync(tar)) throw new Error('System32\\tar.exe is required to unpack Tectonic');
  return tar;
}

function find(directory, name, depth = 2) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory() && depth > 0) {
      const found = find(path, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/** Downloads the pinned engine into src-tauri/binaries unless it is already there. */
function ensureEngine() {
  // Builds for another architecture set the same override as the Agent engine.
  const { triple, suffix, asset } = tectonicTarget(
    process.platform,
    process.arch,
    process.env.CAPSIO_CODEX_TRIPLE,
  );
  const target = join(root, 'src-tauri', 'binaries');
  const binary = join(target, `tectonic-${triple}${suffix}`);
  const stamp = join(target, `tectonic-${triple}.version`);
  const stamped = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
  if (existsSync(binary) && stamped === manifest.version) {
    console.log(
      `LaTeX engine ready: tectonic ${manifest.version} (${(statSync(binary).size / 1024 / 1024).toFixed(1)} MB)`,
    );
    return binary;
  }
  mkdirSync(target, { recursive: true });
  const archive = join(target, `${asset.file}.download`);
  const staging = join(target, `tectonic-${triple}.staging`);
  try {
    console.log(`Downloading tectonic ${manifest.version}...`);
    download(
      `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${manifest.version}/${asset.file}`,
      archive,
    );
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (digest !== asset.sha256)
      throw new Error(
        `tectonic archive checksum mismatch: expected ${asset.sha256}, got ${digest}`,
      );
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const extracted = spawnSync(systemTar(), ['-xf', archive, '-C', staging], { stdio: 'inherit' });
    if (extracted.status !== 0) throw new Error('Unable to unpack the Tectonic archive');
    const found = find(staging, `tectonic${suffix}`);
    if (!found) throw new Error('The Tectonic archive did not contain the engine');
    if (statSync(found).size < 1024 * 1024)
      throw new Error('The Tectonic engine is implausibly small');
    rmSync(binary, { force: true });
    renameSync(found, binary);
    if (!suffix) chmodSync(binary, 0o755);
  } finally {
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
  writeFileSync(stamp, `${manifest.version}\n`);
  console.log(
    `LaTeX engine ready: tectonic ${manifest.version} (${(statSync(binary).size / 1024 / 1024).toFixed(1)} MB)`,
  );
  return binary;
}

/** Identifies a seed by the engine version and the sample documents it was compiled from. */
export function seedKey(version, samples) {
  const hash = createHash('sha256').update(version);
  for (const [name, content] of samples) hash.update(`\0${name}\0`).update(content);
  return hash.digest('hex');
}

function size(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? size(path) : statSync(path).size;
  }
  return total;
}

/**
 * Compiles the sample documents once with an empty cache, so the packages, fonts and format
 * file most papers need ship in the installer (release-resources/tectonic-cache) and the first
 * compile on a new computer works offline. A failed warm-up never fails the build: the engine
 * then downloads what it needs on first use. CI checks skip it with CAPSIO_TEX_WARMUP=skip.
 */
function warmCache(binary) {
  const seed = join(root, 'src-tauri', 'release-resources', 'tectonic-cache');
  const seedFile = join(seed, 'seed.json');
  const warmup = join(root, 'scripts', 'tectonic-warmup');
  const samples = readdirSync(warmup)
    .sort()
    .map((name) => [name, readFileSync(join(warmup, name))]);
  const key = seedKey(manifest.version, samples);
  let current = null;
  try {
    current = JSON.parse(readFileSync(seedFile, 'utf8'));
  } catch {
    /* No seed yet. */
  }
  const ready = () =>
    console.log(`Bundled TeX packages ready (${(size(seed) / 1024 / 1024).toFixed(1)} MB)`);
  if (current?.complete && current.key === key) return ready();
  // The resource folder must exist for the app to build; an incomplete seed is ignored.
  const placeholder = (reason) => {
    rmSync(seed, { recursive: true, force: true });
    mkdirSync(seed, { recursive: true });
    writeFileSync(seedFile, JSON.stringify({ complete: false, reason }, null, 2) + '\n');
  };
  if (process.env.CAPSIO_TEX_WARMUP === 'skip') {
    if (!current) placeholder('skipped');
    return console.log('Bundled TeX packages skipped (CAPSIO_TEX_WARMUP=skip).');
  }
  const staging = `${seed}.staging`;
  const cache = join(staging, 'cache');
  const work = join(staging, 'work');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(join(work, 'out'), { recursive: true });
  for (const [name, content] of samples) writeFileSync(join(work, name), content);
  try {
    const results = [];
    for (const [name] of samples.filter(([file]) => file.endsWith('.tex'))) {
      console.log(`Preparing bundled TeX packages: ${name}...`);
      const run = spawnSync(binary, ['-X', 'compile', name, '--outdir', 'out', '--untrusted'], {
        cwd: work,
        env: { ...process.env, TECTONIC_CACHE_DIR: cache },
        stdio: 'inherit',
        timeout: 20 * 60 * 1000,
      });
      results.push({ name, ok: run.status === 0 });
      if (run.status !== 0)
        console.warn(`warning: ${name} did not compile; its packages are not bundled.`);
    }
    if (!results.find((result) => result.name === 'paper.tex')?.ok) {
      placeholder('paper.tex did not compile');
      return console.warn(
        'warning: TeX packages are not bundled; the engine downloads them on first use.',
      );
    }
    const record = { complete: true, key, version: manifest.version, samples: results };
    writeFileSync(join(cache, 'seed.json'), JSON.stringify(record, null, 2) + '\n');
    rmSync(seed, { recursive: true, force: true });
    renameSync(cache, seed);
    ready();
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  warmCache(ensureEngine());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

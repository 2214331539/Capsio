import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seedKey, tectonicTarget } from './prepare-tectonic.mjs';

test('bundles a pinned Tectonic for every desktop target', () => {
  assert.equal(tectonicTarget('win32', 'x64').suffix, '.exe');
  assert.equal(tectonicTarget('darwin', 'arm64').triple, 'aarch64-apple-darwin');
  assert.match(tectonicTarget('linux', 'x64').asset.file, /linux-musl\.tar\.gz$/);
  for (const { asset } of [
    tectonicTarget('win32', 'x64'),
    tectonicTarget('darwin', 'arm64'),
    tectonicTarget('darwin', 'x64'),
  ])
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => tectonicTarget('darwin', 'arm64', '../../wrong-target'));
  assert.throws(() => tectonicTarget('win32', 'x64', '__proto__'));
});

test('the bundled packages are rebuilt when the engine or a sample changes', () => {
  const samples = [['paper.tex', Buffer.from('\\documentclass{article}')]];
  const key = seedKey('0.17.0', samples);
  assert.equal(seedKey('0.17.0', samples), key);
  assert.notEqual(seedKey('0.18.0', samples), key);
  assert.notEqual(seedKey('0.17.0', [['paper.tex', Buffer.from('\\documentclass{book}')]]), key);
  assert.notEqual(seedKey('0.17.0', [['other.tex', samples[0][1]]]), key);
});

test('the bundled engine and the app agree on its version', () => {
  const manifest = JSON.parse(readFileSync(new URL('./tectonic-assets.json', import.meta.url)));
  const writing = readFileSync(new URL('../src-tauri/src/writing.rs', import.meta.url), 'utf8');
  assert.match(writing, /tectonic-assets\.json/);
  assert.ok(manifest.assets['x86_64-pc-windows-msvc'].file.includes(manifest.version));
});

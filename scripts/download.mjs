import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Node's fetch ignores the WinINET proxy that many Windows networks require, and
 * curl only reads proxy environment variables. PowerShell's Invoke-WebRequest is
 * the one downloader that honours the system proxy, so prefer it on Windows.
 * The URL travels through the environment to keep it out of the command string.
 */
export function download(url, destination) {
  const env = { ...process.env, SCIENTIFY_DL_URL: url, SCIENTIFY_DL_OUT: destination };
  const command =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $env:SCIENTIFY_DL_URL -OutFile $env:SCIENTIFY_DL_OUT -MaximumRedirection 5",
          ],
        ]
      : ['curl', ['-fsSL', '--retry', '3', '-o', destination, url]];
  const result = spawnSync(command[0], command[1], { stdio: 'inherit', env });
  if (result.error) throw new Error(`${command[0]} unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command[0]} exited with status ${result.status}`);
  if (!existsSync(destination)) throw new Error(`${command[0]} produced no file`);
}

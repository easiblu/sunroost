/**
 * Child-process helpers for OS integration. Everything is best effort: a missing binary, a
 * permission error or a timeout resolves to a failure result instead of throwing.
 */
import { execFile } from 'node:child_process';

export interface ExecResult {
  ok: boolean;
  stdout: string;
  /** stderr, or the error message when the command could not run. */
  message: string;
  /** True when the command failed for lack of privileges (sudo refused, EACCES, polkit). */
  denied: boolean;
}

export interface ExecOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

const DENIED = /is not allowed to execute|permission denied|not authorized|not permitted|a password is required|insufficient privileges|access denied|must be root|operation not permitted|authentication is required/i;

export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        cmd,
        args,
        { timeout: opts.timeout ?? 10_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: opts.env ?? process.env },
        (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true, stdout, message: (stderr ?? '').trim(), denied: false });
          const message = (stderr || err.message || '').trim();
          resolve({ ok: false, stdout: stdout ?? '', message, denied: DENIED.test(message) || (err as NodeJS.ErrnoException).code === 'EACCES' });
        },
      );
      if (opts.input !== undefined) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(opts.input);
      }
    } catch (err) {
      resolve({ ok: false, stdout: '', message: (err as Error).message, denied: false });
    }
  });
}

/** stdout on success, null on any failure. */
export async function run(cmd: string, args: string[], timeout = 4000, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await exec(cmd, args, { timeout, env });
  return r.ok ? r.stdout : null;
}

export const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

let sudoOk: boolean | null = null;
/** Whether passwordless sudo works for this user (cached after the first check). */
export async function canSudo(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  // `sudo -n -l` succeeds when this user has any sudoers rules (the installer grants a scoped set),
  // unlike `sudo -n true`, which needs unrestricted sudo.
  if (sudoOk === null) sudoOk = (await exec('sudo', ['-n', '-l'], { timeout: 3000 })).ok;
  return sudoOk;
}

/**
 * Runs a command that needs root: directly when we are root, otherwise through `sudo -n`
 * (never prompts). When `tryPlain` is set the command is first tried unprivileged, which suits
 * tools like nmcli that authorize through polkit.
 */
export async function execPriv(cmd: string, args: string[], opts: ExecOptions & { tryPlain?: boolean } = {}): Promise<ExecResult> {
  if (isRoot()) return exec(cmd, args, opts);
  if (opts.tryPlain) {
    const plain = await exec(cmd, args, opts);
    if (plain.ok || !plain.denied) return plain;
  }
  if (!(await canSudo())) {
    return { ok: false, stdout: '', message: `Permission denied: ${cmd} needs root (run the app as root or allow it in sudoers).`, denied: true };
  }
  return exec('sudo', ['-n', cmd, ...args], opts);
}

/** Whether privileged commands can run at all (root or passwordless sudo). */
export async function hasPrivileges(): Promise<boolean> {
  return isRoot() || (await canSudo());
}

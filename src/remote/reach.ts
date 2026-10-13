/**
 * Reachability test: fetch https://<domain>/api/auth/remote-ping from this device and check the
 * answer carries this process's instance id, proving the domain leads back here.
 */
import { randomBytes } from 'node:crypto';

/** Identifies this running instance. */
export const INSTANCE = randomBytes(12).toString('hex');

export interface ReachResult {
  ok: boolean;
  ms?: number;
  error?: string;
}

export async function testReachability(domain: string, hint: string): Promise<ReachResult> {
  if (!domain) return { ok: false, error: 'No domain configured' };
  const nonce = randomBytes(8).toString('hex');
  const started = Date.now();
  try {
    const res = await fetch(`https://${domain}/api/auth/remote-ping?nonce=${nonce}`, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    const ms = Date.now() - started;
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, ms, error: `The domain redirects (HTTP ${res.status}). If Cloudflare Access is enabled, that is expected; otherwise ${hint}.` };
    }
    if (!res.ok) return { ok: false, ms, error: `The domain answered HTTP ${res.status}. ${hint[0].toUpperCase()}${hint.slice(1)}.` };
    const body = (await res.json().catch(() => null)) as { instance?: string; nonce?: string } | null;
    if (body?.instance !== INSTANCE || body?.nonce !== nonce) {
      return { ok: false, ms, error: 'The domain answered, but not from this device.' };
    }
    return { ok: true, ms };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const code = e.cause?.code;
    const error =
      code === 'ENOTFOUND' ? `${domain} doesn't resolve yet (DNS can take a few minutes).`
      : e.name === 'TimeoutError' ? 'Timed out after 10 s.'
      : code === 'ECONNREFUSED' ? 'Connection refused. Check the router forwards port 443 to this device.'
      : e.cause ? `${e.message}: ${code ?? e.cause.message ?? String(e.cause)}`
      : e.message;
    return { ok: false, error };
  }
}

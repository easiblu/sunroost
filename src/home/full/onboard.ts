/**
 * Sets up a fresh Home Assistant without anyone opening its UI, using the same onboarding API its
 * own frontend uses: create the owner account, finish the remaining steps, then mint a long-lived
 * token for Sunroost. Only possible while Home Assistant has no owner yet; after that a user must
 * paste a token.
 */
import { randomBytes } from 'node:crypto';
import { HaClient, HaError } from './client.ts';

export interface OnboardResult {
  token: string;
  username: string;
  password: string;
}

const LANGUAGE = 'en';

async function post(base: string, path: string, body: unknown, token?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HaError(`Home Assistant onboarding failed at ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, String(res.status));
  return text ? JSON.parse(text) : {};
}

/** Onboarding steps and whether each is done; null when Home Assistant isn't reachable. */
export async function onboardingStatus(base: string): Promise<{ step: string; done: boolean }[] | null> {
  try {
    const res = await fetch(base + '/api/onboarding', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as { step: string; done: boolean }[];
  } catch {
    return null;
  }
}

export async function onboard(baseUrl: string, timeZone: string): Promise<OnboardResult> {
  const base = baseUrl.replace(/\/+$/, '');
  const clientId = `${base}/`;
  const steps = await onboardingStatus(base);
  if (!steps) throw new HaError(`Can't reach Home Assistant at ${base}`, 'unreachable');
  if (steps.find((s) => s.step === 'user')?.done) {
    throw new HaError('Home Assistant already has an owner. Create a long-lived access token in its profile page and enter it in Sunroost.', 'onboarded');
  }

  const username = 'sunroost';
  const password = randomBytes(24).toString('base64url');
  const { auth_code } = await post(base, '/api/onboarding/users', { client_id: clientId, name: 'Sunroost', username, password, language: LANGUAGE });

  const tokenRes = await fetch(base + '/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: auth_code, client_id: clientId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) throw new HaError(`Home Assistant refused the onboarding login (HTTP ${tokenRes.status})`, String(tokenRes.status));
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  // The remaining steps, in the frontend's order; each is skipped if already done.
  const done = new Set((await onboardingStatus(base))?.filter((s) => s.done).map((s) => s.step));
  if (!done.has('core_config')) await post(base, '/api/onboarding/core_config', {}, access_token);
  if (!done.has('analytics')) await post(base, '/api/onboarding/analytics', {}, access_token);
  if (!done.has('integration')) await post(base, '/api/onboarding/integration', { client_id: clientId, redirect_uri: `${base}/?auth_callback=1` }, access_token);

  const client = new HaClient(base, access_token);
  await client.connect();
  try {
    // Time zone from Sunroost's settings, so time-based integrations agree with Sunroost.
    await client.command({ type: 'config/core/update', time_zone: timeZone }).catch(() => {});
    const token = await client.command<string>({ type: 'auth/long_lived_access_token', client_name: 'Sunroost', lifespan: 3650 });
    return { token, username, password };
  } finally {
    client.close();
  }
}

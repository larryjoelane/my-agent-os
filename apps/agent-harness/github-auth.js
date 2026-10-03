// "Sign in with GitHub". GitHub's token endpoint needs the
// app's client secret and sends no CORS headers, so the code -> token swap goes
// through the runner (runner/oauth.js), which holds the secret. Everything else
// (PKCE, state, storing the token) happens here.
//
// Use a GitHub App: its user tokens only reach repos the app is installed on,
// carry only the app's permissions, and expire after 8 hours. We don't keep
// refresh tokens; when the token expires, signing in again is one click.

import { randomString, challengeFor, callbackUrl, store } from './pkce.js';

const SESSION = 'agentHarness.githubSession';
const STATE = 'agentHarness.githubState';
const VERIFIER = 'agentHarness.githubVerifier';

export const isConfigured = (cfg) => !!(cfg.githubClientId && cfg.githubOAuthProxy);

// { token, login, expiresAt } or null when signed out or expired.
export function getSession() {
  let s = null;
  try { s = JSON.parse(store(localStorage, SESSION) || 'null'); } catch {}
  if (s && s.expiresAt && Date.now() > s.expiresAt - 60_000) {
    logout();
    return null;
  }
  return s;
}

export const logout = () => store(localStorage, SESSION, null);

export async function login(cfg) {
  const state = randomString();
  const verifier = randomString();
  store(sessionStorage, STATE, state);
  store(sessionStorage, VERIFIER, verifier);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', cfg.githubClientId);
  url.searchParams.set('redirect_uri', callbackUrl());
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (cfg.githubScope) url.searchParams.set('scope', cfg.githubScope);
  location.assign(url);
}

// True when this page load is GitHub redirecting back to us (it echoes our
// state; OpenRouter's redirect carries only ?code).
export function isCallback() {
  const state = new URLSearchParams(location.search).get('state');
  return !!state && state === store(sessionStorage, STATE);
}

export async function completeLogin(cfg) {
  const params = new URLSearchParams(location.search);
  const verifier = store(sessionStorage, VERIFIER);
  store(sessionStorage, STATE, null);
  store(sessionStorage, VERIFIER, null);
  history.replaceState(null, '', callbackUrl());
  if (params.get('error')) throw new Error(`GitHub sign-in failed: ${params.get('error_description') || params.get('error')}`);
  if (!isConfigured(cfg)) throw new Error('GitHub sign-in is not configured for this site.');

  const res = await fetch(`${cfg.githubOAuthProxy.replace(/\/+$/, '')}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: params.get('code'), code_verifier: verifier, redirect_uri: callbackUrl() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`GitHub sign-in failed: ${data.error_description || data.error || res.status}`);
  }
  const user = await githubGet(data.access_token, '/user');
  store(localStorage, SESSION, JSON.stringify({
    token: data.access_token,
    login: user.login,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
  }));
}

async function githubGet(token, path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (res.status === 401) logout();
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
  return res.json();
}

// Repos this token can reach (for a GitHub App: where the app is installed),
// most recently pushed first.
export async function listRepos(token) {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await githubGet(token, `/user/repos?per_page=100&sort=pushed&page=${page}`);
    repos.push(...batch.map((r) => r.full_name));
    if (batch.length < 100) break;
  }
  return repos;
}

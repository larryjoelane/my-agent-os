// OpenRouter OAuth (PKCE) login and chat completions, straight from the browser.
// The login yields a user-owned API key; nothing secret ships with the page.
// https://openrouter.ai/docs/use-cases/oauth-pkce

import { randomString, challengeFor, callbackUrl, store } from './pkce.js';

const API = 'https://openrouter.ai/api/v1';
const KEY = 'agentHarness.openrouterKey';
const VERIFIER = 'agentHarness.pkceVerifier';

export const getKey = () => store(localStorage, KEY);
export const logout = () => store(localStorage, KEY, null);

export async function login() {
  const verifier = randomString();
  store(sessionStorage, VERIFIER, verifier);
  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('callback_url', callbackUrl());
  url.searchParams.set('code_challenge', await challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  location.assign(url);
}

// Finishes the redirect back from openrouter.ai/auth. Returns true if a key was obtained.
export async function completeLogin() {
  const code = new URLSearchParams(location.search).get('code');
  if (!code) return false;
  history.replaceState(null, '', callbackUrl());
  const verifier = store(sessionStorage, VERIFIER);
  store(sessionStorage, VERIFIER, null);
  if (!verifier) throw new Error('Login session expired. Try logging in again.');
  const res = await fetch(`${API}/auth/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!res.ok) throw new Error(`OpenRouter login failed (${res.status}).`);
  const { key } = await res.json();
  store(localStorage, KEY, key);
  return true;
}

// Free means every listed price is exactly 0. Routers such as openrouter/auto
// report -1 (price depends on the model they pick), so they don't count.
export const isFree = (m) => {
  const prices = Object.values(m.pricing ?? {}).map(Number);
  return prices.length > 0 && prices.every((p) => p === 0);
};

// Models that accept tool definitions, newest first.
export async function listModels() {
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(`Could not load models (${res.status}).`);
  const { data } = await res.json();
  return data
    .filter((m) => m.supported_parameters?.includes('tools'))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
}

export async function chat({ model, messages, tools, signal }) {
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${getKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) logout();
  if (!res.ok || body.error) {
    throw new Error(`OpenRouter ${res.status}: ${body.error?.message || res.statusText}`);
  }
  return body;
}

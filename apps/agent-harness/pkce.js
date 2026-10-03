// PKCE (RFC 7636) helpers shared by the OpenRouter and GitHub logins.

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export const callbackUrl = () => location.origin + location.pathname;

export function store(area, name, value) {
  try {
    if (value === undefined) return area.getItem(name);
    if (value === null) area.removeItem(name);
    else area.setItem(name, value);
  } catch { return null; }
}

// SPDX-License-Identifier: GPL-3.0-or-later
/** The only HTTP calls: email PIN login, which binds the email to this device's public key. */

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  // relative: the API lives below the app's path (<base href>)
  const res = await fetch(`api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : res.statusText
    throw new ApiError(res.status, detail)
  }
  return data as T
}

export function requestLogin(email: string, language: string): Promise<{ message: string }> {
  return post('/auth/request-login', { email, language })
}

export function verifyLogin(email: string, code: string, publicKey: string): Promise<{ email: string; time: number }> {
  return post('/auth/verify', { email, code, public_key: publicKey })
}

/** Refuse an implicit database target in browser builds. */
export function requiredClientEnv(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required. Configure this deployment before opening a book.`);
  }
  return value.trim();
}

export function isLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function assertSafeDevelopmentTarget(name: string, local: boolean): void {
  if (import.meta.env.DEV && !local && import.meta.env.VITE_ALLOW_REMOTE_IN_DEV !== 'yes') {
    throw new Error(`${name} points to a remote project in development. Use a local emulator or set VITE_ALLOW_REMOTE_IN_DEV=yes deliberately.`);
  }
}

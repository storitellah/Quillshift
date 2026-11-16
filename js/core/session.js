// In-memory state shared between views for the life of the page.

export const session = {
  /** A file opened in the reader without being saved to the library. */
  temp: null,
  /** The deferred Android/desktop install prompt, when the browser offers one. */
  installPrompt: null,
  installListeners: new Set(),
};

export function onInstallChange(fn) {
  session.installListeners.add(fn);
  return () => session.installListeners.delete(fn);
}

export async function promptInstall() {
  const p = session.installPrompt;
  if (!p) return false;
  p.prompt();
  const { outcome } = await p.userChoice;
  session.installPrompt = null;
  for (const fn of session.installListeners) fn();
  return outcome === 'accepted';
}

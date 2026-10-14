let pending: Promise<{ reset: boolean }> | null = null;

export function ensureSession() {
  if (!pending) {
    pending = fetch('/api/session', { method: 'POST' }).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 503
        ? 'Simulation capacity reached. Please retry shortly.' : 'Cannot reach the simulation server.');
      return response.json() as Promise<{ reset: boolean }>;
    }).finally(() => { pending = null; });
  }
  return pending;
}

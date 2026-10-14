import { useEffect, useState, type ReactNode } from 'react';

import { ensureSession } from './session.ts';

export function SessionGate({ children }: { children: ReactNode }) {
  const [wasReset, setWasReset] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('Connecting to your simulation…');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void ensureSession().then((session) => {
      if (!active) return;
      if (session.reset) setWasReset(true);
      setReady(true);
    }).catch((error: Error) => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, [attempt]);
  if (ready) return <>{wasReset && <div className="session-notice" role="status">Your temporary simulation was reset after expiration or a server restart. <button onClick={() => setWasReset(false)}>Dismiss</button></div>}{children}</>;
  return <main role="status" style={{ padding: 32 }}><p>{message}</p>
    <button onClick={() => setAttempt((value) => value + 1)}>Retry connection</button></main>;
}

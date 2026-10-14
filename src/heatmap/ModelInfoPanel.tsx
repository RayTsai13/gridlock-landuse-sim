import { useEffect, useState } from 'react';
import type { ModelInfo } from './grid.ts';

export function ModelInfoPanel({ model, error }: { model?: ModelInfo; error: string | null }) {
  const [reset, setReset] = useState(false);
  useEffect(() => {
    const notify = () => setReset(true);
    window.addEventListener('simulation-reset', notify);
    return () => window.removeEventListener('simulation-reset', notify);
  }, []);
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const historical = model?.sourceFeedEndDate && model.sourceFeedEndDate < today;
  return <aside className="model-info">
    {reset && <p role="status">Your temporary simulation expired or the server restarted. It has been reset.
      <button onClick={() => setReset(false)}>Dismiss</button></p>}
    {error && <p role="alert">{error}</p>}
    <details><summary>About this simulation</summary>
      <p>Modeled demand, not observed pedestrian counts or a validated forecast.</p>
      {model?.synthetic ? <p>Synthetic development data.</p> : <>
        <p>{historical ? 'Historical schedule' : 'Schedule snapshot'}: {model?.sourceFeedVersion ?? 'Loading…'}.
          Feed ends {model?.sourceFeedEndDate ?? 'unknown'}.</p>
        <p>{model?.effectiveTripsPerDeparture ?? 200} effective trips per train-stop departure;
          {' '}{model?.walkRadiusMeters ?? 900}-meter walkshed. Ballard service is synthetic.</p>
      </>}
      <p>Authored district populations and hourly trip rates. No routing, transfers, onboard loads, or observed-demand calibration.</p>
      <p>Cell totals are trips/hour; the pressure index is a visual scale. This browser’s session is temporary and shared across its tabs.</p>
    </details>
  </aside>;
}

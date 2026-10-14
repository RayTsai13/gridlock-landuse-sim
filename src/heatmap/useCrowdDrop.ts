import { useEffect, useState, type RefObject } from 'react';
import type { MapRef } from 'react-map-gl/maplibre';
import type { PeopleDrop, PlacedPerson } from './api.ts';

const CROWD_SCATTER_RADIUS_DEG = 150 / 111_320;

export function useCrowdDrop(mapRef: RefObject<MapRef | null>, addPeopleBatch: (people: PeopleDrop[]) => Promise<PlacedPerson[]>, onError: (message: string) => void) {
  // Crowd drop controls
  const [crowdSize, setCrowdSize] = useState<number>(5000);
  const [isDraggingCrowd, setIsDraggingCrowd] = useState(false);
  const [crowdDragPos, setCrowdDragPos] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // ── Crowd Drop Pointer Events ──
  useEffect(() => {
    if (!isDraggingCrowd) return;

    const handlePointerMove = (e: PointerEvent) => {
      setCrowdDragPos({ x: e.clientX, y: e.clientY });
    };

    const handlePointerUp = (e: PointerEvent) => {
      setIsDraggingCrowd(false);
      setCrowdDragPos(null);

      if (mapRef.current) {
        const bounds = mapRef.current.getContainer().getBoundingClientRect();
        const dropPoint = [e.clientX - bounds.left, e.clientY - bounds.top] as [number, number];
        const lngLat = mapRef.current.unproject(dropPoint);

        // Scatter the crowd into 12 clusters inside a ~150 m circle.
        const drops = 12;
        const basePerDrop = Math.floor(crowdSize / drops);
        // Integer division loses up to `drops - 1` people; hand the remainder
        // out so the count actually placed matches the number on the button.
        let remainder = crowdSize - basePerDrop * drops;
        const people: PeopleDrop[] = [];

        for (let i = 0; i < drops; i++) {
          // sqrt makes the sample uniform over the disc rather than clustered
          // at the center, and the longitude offset is divided by cos(lat) so
          // the footprint is a circle rather than a 1.5:1 ellipse at 47.6 N.
          const radius = CROWD_SCATTER_RADIUS_DEG * Math.sqrt(Math.random());
          const theta = Math.random() * 2 * Math.PI;
          const lat = lngLat.lat + radius * Math.sin(theta);
          const lon =
            lngLat.lng +
            (radius * Math.cos(theta)) /
              Math.max(0.01, Math.cos((lngLat.lat * Math.PI) / 180));

          const count = basePerDrop + (remainder > 0 ? 1 : 0);
          if (remainder > 0) remainder -= 1;
          if (count <= 0) continue;

          people.push({ lat, lon, count,
            kind: "crowd",
            duration_minutes: 240,
          });
        }
        addPeopleBatch(people).catch((err: unknown) => {
          onError(err instanceof Error ? err.message : "Crowd placement failed");
        });
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isDraggingCrowd, crowdSize, addPeopleBatch, mapRef, onError]);


  return { crowdSize, setCrowdSize, isDraggingCrowd, setIsDraggingCrowd, crowdDragPos, setCrowdDragPos };
}

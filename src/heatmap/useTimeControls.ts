import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaybackState } from './api.ts';

export function useTimeControls(playback: PlaybackState | null, seekTo: (day: number, minute: number) => Promise<void>) {
  // Time controls
  const [timeOfDay, setTimeOfDay] = useState(0);
  const [dayOfWeek, setDayOfWeek] = useState(0);
  const [hoveredDay, setHoveredDay] = useState<number | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialRef = useRef<HTMLDivElement>(null);
  const selectedTimeRef = useRef(timeOfDay);
  const selectedDayRef = useRef(dayOfWeek);
  const [isDraggingDial, setIsDraggingDial] = useState(false);
  useEffect(() => {
    if (!playback?.sim_time || isDraggingDial) return;
    queueMicrotask(() => {
      setDayOfWeek(playback.sim_time.day_of_week);
      setTimeOfDay(playback.sim_time.time_bin);
    });
  }, [playback?.sim_time, isDraggingDial]);

  useEffect(() => {
    selectedTimeRef.current = timeOfDay;
  }, [timeOfDay]);

  useEffect(() => {
    selectedDayRef.current = dayOfWeek;
  }, [dayOfWeek]);

  // ── Time controls ──
  const updateTimeFromPointer = useCallback((clientX: number, clientY: number) => {
    if (!dialRef.current) return selectedTimeRef.current;
    const rect = dialRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const angle = Math.atan2(clientY - cy, clientX - cx);
    let shiftedAngle = angle + Math.PI / 2;
    if (shiftedAngle < 0) shiftedAngle += 2 * Math.PI;
    let newTime = Math.round((shiftedAngle / (2 * Math.PI)) * 1440);
    newTime = Math.round(newTime / 30) * 30;
    if (newTime >= 1440) newTime = 0;
    selectedTimeRef.current = newTime;
    setTimeOfDay(newTime);
    return newTime;
  }, []);

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (!isDraggingDial) return;
      updateTimeFromPointer(e.clientX, e.clientY);
    };

    const handlePointerUp = () => {
      setIsDraggingDial(false);
      seekTo(selectedDayRef.current, selectedTimeRef.current).catch((err) => {
        console.warn("[heatmap] failed to seek playback", err);
      });
    };

    if (isDraggingDial) {
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    }
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isDraggingDial, seekTo, updateTimeFromPointer]);


  useEffect(() => () => {
    if (hoverTimeoutRef.current !== null) clearTimeout(hoverTimeoutRef.current);
  }, []);
  return { timeOfDay, dayOfWeek, setDayOfWeek, hoveredDay, setHoveredDay, hoverTimeoutRef, dialRef, selectedTimeRef, selectedDayRef, isDraggingDial, setIsDraggingDial, updateTimeFromPointer };
}

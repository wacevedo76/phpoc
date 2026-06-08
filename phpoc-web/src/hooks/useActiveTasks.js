import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * useActiveTasks — live timer hook for active tasks.
 *
 * Returns:
 *   activeTasks: StagingEntry[] — filtered active entries
 *   elapsedMap: { [entryId]: number } — live elapsed ms per task
 *   refresh: () => Promise<void> — force re-read from storage
 *
 * For paused tasks, elapsedMs is frozen at pause-time duration.
 * For running tasks, elapsedMs ticks up every second.
 */
export function useActiveTasks(syncService) {
  const [activeTasks, setActiveTasks] = useState([]);
  const [elapsedMap, setElapsedMap] = useState({});
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!syncService) return;
    try {
      const tasks = await syncService.getActive();
      if (!mountedRef.current) return;
      setActiveTasks(tasks);

      // Compute elapsed for each task
      const now = Date.now();
      const map = {};
      for (const task of tasks) {
        if (!task.is_active) continue;

        if (task.is_paused) {
          // For paused tasks, elapsed is frozen at pause-start
          const pauses = task.pauses || [];
          const lastPause = pauses[pauses.length - 1];
          if (lastPause && lastPause.pause_stop == null) {
            // Elapsed = pause_start - start_epoch minus previous pauses
            let totalPauseMs = 0;
            for (let i = 0; i < pauses.length - 1; i++) {
              const p = pauses[i];
              if (p.pause_stop != null) {
                totalPauseMs += p.pause_stop - p.pause_start;
              }
            }
            map[task.entry_id] = Math.max(0,
              (lastPause.pause_start - task.start_epoch) - totalPauseMs
            );
          } else {
            map[task.entry_id] = 0;
          }
        } else {
          // Running task: elapsed = now - start_epoch minus all completed pauses
          let totalPauseMs = 0;
          for (const p of (task.pauses || [])) {
            if (p.pause_stop != null) {
              totalPauseMs += p.pause_stop - p.pause_start;
            }
          }
          map[task.entry_id] = Math.max(0, (now - task.start_epoch) - totalPauseMs);
        }
      }
      if (mountedRef.current) setElapsedMap(map);
    } catch (err) {
      console.warn('useActiveTasks: failed to read tasks', err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [syncService]);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    if (syncService) refresh();
    return () => { mountedRef.current = false; };
  }, [syncService, refresh]);

  // Tick every second for running tasks
  useEffect(() => {
    const tick = () => {
      setElapsedMap((prev) => {
        const now = Date.now();
        const next = { ...prev };
        for (const task of activeTasks) {
          if (!task.is_paused && task.is_active) {
            let totalPauseMs = 0;
            for (const p of (task.pauses || [])) {
              if (p.pause_stop != null) {
                totalPauseMs += p.pause_stop - p.pause_start;
              }
            }
            next[task.entry_id] = Math.max(0, (now - task.start_epoch) - totalPauseMs);
          }
        }
        return next;
      });
    };

    timerRef.current = setInterval(tick, 1000);
    return () => clearInterval(timerRef.current);
  }, [activeTasks]);

  return { activeTasks, elapsedMap, loading, refresh };
}

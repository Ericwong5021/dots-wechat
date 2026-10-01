export const SESSION_MS = 30 * 60 * 1000;

export function createHardLease({ wallNow = Date.now, monoNow = () => Number(process.hrtime.bigint() / 1000000n), setTimer = setTimeout, clearTimer = clearTimeout, onExpire = () => {} } = {}) {
  let state = 'PREPARED', startWall = null, startMono = null, deadlineWall = null, deadlineMono = null, highWall = null, highMono = null, timer;
  const snapshot = () => Object.freeze({ state, startWallMs: startWall, deadlineWallMs: deadlineWall, deadlineMonoMs: deadlineMono, durationMs: SESSION_MS });
  const stop = () => {
    if (state === 'STOPPED') return false;
    state = 'STOPPED';
    if (timer !== undefined) clearTimer(timer);
    return true;
  };
  const expire = reason => {
    if (!stop()) return;
    onExpire(reason);
  };
  const check = () => {
    if (state !== 'ACTIVE') return false;
    const wall = wallNow(), mono = monoNow();
    if (!Number.isFinite(wall) || !Number.isFinite(mono) || mono < highMono) {
      expire('CLOCK_INVALID');
      return false;
    }
    highWall = Math.max(highWall, wall);
    highMono = mono;
    if (highWall >= deadlineWall || mono >= deadlineMono) {
      expire('LEASE_EXPIRED');
      return false;
    }
    return true;
  };
  return Object.freeze({
    snapshot, check, stop,
    activate(bounds = {}) {
      if (state !== 'PREPARED') throw new Error('LEASE_ACTIVATION_ONCE');
      const wall = wallNow(), mono = monoNow();
      if (!Number.isFinite(wall) || !Number.isFinite(mono)) throw new Error('CLOCK_INVALID');
      deadlineWall = Math.min(wall + SESSION_MS, bounds.deadlineWallMs ?? Infinity);
      deadlineMono = Math.min(mono + SESSION_MS, bounds.deadlineMonoMs ?? Infinity);
      if (!Number.isFinite(deadlineWall) || !Number.isFinite(deadlineMono) || deadlineWall <= wall || deadlineMono <= mono) throw new Error('LEASE_DEADLINE_INVALID');
      state = 'ACTIVE';
      startWall = highWall = wall;
      startMono = highMono = mono;
      timer = setTimer(() => expire('LEASE_EXPIRED'), Math.min(deadlineWall - wall, deadlineMono - mono));
      return snapshot();
    },
  });
}

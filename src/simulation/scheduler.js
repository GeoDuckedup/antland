export function createIntervalScheduler() {
  const nextDueByKey = new Map();

  function due(key, now, interval, { immediate = true } = {}) {
    if (!(interval > 0)) throw new Error('Scheduled intervals must be positive.');
    let nextDue = nextDueByKey.get(key);
    if (nextDue == null) {
      nextDue = immediate ? now : now + interval;
      nextDueByKey.set(key, nextDue);
    }
    if (now + Number.EPSILON < nextDue) return false;
    const intervalsElapsed = Math.max(1, Math.floor((now - nextDue) / interval) + 1);
    nextDueByKey.set(key, nextDue + intervalsElapsed * interval);
    return true;
  }

  function reset(key = null) {
    if (key == null) nextDueByKey.clear();
    else nextDueByKey.delete(key);
  }

  return { due, reset };
}

export function drainFixedStepBacklog({
  accumulator,
  fixedDt,
  maxSteps,
  maxDeferredSteps = 0,
  step,
}) {
  if (!(fixedDt > 0)) throw new Error('Fixed-step duration must be positive.');
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error('Fixed-step frame budget must be a positive integer.');
  }
  if (!Number.isInteger(maxDeferredSteps) || maxDeferredSteps < 0) {
    throw new Error('Deferred-step allowance must be a non-negative integer.');
  }
  if (typeof step !== 'function') throw new Error('Fixed-step drain requires a step callback.');

  let remaining = Math.max(0, Number(accumulator) || 0);
  let completedSteps = 0;
  while (remaining >= fixedDt && completedSteps < maxSteps) {
    step();
    remaining -= fixedDt;
    completedSteps += 1;
  }

  const queuedSteps = Math.max(0, Math.floor((remaining + Number.EPSILON) / fixedDt));
  const deferredSteps = Math.min(queuedSteps, maxDeferredSteps);
  const droppedSteps = Math.max(0, queuedSteps - deferredSteps);
  const droppedSeconds = droppedSteps * fixedDt;
  remaining = Math.max(0, remaining - droppedSeconds);

  return {
    accumulator: remaining,
    completedSteps,
    deferredSteps,
    droppedSteps,
    droppedSeconds,
  };
}

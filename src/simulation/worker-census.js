export function createWorkerCensus() {
  const livingByColony = new Map();
  const countedWorkers = new WeakSet();
  let totalLiving = 0;

  function registerWorker(worker, colony) {
    if (!worker || !colony?.id || worker.alive === false || countedWorkers.has(worker)) return false;
    countedWorkers.add(worker);
    livingByColony.set(colony.id, (livingByColony.get(colony.id) || 0) + 1);
    totalLiving += 1;
    return true;
  }

  function registerColony(colony) {
    if (!colony?.id) return 0;
    livingByColony.set(colony.id, livingByColony.get(colony.id) || 0);
    let registered = 0;
    for (const worker of colony.workers || []) registered += Number(registerWorker(worker, colony));
    return registered;
  }

  function markDead(worker, colony) {
    if (!worker || !colony?.id || !countedWorkers.has(worker)) return false;
    countedWorkers.delete(worker);
    livingByColony.set(colony.id, Math.max(0, (livingByColony.get(colony.id) || 0) - 1));
    totalLiving = Math.max(0, totalLiving - 1);
    return true;
  }

  function colonyCount(colonyId) {
    return livingByColony.get(colonyId) || 0;
  }

  function hasColony(colonyId) {
    return livingByColony.has(colonyId);
  }

  function snapshot() {
    return {
      totalLiving,
      colonies: Object.fromEntries(livingByColony),
    };
  }

  return {
    registerWorker,
    registerColony,
    markDead,
    colonyCount,
    hasColony,
    snapshot,
    get totalLiving() { return totalLiving; },
  };
}

const DEFAULT_GENOME = Object.freeze({
  speed: 1,
  size: 1,
  diseaseResistance: 1,
  aggression: 1,
  foraging: 1,
});

export function workerRuntimeUid(colonyId, workerId) {
  return `${colonyId}:worker:${workerId}`;
}

export function ensureCanonicalWorkerRecord(worker, colony) {
  if (!worker || !colony?.id) throw new Error('Canonical workers require a worker and registered colony.');
  worker.colonyId = colony.id;
  worker.runtimeUid ||= workerRuntimeUid(colony.id, worker.id);
  worker.alive = worker.alive !== false;
  worker.ageDays ??= 0;
  worker.health ??= 100;
  worker.energy ??= 100;
  worker.x ??= colony.nest?.x || 0;
  worker.z ??= colony.nest?.y ?? colony.nest?.z ?? 0;
  worker.heading ??= 0;
  worker.desired ??= worker.heading;
  worker.phase ??= 0;
  worker.speed ??= 1;
  worker.size ??= 1;
  worker.genome ||= { ...DEFAULT_GENOME };
  worker.generation ??= 0;
  worker.workerCaste ||= 'minor';
  worker.assignedRole ||= worker.role || worker.tendency || 'forager';
  worker.insideNest = Boolean(worker.insideNest);
  worker.runtimeLocation = worker.insideNest ? 'underground' : 'surface';
  worker.surfacePosition ||= { x: worker.x, z: worker.z };
  worker.surfacePosition.x = worker.x;
  worker.surfacePosition.z = worker.z;
  worker.carrying = Boolean(worker.carrying);
  worker.carryingNutrition ??= 1;
  worker.tasksCompleted ??= 0;
  worker.trips ??= 0;
  worker.distanceTraveled ??= 0;
  syncCanonicalCargo(worker);
  return worker;
}

export function syncCanonicalCargo(worker) {
  worker.cargo ||= {};
  worker.cargo.food = Boolean(worker.carrying);
  worker.cargo.kind = worker.carryingKind || null;
  worker.cargo.nutrition = worker.carryingNutrition ?? 1;
  worker.cargo.seedSpecies = worker.carryingSeedSpecies || null;
  worker.cargo.sourcePlantId = worker.carryingSourcePlantId || null;
  worker.cargo.soil = Boolean(worker.soilCargo);
  worker.cargo.sanitation = Boolean(worker.sanitationCargo);
  worker.cargo.transfer = worker.transferCargo || null;
  return worker.cargo;
}

export function loadWorkerFoodCargo(worker, food) {
  worker.carrying = true;
  worker.carryingKind = food?.kind || null;
  worker.carryingNutrition = food?.nutrition ?? 1;
  worker.carryingSeedSpecies = food?.seedSpecies || null;
  worker.carryingSourcePlantId = food?.sourcePlantId || null;
  syncCanonicalCargo(worker);
  return worker.cargo;
}

export function clearWorkerFoodCargo(worker) {
  worker.carrying = false;
  worker.carryingKind = null;
  worker.carryingNutrition = 1;
  worker.carryingSeedSpecies = null;
  worker.carryingSourcePlantId = null;
  syncCanonicalCargo(worker);
  return worker.cargo;
}

export function createWorkerLookup({ displayIdFor = (worker) => String(worker?.id ?? '') } = {}) {
  const byRuntimeUid = new Map();
  const byDisplayId = new Map();

  function index(worker, colony) {
    if (!worker || !colony) return null;
    ensureCanonicalWorkerRecord(worker, colony);
    byRuntimeUid.set(worker.runtimeUid, worker);
    byDisplayId.set(String(displayIdFor(worker, colony)).toUpperCase(), worker);
    return worker;
  }

  function remove(worker, colony) {
    if (!worker) return false;
    const runtimeUid = worker.runtimeUid || workerRuntimeUid(worker.colonyId, worker.id);
    const displayId = String(displayIdFor(worker, colony)).toUpperCase();
    const removedRuntime = byRuntimeUid.delete(runtimeUid);
    const removedDisplay = byDisplayId.delete(displayId);
    return removedRuntime || removedDisplay;
  }

  function clear() {
    byRuntimeUid.clear();
    byDisplayId.clear();
  }

  function resolve(identity) {
    const raw = String(identity ?? '').trim();
    return byRuntimeUid.get(raw) || byDisplayId.get(raw.toUpperCase()) || null;
  }

  function resolveRuntimeUid(runtimeUid) {
    return byRuntimeUid.get(String(runtimeUid ?? '').trim()) || null;
  }

  return {
    index,
    remove,
    clear,
    resolve,
    resolveRuntimeUid,
    get size() { return byRuntimeUid.size; },
  };
}

export function createWorkerRuntime({ policies = {} } = {}) {
  function policyFor(colony) {
    const key = colony?.workerRuntimePolicy;
    const policy = policies[key];
    if (!policy) throw new Error(`Missing worker runtime policy: ${key || '(unset)'}`);
    return policy;
  }

  function updateWorker(world, colony, worker, dt) {
    const policy = policyFor(colony);
    const needsIndex = !worker?.runtimeUid;
    ensureCanonicalWorkerRecord(worker, colony);
    if (!worker.alive) return worker;
    const phaseDelta = policy.phaseDelta
      ? policy.phaseDelta(worker, dt, colony, world)
      : dt * (typeof policy.phaseRate === 'function'
        ? policy.phaseRate(worker, colony, world) : policy.phaseRate ?? 0);
    worker.phase += phaseDelta;
    worker.ageDays += dt * (world.simDaysPerSecond || 0);
    policy.update(world, colony, worker, dt);
    worker.runtimeLocation = worker.insideNest ? 'underground' : 'surface';
    worker.surfacePosition.x = worker.x;
    worker.surfacePosition.z = worker.z;
    syncCanonicalCargo(worker);
    if (needsIndex) world.indexWorker?.(worker, colony);
    if (policy.trackForeignEncounters && !worker.insideNest && worker.alive) {
      const foreign = world.nearestForeignWorker?.(worker, policy.encounterRadius ?? 1.15) || null;
      worker.foreignEncounter = foreign ? {
        workerUid: foreign.runtimeUid || workerRuntimeUid(foreign.colonyId, foreign.id),
        colonyId: foreign.colonyId,
      } : null;
    } else if (policy.trackForeignEncounters) worker.foreignEncounter = null;
    return worker;
  }

  function markWorkerDead(world, colony, worker, cause) {
    ensureCanonicalWorkerRecord(worker, colony);
    if (!worker.alive) return false;
    worker.alive = false;
    worker.deathCause = cause;
    policyFor(colony).onDeath?.(world, colony, worker, cause);
    world.removeWorkerIndex?.(worker, colony);
    return true;
  }

  function removeDeadWorkers(colony) {
    let removed = 0;
    for (let index = colony.workers.length - 1; index >= 0; index--) {
      if (colony.workers[index].alive !== false) continue;
      colony.workers.splice(index, 1);
      removed += 1;
    }
    return removed;
  }

  return { updateWorker, markWorkerDead, removeDeadWorkers, policyFor };
}

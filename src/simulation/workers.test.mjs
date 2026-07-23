import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearWorkerFoodCargo,
  createWorkerLookup,
  createWorkerRuntime,
  ensureCanonicalWorkerRecord,
  loadWorkerFoodCargo,
} from './workers.js';

test('canonical worker records normalize shared identity, location, and cargo', () => {
  const colony = { id: 'amber', nest: { x: -5, y: -1 } };
  const worker = ensureCanonicalWorkerRecord({ id: 7, carrying: false }, colony);
  assert.equal(worker.runtimeUid, 'amber:worker:7');
  assert.deepEqual(worker.surfacePosition, { x: -5, z: -1 });
  assert.equal(worker.runtimeLocation, 'surface');
  loadWorkerFoodCargo(worker, { kind: 'seed', nutrition: 1.3, seedSpecies: 'needlegrass', sourcePlantId: 4 });
  assert.deepEqual(worker.cargo, {
    food: true,
    kind: 'seed',
    nutrition: 1.3,
    seedSpecies: 'needlegrass',
    sourcePlantId: 4,
    soil: false,
    sanitation: false,
    transfer: null,
  });
  clearWorkerFoodCargo(worker);
  assert.equal(worker.cargo.food, false);
  assert.equal(worker.cargo.kind, null);
});

test('one worker lookup preserves identity across surface and underground selection', () => {
  const colony = {
    id: 'incipient-foundress-001',
    workerPrefix: 'F001-',
    nest: { x: 4, y: 5.4 },
  };
  const lookup = createWorkerLookup({
    displayIdFor: (worker, owner) => `${owner.workerPrefix}${String(worker.id).padStart(3, '0')}`,
  });
  const worker = lookup.index({ id: 4, insideNest: false }, colony);
  assert.equal(lookup.resolve('F001-004'), worker);
  assert.equal(lookup.resolveRuntimeUid('incipient-foundress-001:worker:4'), worker);

  worker.insideNest = true;
  ensureCanonicalWorkerRecord(worker, colony);
  assert.equal(worker.runtimeLocation, 'underground');
  assert.equal(lookup.resolve('F001-004'), worker);
  assert.equal(lookup.resolveRuntimeUid(worker.runtimeUid), worker);
});

test('every colony policy runs through one update and mortality entry point', () => {
  const calls = [];
  const policies = Object.fromEntries(['amber', 'slate', 'descendant'].map((key, index) => [key, {
    phaseRate: index + 1,
    update: (_world, colony, worker) => calls.push(`update:${colony.id}:${worker.id}`),
    onDeath: (_world, colony, worker, cause) => calls.push(`death:${colony.id}:${worker.id}:${cause}`),
  }]));
  const runtime = createWorkerRuntime({ policies });
  const world = { simDaysPerSecond: 2 };
  const colonies = Object.keys(policies).map((id) => ({ id, workerRuntimePolicy: id, nest: { x: 0, y: 0 }, workers: [] }));
  colonies.forEach((colony, index) => {
    const worker = { id: index + 1 };
    colony.workers.push(worker);
    runtime.updateWorker(world, colony, worker, 0.5);
    assert.equal(worker.ageDays, 1);
    assert.equal(worker.phase, (index + 1) * 0.5);
    runtime.markWorkerDead(world, colony, worker, 'test');
    assert.equal(runtime.removeDeadWorkers(colony), 1);
  });
  assert.deepEqual(calls, [
    'update:amber:1', 'death:amber:1:test',
    'update:slate:2', 'death:slate:2:test',
    'update:descendant:3', 'death:descendant:3:test',
  ]);
});

test('presentation palette does not select worker behavior', () => {
  const calls = [];
  const runtime = createWorkerRuntime({
    policies: {
      amber: { phaseRate: 0, update: () => calls.push('amber') },
      slate: { phaseRate: 0, update: () => calls.push('slate') },
    },
  });
  const world = { simDaysPerSecond: 0 };
  const colony = {
    id: 'parameterized-colony',
    workerRuntimePolicy: 'amber',
    workerPresentation: { palette: 'slate' },
    nest: { x: 0, y: 0 },
  };
  runtime.updateWorker(world, colony, { id: 1 }, 1);
  colony.workerPresentation.palette = 'amber-descendant';
  runtime.updateWorker(world, colony, { id: 2 }, 1);
  assert.deepEqual(calls, ['amber', 'amber']);
});

test('every opted-in colony uses the same foreign-worker spatial query contract', () => {
  const policy = { phaseRate: 0, encounterRadius: 2, trackForeignEncounters: true, update: () => {} };
  const runtime = createWorkerRuntime({
    policies: { amber: policy, slate: policy, descendant: policy },
  });
  const colonies = ['amber', 'slate', 'descendant'].map((id, index) => ({
    id,
    workerRuntimePolicy: id,
    nest: { x: index, y: 0 },
  }));
  const workers = colonies.map((colony, index) => ensureCanonicalWorkerRecord({ id: index + 1 }, colony));
  const queryCalls = [];
  const world = {
    simDaysPerSecond: 0,
    nearestForeignWorker(worker, radius) {
      queryCalls.push([worker.colonyId, radius]);
      return workers.find((other) => other.colonyId !== worker.colonyId);
    },
  };
  workers.forEach((worker, index) => runtime.updateWorker(world, colonies[index], worker, 1));
  assert.deepEqual(queryCalls, [['amber', 2], ['slate', 2], ['descendant', 2]]);
  workers.forEach((worker) => assert.notEqual(worker.foreignEncounter.colonyId, worker.colonyId));
});

test('stable worker identities are not re-indexed on every update', () => {
  let indexCalls = 0;
  const runtime = createWorkerRuntime({ policies: { amber: { phaseRate: 0, update: () => {} } } });
  const colony = { id: 'amber', workerRuntimePolicy: 'amber', nest: { x: 0, y: 0 } };
  const worker = { id: 1 };
  const world = { simDaysPerSecond: 0, indexWorker: () => { indexCalls += 1; } };
  runtime.updateWorker(world, colony, worker, 1);
  runtime.updateWorker(world, colony, worker, 1);
  assert.equal(indexCalls, 1);
});

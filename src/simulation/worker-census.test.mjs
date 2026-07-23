import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerCensus } from './worker-census.js';

test('worker census registers each living worker once across repeated indexing', () => {
  const census = createWorkerCensus();
  const colony = { id: 'amber', workers: [{ id: 1 }, { id: 2 }, { id: 3, alive: false }] };
  assert.equal(census.registerColony(colony), 2);
  assert.equal(census.registerColony(colony), 0);
  assert.equal(census.registerWorker(colony.workers[0], colony), false);
  assert.deepEqual(census.snapshot(), { totalLiving: 2, colonies: { amber: 2 } });
});

test('worker census maintains exact colony and regional totals through births and deaths', () => {
  const census = createWorkerCensus();
  const amber = { id: 'amber', workers: [{ id: 1 }] };
  const slate = { id: 'slate', workers: [{ id: 1 }, { id: 2 }] };
  census.registerColony(amber);
  census.registerColony(slate);
  const newborn = { id: 2 };
  amber.workers.push(newborn);
  assert.equal(census.registerWorker(newborn, amber), true);
  assert.equal(census.markDead(slate.workers[0], slate), true);
  assert.equal(census.markDead(slate.workers[0], slate), false);
  assert.equal(census.colonyCount('amber'), 2);
  assert.equal(census.colonyCount('slate'), 1);
  assert.equal(census.totalLiving, 3);
});

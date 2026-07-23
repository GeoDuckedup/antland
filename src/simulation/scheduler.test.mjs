import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntervalScheduler, drainFixedStepBacklog } from './scheduler.js';

test('interval scheduler runs immediately, then only at its declared cadence', () => {
  const scheduler = createIntervalScheduler();
  assert.equal(scheduler.due('summary', 0.03, 0.25), true);
  assert.equal(scheduler.due('summary', 0.2, 0.25), false);
  assert.equal(scheduler.due('summary', 0.28, 0.25), true);
  assert.equal(scheduler.due('summary', 0.4, 0.25), false);
});

test('interval scheduler skips missed intervals without catch-up bursts', () => {
  const scheduler = createIntervalScheduler();
  assert.equal(scheduler.due('slow', 0, 1), true);
  assert.equal(scheduler.due('slow', 3.4, 1), true);
  assert.equal(scheduler.due('slow', 3.5, 1), false);
  scheduler.reset('slow');
  assert.equal(scheduler.due('slow', 3.5, 1, { immediate: false }), false);
  assert.equal(scheduler.due('slow', 4.5, 1, { immediate: false }), true);
});

test('fixed-step drain consumes ordinary frame work without changing simulation time', () => {
  let calls = 0;
  const result = drainFixedStepBacklog({
    accumulator: 0.125,
    fixedDt: 0.025,
    maxSteps: 8,
    maxDeferredSteps: 2,
    step: () => { calls += 1; },
  });
  assert.equal(calls, 5);
  assert.equal(result.completedSteps, 5);
  assert.equal(result.deferredSteps, 0);
  assert.equal(result.droppedSteps, 0);
  assert.ok(result.accumulator < 1e-10);
});

test('fixed-step drain bounds overload and reports deferred and dropped work', () => {
  let calls = 0;
  const result = drainFixedStepBacklog({
    accumulator: 0.5,
    fixedDt: 0.025,
    maxSteps: 8,
    maxDeferredSteps: 3,
    step: () => { calls += 1; },
  });
  assert.equal(calls, 8);
  assert.equal(result.completedSteps, 8);
  assert.equal(result.deferredSteps, 3);
  assert.equal(result.droppedSteps, 9);
  assert.equal(result.droppedSeconds, 0.225);
  assert.ok(Math.abs(result.accumulator - 0.075) < 1e-10);
});

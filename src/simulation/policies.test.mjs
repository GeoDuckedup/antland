import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateDemographicState,
  createLifecyclePolicy,
  deterministicQueenLongevity,
  workerMaturity,
} from './lifecycle.js';
import {
  calculateFoundingSiteQuality,
  calculateSeedCohortStep,
  calculateStoredFoodAcceptance,
  calculateStoredFoodConsumption,
  plantSeedWindow,
} from './ecology.js';

test('haplodiploid inheritance preserves parentage and sire accounting', () => {
  const policy = createLifecyclePolicy({ rand: (minimum, maximum) => (minimum + maximum) * 0.5 });
  const genome = { speed: 1, size: 1, diseaseResistance: 1, aggression: 1, foraging: 1 };
  const reproduction = policy.createQueenReproduction('test', genome, 2);
  const daughter = policy.createOffspringInheritance('queen-test', genome, reproduction, 'worker');
  const son = policy.createOffspringInheritance('queen-test', genome, reproduction, 'male');
  assert.equal(daughter.sex, 'female');
  assert.equal(daughter.parentage.ploidy, 'diploid');
  assert.equal(reproduction.spermBank.reduce((sum, sire) => sum + sire.daughters, 0), 1);
  assert.equal(son.sex, 'male');
  assert.equal(son.parentage.sireId, null);
  assert.equal(son.parentage.ploidy, 'haploid');
});

test('lifecycle thresholds and deterministic queen lifespan are stable', () => {
  assert.deepEqual([4.9, 5, 16, 32].map(workerMaturity), ['callow', 'young', 'mature', 'veteran']);
  const colony = { id: 'amber' };
  assert.equal(deterministicQueenLongevity(colony), deterministicQueenLongevity(colony));
  assert.notEqual(deterministicQueenLongevity(colony), deterministicQueenLongevity({ id: 'slate' }));
});

test('demography responds to food, excavated space, season, and queen state', () => {
  const colony = {
    id: 'amber',
    queen: { alive: true },
    lifeHistory: { queenVitality: 1 },
    workers: Array.from({ length: 20 }, () => ({ alive: true })),
    brood: Array.from({ length: 4 }, () => ({ stage: 'larva' })),
    storedFood: 40,
  };
  const spring = calculateDemographicState({
    colony,
    careRatio: 1,
    workerCapacity: 80,
    broodCapacity: 40,
    seasonName: 'spring',
    environmentPressure: 'stable',
  });
  const winter = calculateDemographicState({
    colony,
    careRatio: 1,
    workerCapacity: 80,
    broodCapacity: 40,
    seasonName: 'winter',
    environmentPressure: 'stable',
  });
  assert.ok(spring.layingDrive > 0);
  assert.equal(winter.layingDrive, 0);
  assert.equal(winter.queenState, 'winter pause');
});

test('ecology policy preserves seed windows, viability, and storage accounting', () => {
  assert.equal(plantSeedWindow({ species: 'needlegrass' }, 'spring', 0.6), true);
  assert.equal(plantSeedWindow({ species: 'desertForb' }, 'spring', 0.6), false);
  const cohort = calculateSeedCohortStep(
    { viability: 0.8, germinationProgress: 0.2 },
    1,
    'spring',
    0.9,
  );
  assert.ok(cohort.viability < 0.8);
  assert.ok(cohort.germinationProgress > 0.2);
  assert.deepEqual(calculateStoredFoodAcceptance(9, 4, 10), { next: 10, overflow: 3 });
  const consumed = calculateStoredFoodConsumption({
    current: 30,
    dt: 1,
    workerCount: 20,
    seasonName: 'summer',
    completedGranaries: 1,
    postRainHumidity: 0.4,
    rain: 0,
  });
  assert.ok(consumed.next < 30);
  assert.ok(consumed.metabolized > 0);
  assert.ok(consumed.spoiled > 0);
});

test('founding-site quality rewards level, clear, moist sites', () => {
  const favorable = calculateFoundingSiteQuality({
    groundNormalY: 1,
    x: 0,
    z: 0,
    territorialColonies: [{ nest: { x: 10, y: 10 } }],
    obstacles: [],
    postRainHumidity: 0.8,
    rain: 0,
  });
  const poor = calculateFoundingSiteQuality({
    groundNormalY: 0.9,
    x: 0,
    z: 0,
    territorialColonies: [{ nest: { x: 1, y: 1 } }],
    obstacles: [{ x: 0.4, z: 0.4, r: 0.5 }],
    postRainHumidity: 0,
    rain: 1,
  });
  assert.ok(favorable > poor);
});

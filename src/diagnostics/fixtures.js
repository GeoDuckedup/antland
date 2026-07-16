import { SIMULATION_SEED_LABEL } from '../config/simulation.js';

export const PHASE_8E_BASELINE = Object.freeze({
  commit: '592cc6f775cfd1dde6a8db7ee2f3ed9a77219ec7',
  seed: SIMULATION_SEED_LABEL,
  schemaVersion: 1,
});

export const FIXTURE_PATHS = Object.freeze({
  normal: './fixtures/phase8e/normal-year.json',
  abundance: './fixtures/phase8e/abundance-two-years.json',
  scarcity: './fixtures/phase8e/scarcity-two-years.json',
  succession: './fixtures/phase8e/succession-two-years.json',
  maturity: './fixtures/phase8e/maturity-three-years.json',
  'founding-stress': './fixtures/phase8e/founding-stress.json',
  'young-collapse': './fixtures/phase8e/young-collapse.json',
  'mature-nest': './fixtures/phase8e/focused-mature-nest.json',
  'descendant-nest': './fixtures/phase8e/focused-descendant-nest.json',
});

const IGNORED_QUERY_KEYS = new Set(['debug', 'fixture', 'fixtureCompare', 'fixtureExport']);

export function canonicalScenarioQuery(searchParams) {
  return [...searchParams.entries()]
    .filter(([key]) => !IGNORED_QUERY_KEYS.has(key))
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function colonyFixture(colony) {
  return {
    id: colony.id,
    lineageId: colony.lineageId,
    status: colony.status,
    foundedBy: colony.foundedBy,
    workers: colony.workers,
    storedFood: colony.storedFood,
    workersEclosed: colony.workersEclosed,
    deaths: colony.deaths,
    queen: {
      alive: colony.queen.alive,
      lifeStage: colony.lifeHistory?.stage || null,
      territoryState: colony.lifeHistory?.territoryState || null,
    },
    brood: {
      total: colony.brood.total,
      eggs: colony.brood.eggs,
      larvae: colony.brood.larvae,
      pupae: colony.brood.pupae,
      males: colony.brood.males,
      gynes: colony.brood.gynes,
    },
    nest: colony.architecture ? {
      nodeCount: colony.architecture.nodeCount,
      edgeCount: colony.architecture.edgeCount,
      completedNewChambers: colony.architecture.completedNewChambers,
      activeGrowthFronts: colony.architecture.activeGrowthFronts,
      habitableCapacity: colony.architecture.habitableCapacity,
      broodCapacity: colony.architecture.broodCapacity,
      storageCapacity: colony.architecture.storageCapacity,
      deepestDepth: colony.architecture.deepestDepth,
      chamberTypes: colony.architecture.chambers.reduce((counts, chamber) => {
        counts[chamber.type] = (counts[chamber.type] || 0) + 1;
        return counts;
      }, {}),
    } : null,
  };
}

function foundationFixture(queen) {
  const founding = queen.founding || {};
  return {
    id: queen.id,
    lineageId: queen.lineageId,
    natalColonyId: queen.natalColonyId,
    alive: queen.alive,
    generation: queen.generation,
    mateCount: queen.mateCount,
    x: queen.x,
    z: queen.z,
    state: queen.state,
    stage: founding.stage || null,
    siteQuality: founding.siteQuality ?? null,
    rejectedSites: founding.rejectedSites ?? 0,
    chamberProgress: founding.chamberProgress ?? 0,
    entranceOpenProgress: founding.entranceOpenProgress ?? 0,
    reserves: founding.reserves ?? 0,
    colonyFood: founding.colonyFood ?? 0,
    foodDelivered: founding.foodDelivered ?? 0,
    queenHealth: founding.queenHealth ?? 0,
    stress: founding.stress ?? 0,
    brood: founding.brood || { total: 0, eggs: 0, larvae: 0, pupae: 0, deaths: 0 },
    nanitics: founding.nanitics ?? 0,
    surfaceWorkers: founding.surfaceWorkers ?? 0,
    workerDeaths: founding.workerDeaths ?? 0,
    registeredColonyId: founding.registeredColonyId || null,
    settledVacancyId: founding.settledVacancyId || null,
    failureCause: founding.failureCause || null,
    collapseCause: founding.collapseCause || null,
  };
}

function lineageEventCounts(lineageHistory) {
  return (lineageHistory?.events || []).reduce((counts, event) => {
    counts[event.type] = (counts[event.type] || 0) + 1;
    return counts;
  }, {});
}

export function createDeterministicFixture(report, metadata = {}) {
  const vegetation = report.environment.vegetation;
  return {
    schemaVersion: PHASE_8E_BASELINE.schemaVersion,
    baseline: {
      commit: PHASE_8E_BASELINE.commit,
      seed: PHASE_8E_BASELINE.seed,
      scenario: metadata.scenario || 'custom',
      query: metadata.query || '',
      targetSimulationSeconds: metadata.targetSimulationSeconds ?? report.timeSeconds,
    },
    clock: {
      timeSeconds: report.timeSeconds,
      ecologicalYear: report.ecologicalEquilibrium.ecologicalYear,
      calendar: report.ecologicalEquilibrium.calendar,
      season: report.environment.season,
      seasonProgress: report.environment.seasonProgress,
      weather: report.weather,
    },
    population: {
      activeColonies: report.population.activeColonies,
      totalWorkers: report.population.totalWorkers,
      colonies: report.population.colonies.map(colonyFixture),
    },
    ecology: {
      surfaceFoodUnits: report.ecologicalEquilibrium.surfaceFoodUnits,
      activeFoodSources: report.ecologicalEquilibrium.activeFoodSources,
      retainedFoodRecords: report.ecologicalEquilibrium.retainedFoodRecords,
      livingPlants: vegetation.livingPlants,
      seedlings: vegetation.seedlings,
      seedBearingPlants: vegetation.seedBearingPlants,
      soilSeedCohorts: vegetation.soilSeedCohorts,
      dormantSeedUnits: vegetation.dormantSeedUnits,
      antDispersedPlants: vegetation.antDispersedPlants,
      plantFlows: vegetation.flows,
    },
    mortality: {
      regional: report.environment.mortality,
      colonyDeaths: Object.fromEntries(report.population.colonies.map((colony) => [colony.id, colony.deaths])),
    },
    succession: {
      queenDeaths: report.regionalLifeHistory.queenDeaths,
      colonyExtinctions: report.regionalLifeHistory.colonyExtinctions,
      reproductiveMaturities: report.regionalLifeHistory.reproductiveMaturities,
      lineageReplacements: report.regionalLifeHistory.lineageReplacements,
      vacancies: report.regionalLifeHistory.vacancies.map((vacancy) => ({
        id: vacancy.id,
        formerColonyId: vacancy.formerColonyId,
        state: vacancy.state,
        replacementColonyId: vacancy.replacementColonyId,
        replacementLineageId: vacancy.replacementLineageId,
      })),
      census: report.regionalLifeHistory.censuses,
    },
    founding: {
      outcomes: report.regionalMating?.outcomes || {},
      foundations: (report.regionalMating?.matedQueens || []).map(foundationFixture),
      lineageEventTotal: report.lineageHistory?.totalEvents || 0,
      lineageEventCounts: lineageEventCounts(report.lineageHistory),
    },
    focus: {
      colonyId: report.population.focusedColonyId || null,
      view: report.view,
    },
  };
}

function compareValue(expected, actual, path, differences, tolerance) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Math.abs(expected - actual) > tolerance) {
      differences.push({ subsystem: path.split('.')[0], path, expected, actual });
    }
    return;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
      differences.push({ subsystem: path.split('.')[0], path: `${path}.length`, expected: expected?.length, actual: actual?.length });
      return;
    }
    expected.forEach((value, index) => compareValue(value, actual[index], `${path}[${index}]`, differences, tolerance));
    return;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') {
      differences.push({ subsystem: path.split('.')[0], path, expected, actual });
      return;
    }
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) compareValue(expected[key], actual[key], path ? `${path}.${key}` : key, differences, tolerance);
    return;
  }
  if (expected !== actual) differences.push({ subsystem: path.split('.')[0], path, expected, actual });
}

export function compareDeterministicFixtures(expected, actual, { numericTolerance = 0.0001 } = {}) {
  const differences = [];
  compareValue(expected, actual, '', differences, numericTolerance);
  return {
    ok: differences.length === 0,
    differenceCount: differences.length,
    changedSubsystems: [...new Set(differences.map((difference) => difference.subsystem))].filter(Boolean),
    differences: differences.slice(0, 80),
  };
}

export async function compareWithSavedFixture(url, actual) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Fixture ${url} returned ${response.status}`);
  const expected = await response.json();
  return compareDeterministicFixtures(expected, actual);
}

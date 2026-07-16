import {
  BROOD_STAGE_SECONDS,
  COLONY_REPRODUCTIVE_MATURITY_YEARS,
  GENE_KEYS,
  HOME_COLONY_ID,
  QUEEN_LIFESPAN_MAX_YEARS,
  QUEEN_LIFESPAN_MIN_YEARS,
  RIVAL_COLONY_ID,
  SIM_DAYS_PER_SECOND,
  TECHNICAL_DESCENDANT_WORKER_LIMIT,
  TECHNICAL_GLOBAL_WORKER_LIMIT,
  TECHNICAL_HOME_WORKER_LIMIT,
  TECHNICAL_RIVAL_WORKER_LIMIT,
} from '../config/simulation.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function calculateColonyAgeYears(colony, simTime, ecologicalYearSeconds) {
  if (!colony) return 0;
  return colony.ageAtStartYears + Math.max(0, simTime - (colony.foundedAt || 0)) / ecologicalYearSeconds;
}

export function isColonyReproductivelyMature(colony, ageYears) {
  const maturityAge = colony?.lifeHistory?.reproductiveMaturityAgeYears
    ?? COLONY_REPRODUCTIVE_MATURITY_YEARS;
  return Boolean(colony && ageYears >= maturityAge
    && colony.lifeHistory?.lifeStage !== 'orphaned' && colony.status !== 'extinct');
}

export function technicalWorkerLimit(colonyId) {
  if (colonyId === HOME_COLONY_ID) return TECHNICAL_HOME_WORKER_LIMIT;
  if (colonyId === RIVAL_COLONY_ID) return TECHNICAL_RIVAL_WORKER_LIMIT;
  return TECHNICAL_DESCENDANT_WORKER_LIMIT;
}

export function hasTechnicalWorkerCapacity(colonyId, currentWorkers, totalWorkers) {
  return currentWorkers < technicalWorkerLimit(colonyId)
    && totalWorkers < TECHNICAL_GLOBAL_WORKER_LIMIT;
}

export function averageGenome(population) {
  const result = Object.fromEntries(GENE_KEYS.map((key) => [key, 0]));
  if (population.length === 0) return result;
  for (const individual of population) {
    for (const key of GENE_KEYS) result[key] += individual.genome?.[key] || 1;
  }
  for (const key of GENE_KEYS) result[key] = Number((result[key] / population.length).toFixed(3));
  return result;
}

export function workerMaturity(ageDays) {
  if (ageDays < 5) return 'callow';
  if (ageDays < 16) return 'young';
  if (ageDays < 32) return 'mature';
  return 'veteran';
}

export function reproductiveCost(destiny) {
  return destiny === 'gyne' ? 5.4 : destiny === 'male' ? 2.1 : 0.7;
}

export function broodStageDuration(item) {
  const casteMultiplier = item.destiny === 'gyne' ? 1.42 : item.destiny === 'male' ? 1.08 : 1;
  return BROOD_STAGE_SECONDS[item.stage] * casteMultiplier;
}

export function nextAlateState(alate, dt, seasonName, rain) {
  return {
    ageDays: alate.ageDays + dt * SIM_DAYS_PER_SECOND,
    state: seasonName === 'winter'
      ? 'overwintering in the alate chamber'
      : seasonName === 'summer' && rain < 0.22
        ? 'waiting for a humid flight window'
        : 'waiting in the alate chamber',
  };
}

export function deterministicQueenLongevity(colony) {
  let hash = 2166136261;
  for (const character of colony.id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const normalized = (hash >>> 0) / 4294967295;
  return QUEEN_LIFESPAN_MIN_YEARS
    + normalized * (QUEEN_LIFESPAN_MAX_YEARS - QUEEN_LIFESPAN_MIN_YEARS);
}

export function buildInitialColonyLifeHistory({
  colony,
  ageYears,
  successionScenario,
}) {
  let queenLongevityYears = deterministicQueenLongevity(colony);
  if (successionScenario === 'amber' && colony.id === HOME_COLONY_ID) {
    queenLongevityYears = colony.ageAtStartYears + 0.45;
  }
  const reproductiveMaturityAgeYears = successionScenario === 'maturity'
    && colony.id !== HOME_COLONY_ID && colony.id !== RIVAL_COLONY_ID
    ? 0.75 : COLONY_REPRODUCTIVE_MATURITY_YEARS;
  return {
    reproductiveMaturityAgeYears,
    queenLongevityYears,
    queenAgeYears: ageYears,
    queenVitality: 1,
    lifeStage: ageYears >= reproductiveMaturityAgeYears ? 'reproductive prime' : 'pre-reproductive',
    maturityRecorded: ageYears >= reproductiveMaturityAgeYears,
    senescenceRecorded: false,
    queenDiedAt: null,
    queenDeathAgeYears: null,
    queenDeathCause: null,
    orphanedAt: null,
    workersAtQueenDeath: null,
    extinctAt: null,
    territoryState: 'occupied',
    vacancyId: null,
    replacementColonyId: null,
  };
}

export function queenVitalityAtAge(ageYears, queenLongevityYears, senescenceYears) {
  const yearsRemaining = queenLongevityYears - ageYears;
  return yearsRemaining >= senescenceYears ? 1
    : clamp(0.32 + yearsRemaining / senescenceYears * 0.68, 0, 1);
}

export function calculateDemographicState({
  colony,
  careRatio,
  workerCapacity,
  broodCapacity,
  seasonName,
  environmentPressure,
}) {
  if (!colony) return null;
  const workers = colony.workers.filter((worker) => worker.alive !== false);
  const broodItems = colony.brood || [];
  const larvae = broodItems.filter((item) => item.stage === 'larva').length;
  const workerLoad = workers.length + broodItems.length * 0.58;
  const occupancy = workerLoad / Math.max(1, workerCapacity);
  const broodOccupancy = broodItems.length / Math.max(1, broodCapacity);
  const reserveTarget = 8 + workers.length * 0.14 + broodItems.length * 0.24 + larvae * 1.55;
  const reserveRatio = colony.storedFood / Math.max(1, reserveTarget);
  const foodFactor = clamp((reserveRatio - 0.2) / 0.92, 0, 1);
  const broodSpaceFactor = clamp((1.08 - broodOccupancy) / 0.34, 0, 1);
  const workerSpaceFactor = clamp((1.16 - occupancy) / 0.34, 0, 1);
  const seasonFactor = seasonName === 'winter' ? 0 : seasonName === 'autumn' ? 0.72 : 1;
  const safetyFactor = colony.id === HOME_COLONY_ID && environmentPressure === 'disease outbreak' ? 0.38 : 1;
  const careFactor = clamp(0.34 + careRatio * 0.66, 0.34, 1);
  const queenAlive = colony.queen?.alive !== false;
  const queenVitality = colony.lifeHistory?.queenVitality ?? 1;
  const layingDrive = queenAlive ? clamp(foodFactor * broodSpaceFactor * workerSpaceFactor
    * seasonFactor * safetyFactor * careFactor * queenVitality, 0, 1) : 0;
  const starvationPressure = clamp((0.28 - reserveRatio) / 0.28, 0, 1);
  const crowdingPressure = clamp((occupancy - 1) / 0.34, 0, 1);
  const factors = [
    ['food', foodFactor],
    ['brood space', broodSpaceFactor],
    ['worker space', workerSpaceFactor],
    ['nursing', careFactor],
    ['season', seasonFactor],
  ];
  const weakestFactor = factors.sort((a, b) => a[1] - b[1])[0];
  const limitingFactor = !queenAlive ? 'queen absent' : weakestFactor[1] > 0.96 ? 'none' : weakestFactor[0];
  return {
    workers: workers.length,
    brood: broodItems.length,
    workerCapacity,
    broodCapacity,
    occupancy,
    broodOccupancy,
    reserveTarget,
    reserveRatio,
    foodFactor,
    broodSpaceFactor,
    workerSpaceFactor,
    layingDrive,
    starvationPressure,
    crowdingPressure,
    limitingFactor,
    queenState: !queenAlive ? 'queen dead · orphaned workforce'
      : seasonName === 'winter' ? 'winter pause'
        : layingDrive >= 0.62 ? 'laying strongly'
          : layingDrive >= 0.18 ? `laying slowly · ${limitingFactor} limited`
            : `laying paused · ${limitingFactor} limited`,
  };
}

export function createLifecyclePolicy({ rand }) {
  function mutateGenome(base, amount = 0.055) {
    const genome = {};
    for (const key of GENE_KEYS) genome[key] = clamp(base[key] + rand(-amount, amount), 0.72, 1.3);
    return genome;
  }

  function createSireBank(prefix, maternalGenome, count = 4) {
    const neutral = { speed: 1, size: 1, diseaseResistance: 1, aggression: 1, foraging: 1 };
    return Array.from({ length: count }, (_, index) => {
      const base = {};
      for (const key of GENE_KEYS) base[key] = neutral[key] * 0.68 + maternalGenome[key] * 0.32;
      return {
        id: `${prefix}-sire-${index + 1}`,
        lineageId: `regional-${prefix}-${String.fromCharCode(97 + index)}`,
        genome: mutateGenome(base, 0.13),
        storedShare: rand(0.72, 1.28),
        daughters: 0,
      };
    });
  }

  function createQueenReproduction(prefix, maternalGenome, sireCount) {
    return {
      spermBank: createSireBank(prefix, maternalGenome, sireCount),
      reproductiveBudget: 9,
      maleInvestment: 0,
      gyneInvestment: 0,
      sexualEggsLaid: 0,
      workerEggsLaid: 0,
      malesEclosed: 0,
      gynesEclosed: 0,
      malesLaunched: 0,
      gynesLaunched: 0,
      matedGynes: 0,
      alates: [],
      nextAlateId: 1,
    };
  }

  function chooseStoredSire(reproduction) {
    const total = reproduction.spermBank.reduce((sum, sire) => sum + sire.storedShare, 0);
    let pick = rand(0, total);
    for (const sire of reproduction.spermBank) {
      pick -= sire.storedShare;
      if (pick <= 0) return sire;
    }
    return reproduction.spermBank[reproduction.spermBank.length - 1];
  }

  function recombineFemaleGenome(maternalGenome, paternalGenome, mutation = 0.026) {
    const genome = {};
    for (const key of GENE_KEYS) {
      const dominance = rand(0.38, 0.62);
      const inherited = maternalGenome[key] * dominance + paternalGenome[key] * (1 - dominance);
      genome[key] = clamp(inherited + rand(-mutation, mutation), 0.72, 1.3);
    }
    return genome;
  }

  function inheritMaleGenome(maternalGenome, mutation = 0.026) {
    return mutateGenome(maternalGenome, mutation);
  }

  function createOffspringInheritance(maternalId, maternalGenome, reproduction, destiny = 'worker') {
    if (destiny === 'male') {
      return {
        sex: 'male',
        destiny,
        genome: inheritMaleGenome(maternalGenome),
        parentage: { damId: maternalId, sireId: null, sireLineageId: null, ploidy: 'haploid' },
      };
    }
    const sire = chooseStoredSire(reproduction);
    sire.daughters++;
    return {
      sex: 'female',
      destiny,
      genome: recombineFemaleGenome(maternalGenome, sire.genome),
      parentage: { damId: maternalId, sireId: sire.id, sireLineageId: sire.lineageId, ploidy: 'diploid' },
    };
  }

  function chooseSexualDestiny(reproduction) {
    return reproduction.maleInvestment <= reproduction.gyneInvestment ? 'male' : 'gyne';
  }

  return {
    mutateGenome,
    createSireBank,
    createQueenReproduction,
    chooseStoredSire,
    recombineFemaleGenome,
    inheritMaleGenome,
    createOffspringInheritance,
    chooseSexualDestiny,
  };
}

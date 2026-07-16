import { HOME_COLONY_ID, RIVAL_COLONY_ID } from '../config/simulation.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function seedBankCapacity(colonyId) {
  return colonyId === HOME_COLONY_ID ? 140 : colonyId === RIVAL_COLONY_ID ? 110 : 46;
}

export function plantSeedWindow(plant, seasonName, seasonProgress) {
  if (plant.species === 'needlegrass') {
    return seasonName === 'spring' && seasonProgress > 0.48
      || seasonName === 'summer' && seasonProgress < 0.32;
  }
  if (plant.species === 'desertForb') return seasonName === 'summer' && seasonProgress > 0.18;
  return seasonName === 'autumn' && seasonProgress > 0.08;
}

export function calculatePlantSeasonStep({
  plant,
  dt,
  seasonName,
  seasonProgress,
  postRainHumidity,
  seasonKey,
}) {
  let maturity = plant.maturity;
  let health = plant.health;
  let phenology = plant.phenology;
  let lastWinterCheck = plant.lastWinterCheck;
  let mortalityRisk = null;

  if (seasonName === 'spring') {
    maturity = clamp(maturity + dt * 0.0017 * (0.7 + postRainHumidity * 0.5), 0, 1);
    health = clamp(health + dt * 0.0014, 0, 1);
    phenology = maturity < 0.45 ? 'seedling growth'
      : seasonProgress > 0.48 ? 'flowering and setting seed' : 'spring growth';
  } else if (seasonName === 'summer') {
    health = clamp(health - dt * 0.00028, 0.34, 1);
    phenology = plantSeedWindow(plant, seasonName, seasonProgress) ? 'ripening seed head' : 'summer growth';
  } else if (seasonName === 'autumn') {
    phenology = 'dry seed fall';
  } else {
    phenology = 'winter dormancy';
    if (seasonProgress > 0.62 && lastWinterCheck !== seasonKey) {
      lastWinterCheck = seasonKey;
      mortalityRisk = maturity < 0.28 ? 0.14 : health < 0.48 ? 0.11 : 0.025;
    }
  }
  return { maturity, health, phenology, lastWinterCheck, mortalityRisk };
}

export function calculateSeedCohortStep(cohort, dt, seasonName, moisture) {
  if (seasonName === 'spring') {
    const viability = Math.max(0, cohort.viability - dt * 0.00022);
    return {
      viability,
      germinationProgress: cohort.germinationProgress + dt * 0.009 * moisture * viability,
    };
  }
  return {
    viability: Math.max(0, cohort.viability - dt * 0.00008),
    germinationProgress: cohort.germinationProgress,
  };
}

export function architectureBroodCapacity(architecture) {
  if (!architecture) return 12;
  const excavatedNurserySpace = architecture.nodes
    .filter((node) => node.completed && (node.type === 'nursery' || node.type === 'founding'))
    .reduce((sum, node) => sum + Math.max(4, Math.round(node.capacity * 0.72)), 0);
  return Math.max(8, architecture.baseBroodCapacity + excavatedNurserySpace);
}

export function architectureWorkerCapacity(architecture) {
  if (!architecture) return 24;
  return Math.max(8, architecture.baseCapacity
    + architecture.nodes.filter((node) => node.completed).reduce((sum, node) => sum + node.capacity, 0));
}

export function foodStorageCapacity(colony) {
  return Math.max(6, Math.round(
    colony?.architecture?.storageCapacity || colony?.architecture?.baseStorageCapacity || 6,
  ));
}

export function calculateStoredFoodAcceptance(current, incoming, capacity) {
  return {
    next: Math.min(capacity, current + incoming),
    overflow: Math.max(0, current + incoming - capacity),
  };
}

export function calculateStoredFoodConsumption({
  current,
  dt,
  workerCount,
  workerRate = 0.0011,
  baseRate = 0.012,
  seasonName,
  completedGranaries,
  postRainHumidity,
  rain,
}) {
  const seasonalRate = seasonName === 'winter' ? 1.28 : seasonName === 'summer' ? 1.08 : 1;
  const requestedMetabolism = dt * (baseRate + workerCount * workerRate) * seasonalRate;
  const metabolized = Math.min(current, requestedMetabolism);
  let next = current - metabolized;
  const granaryProtection = clamp(1 - completedGranaries * 0.035, 0.5, 1);
  const humidity = clamp((postRainHumidity || 0) + rain * 0.75, 0, 1.4);
  const spoilageRate = (0.00032 + humidity * 0.00042) * granaryProtection;
  const spoiled = Math.min(next, next * spoilageRate * dt);
  next -= spoiled;
  return { next: Math.max(0, next), metabolized, spoiled };
}

export function calculateArchitecturePressure(architecture, colony) {
  const workers = colony.workers.filter((worker) => worker.alive !== false);
  const brood = colony.brood || [];
  const habitableCapacity = architecture.baseCapacity
    + architecture.nodes.filter((node) => node.completed).reduce((sum, node) => sum + node.capacity, 0);
  const storageCapacity = architecture.baseStorageCapacity
    + architecture.nodes.filter((node) => node.completed).reduce((sum, node) => sum + node.storageCapacity, 0);
  const load = workers.length + brood.length * 0.58;
  const occupancy = load / Math.max(1, habitableCapacity);
  const storagePressure = colony.storedFood / Math.max(1, storageCapacity);
  const larvae = brood.filter((item) => item.stage === 'larva').length;
  const reserveTarget = 8 + workers.length * 0.14 + brood.length * 0.24 + larvae * 1.55;
  const reserveRatio = colony.storedFood / Math.max(1, reserveTarget);
  const usefulStoragePressure = storagePressure * clamp((6.2 - reserveRatio) / 3.2, 0, 1);
  const broodPressure = brood.length / Math.max(1, workers.length * 0.18);
  const growthDrive = Math.max(occupancy, usefulStoragePressure * 0.76, broodPressure * 0.68);
  return {
    workers,
    brood,
    habitableCapacity,
    storageCapacity,
    occupancy,
    storagePressure,
    usefulStoragePressure,
    reserveRatio,
    broodPressure,
    growthDrive,
  };
}

export function chooseArchitectureChamberType(architecture, pressure) {
  if (architecture.growthIndex % 5 === 4) return 'shaft';
  if (pressure.broodPressure > 0.76) return 'nursery';
  if (pressure.usefulStoragePressure > 0.78) return 'granary';
  return architecture.growthIndex % 3 === 2 ? 'ventilation' : 'resting';
}

export function flightLightLevel(simTime) {
  return (Math.sin(simTime * 0.027) + 1) * 0.5;
}

export function calculateNuptialFlightSuitability({
  simTime,
  seasonName,
  rain,
  postRainHumidity,
}) {
  const seasonal = seasonName === 'spring' || seasonName === 'summer';
  if (!seasonal) return 0;
  const calm = 1 - clamp(rain * 3.4, 0, 1);
  const humidity = clamp(postRainHumidity || 0, 0, 1);
  const light = clamp((flightLightLevel(simTime) - 0.22) / 0.58, 0, 1);
  return calm * humidity * light;
}

export function calculateFoundingSiteQuality({
  groundNormalY,
  x,
  z,
  territorialColonies,
  obstacles,
  postRainHumidity,
  rain,
}) {
  const slopeQuality = clamp((groundNormalY - 0.9) / 0.095, 0, 1);
  const nestClearance = territorialColonies.reduce(
    (minimum, colony) => Math.min(minimum, Math.hypot(x - colony.nest.x, z - colony.nest.y)),
    20,
  );
  const nestQuality = clamp((nestClearance - 3.2) / 5.8, 0, 1);
  const obstacleClearance = obstacles.reduce(
    (minimum, obstacle) => Math.min(minimum, Math.hypot(x - obstacle.x, z - obstacle.z) - obstacle.r),
    6,
  );
  const obstacleQuality = clamp((obstacleClearance - 0.5) / 2.8, 0, 1);
  const moisture = clamp(0.52 + postRainHumidity * 0.28 - rain * 0.18, 0.25, 0.86);
  return clamp(
    slopeQuality * 0.28 + nestQuality * 0.28 + obstacleQuality * 0.24 + moisture * 0.2,
    0.18,
    0.96,
  );
}

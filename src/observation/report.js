import {
  ECOLOGICAL_YEAR_SECONDS,
  GENE_KEYS,
  PLANT_PROFILES,
  RIVAL_COLONY_ID,
  SPECIES_PROFILE,
  TECHNICAL_GLOBAL_WORKER_LIMIT,
} from '../config/simulation.js';

function summarizeDemographics(colony, demographicStateFor) {
  const state = colony.demographics || demographicStateFor(colony);
  if (!state) return null;
  return {
    regulation: 'food + nursery space + excavated worker space + queen rate + mortality',
    workerSpace: { used: state.workers, available: state.workerCapacity, occupancy: Number(state.occupancy.toFixed(2)) },
    broodSpace: { used: state.brood, available: state.broodCapacity, occupancy: Number(state.broodOccupancy.toFixed(2)) },
    reserveTarget: Number(state.reserveTarget.toFixed(1)),
    reserveRatio: Number(state.reserveRatio.toFixed(2)),
    foodSufficiency: Number(state.foodFactor.toFixed(2)),
    queenLayingDrive: Number(state.layingDrive.toFixed(2)),
    queenState: state.queenState,
    limitingFactor: state.limitingFactor,
    starvationPressure: Number(state.starvationPressure.toFixed(2)),
    crowdingPressure: Number(state.crowdingPressure.toFixed(2)),
    technicalSafetyCeiling: colony.technicalWorkerLimit,
  };
}

function summarizeForagingNetwork(network, sectorTarget) {
  if (!network) return null;
  const activeSectors = network.sectors.filter((sector) => sector.activeForagers > 0).length;
  const establishedTrunks = network.sectors.filter((sector) => sector.successes >= 2 && sector.trunkStrength > 0.08).length;
  return {
    sectorCount: network.sectors.length,
    activeSectors,
    establishedTrunks,
    routeSwitches: network.routeSwitches,
    congestionReroutes: network.congestionReroutes,
    staleMemoriesExpired: network.staleMemoriesExpired,
    learningWalksCompleted: network.learningWalksCompleted,
    privateMemorySeconds: Number(network.memoryGuidedSteps.toFixed(1)),
    socialInformationSeconds: Number(network.socialGuidedSteps.toFixed(1)),
    localSearchSeconds: Number(network.localSearchSteps.toFixed(1)),
    exploratorySearchSeconds: Number(network.exploratorySteps.toFixed(1)),
    recentPeakSectorShare: Number(network.peakSectorShare.toFixed(2)),
    currentPeakSectorShare: Number(network.currentPeakSectorShare.toFixed(2)),
    sectors: network.sectors.map((sector) => {
      const target = sectorTarget(network, sector);
      return {
        id: sector.id,
        bearingDegrees: Math.round((sector.angle * 180 / Math.PI + 360) % 360),
        confidence: Number(sector.confidence.toFixed(2)),
        socialPulse: Number(sector.socialPulse.toFixed(2)),
        discoveries: sector.discoveries,
        successfulReturns: sector.successes,
        failures: sector.failures,
        activeForagers: sector.activeForagers,
        availableFood: Math.round(sector.availableFood),
        resourceSites: sector.resourceSites,
        recruitmentCapacity: sector.recruitmentCapacity,
        congestion: Number(sector.congestion.toFixed(2)),
        stale: sector.stale,
        trunkStrength: Number(sector.trunkStrength.toFixed(2)),
        target: { x: Number(target.x.toFixed(1)), z: Number(target.z.toFixed(1)) },
      };
    }),
  };
}

function summarizeSeedBank(bank) {
  if (!bank) return null;
  return {
    currentSeeds: Number(bank.current.toFixed(1)),
    capacity: bank.capacity,
    lifetimeStored: Number(bank.totalStored.toFixed(1)),
    consumed: Number(bank.consumed.toFixed(1)),
    dispersedToSurface: Number(bank.dispersed.toFixed(1)),
    sproutedInStore: Number(bank.sproutedInStore.toFixed(1)),
    overflowDiscarded: bank.overflowDiscarded,
    species: Object.fromEntries(Object.entries(bank.species).map(([species, count]) => [species, Number(count.toFixed(1))])),
  };
}

function summarizeArchitecture(architecture, {
  architectureBroodCapacity,
  architectureNodeById,
  chamberDepth,
  workerDisplayId,
}) {
  if (!architecture) return null;
  const active = architecture.edges.find((edge) => !edge.completed) || null;
  return {
    system: 'shared pressure-driven nest graph',
    baseChambers: architecture.baseChambers,
    nodeCount: architecture.nodes.length,
    edgeCount: architecture.edges.length,
    completedNewChambers: architecture.nodes.filter((node) => node.renderChamber && node.completed).length,
    activeGrowthFronts: active ? 1 : 0,
    habitableCapacity: Math.round(architecture.habitableCapacity),
    broodCapacity: architectureBroodCapacity(architecture),
    storageCapacity: Math.round(architecture.storageCapacity),
    storagePressure: Number((architecture.storagePressure || 0).toFixed(2)),
    usefulStoragePressure: Number((architecture.usefulStoragePressure || 0).toFixed(2)),
    reserveRatio: Number((architecture.reserveRatio || 0).toFixed(2)),
    occupancy: Number(architecture.occupancy.toFixed(2)),
    growthDrive: Number(architecture.growthDrive.toFixed(2)),
    deepestDepth: Number(chamberDepth(architecture).toFixed(2)),
    totalExcavated: Number(architecture.totalExcavated.toFixed(1)),
    spoilDeposits: architecture.spoilDeposits,
    circulatingWorkers: architecture.circulatingWorkers.length,
    circulationWorkerIds: architecture.circulatingWorkers.slice(0, 18).map((worker) => workerDisplayId(worker)),
    circulationSeconds: Number(architecture.circulationSeconds.toFixed(1)),
    inspectionTrips: architecture.inspectionTrips,
    visitedChambers: architecture.visitedChamberIds.size,
    activeProject: active ? {
      id: active.id,
      chamberType: architectureNodeById(architecture, active.toNodeId)?.type || 'unknown',
      progress: Number(active.progress.toFixed(2)),
      workerIds: active.activeDiggers.map((worker) => workerDisplayId(worker)),
    } : null,
    chambers: architecture.nodes.filter((node) => node.renderChamber).map((node) => ({
      id: node.id,
      type: node.type,
      completed: node.completed,
      capacity: node.capacity,
      x: Number(node.position.x.toFixed(1)),
      y: Number(node.position.y.toFixed(1)),
      z: Number(node.position.z.toFixed(1)),
    })),
  };
}

function summarizeColony(colony, state) {
  const livingWorkers = colony.workers.filter((worker) => worker.alive !== false);
  const reproduction = colony.reproduction;
  return {
    id: colony.id,
    lineageId: colony.lineageId,
    name: colony.displayName,
    speciesProfile: colony.speciesProfile,
    status: colony.status,
    foundedBy: colony.foundedBy,
    ageYears: Number((colony.ageAtStartYears + Math.max(0, state.simTime - (colony.foundedAt || 0)) / ECOLOGICAL_YEAR_SECONDS).toFixed(2)),
    nest: { x: colony.nest.x, z: colony.nest.y },
    queen: { id: colony.queen.id, alive: colony.queen.alive, genome: colony.queen.genome },
    lifeHistory: colony.lifeHistory ? {
      stage: colony.lifeHistory.lifeStage,
      queenAgeYears: Number(colony.lifeHistory.queenAgeYears.toFixed(2)),
      queenLongevityYears: Number(colony.lifeHistory.queenLongevityYears.toFixed(2)),
      queenVitality: Number(colony.lifeHistory.queenVitality.toFixed(2)),
      reproductiveMaturityAgeYears: colony.lifeHistory.reproductiveMaturityAgeYears,
      queenDiedAt: colony.lifeHistory.queenDiedAt,
      queenDeathCause: colony.lifeHistory.queenDeathCause,
      territoryState: colony.lifeHistory.territoryState,
      vacancyId: colony.lifeHistory.vacancyId,
      replacedVacancyId: colony.lifeHistory.replacedVacancyId || null,
      replacementColonyId: colony.lifeHistory.replacementColonyId,
    } : null,
    workers: livingWorkers.length,
    capacity: colony.maxWorkers,
    demographics: summarizeDemographics(colony, state.demographicStateFor),
    brood: {
      total: colony.brood.length,
      eggs: colony.brood.filter((item) => item.stage === 'egg').length,
      larvae: colony.brood.filter((item) => item.stage === 'larva').length,
      pupae: colony.brood.filter((item) => item.stage === 'pupa').length,
      workers: colony.brood.filter((item) => item.destiny === 'worker').length,
      males: colony.brood.filter((item) => item.destiny === 'male').length,
      gynes: colony.brood.filter((item) => item.destiny === 'gyne').length,
    },
    reproduction: reproduction ? {
      storedSires: reproduction.spermBank.length,
      reproductiveBudget: Number(reproduction.reproductiveBudget.toFixed(2)),
      workerEggsLaid: reproduction.workerEggsLaid,
      sexualEggsLaid: reproduction.sexualEggsLaid,
      adultMales: reproduction.alates.filter((alate) => alate.destiny === 'male').length,
      adultGynes: reproduction.alates.filter((alate) => alate.destiny === 'gyne').length,
      malesLaunched: reproduction.malesLaunched,
      gynesLaunched: reproduction.gynesLaunched,
      matedGynes: reproduction.matedGynes,
      livingFoundresses: colony.queen?.foundingStage && colony.queen.alive ? 1
        : state.regionalMating.matedQueens.filter((queen) => queen.natalColonyId === colony.id && queen.alive).length,
    } : null,
    youngColony: colony.queen?.foundingStage ? {
      stage: colony.queen.foundingStage,
      queenHealth: Number((colony.queen.queenHealth || 0).toFixed(1)),
      chamberOpen: Number((colony.queen.entranceOpenProgress || 0).toFixed(2)),
      surfaceWorkers: colony.workers.filter((worker) => worker.alive && !worker.insideNest).length,
      foodDelivered: colony.queen.foodDelivered || 0,
      workerDeaths: colony.queen.workerDeaths || 0,
      broodDeaths: colony.queen.foundingBroodDeaths || 0,
      collapseCause: colony.queen.collapseCause || null,
    } : null,
    storedFood: Number(colony.storedFood.toFixed(1)),
    foodDelivered: colony.foodDelivered,
    entrance: colony.entrance ? {
      cachedItems: colony.entrance.cache.length,
      activation: Number(colony.entrance.activation.toFixed(2)),
      foodReturned: colony.entrance.foodReturned,
      contactEvents: colony.entrance.contactEvents,
      activeTransfers: colony.entrance.activeTransfers,
      storageTransfers: colony.entrance.storageTransfers,
    } : null,
    foragingNetwork: summarizeForagingNetwork(colony.foragingNetwork, state.sectorTarget),
    seedBank: summarizeSeedBank(colony.seedBank),
    architecture: summarizeArchitecture(colony.architecture, state),
    workersEclosed: colony.workersEclosed,
    deaths: colony.deaths,
    genetics: {
      livingAverage: state.averageGenome(livingWorkers),
      generations: livingWorkers.reduce((counts, worker) => {
        counts[`G${worker.generation}`] = (counts[`G${worker.generation}`] || 0) + 1;
        return counts;
      }, {}),
    },
  };
}

function summarizeSurfaceTraffic(livingColonies) {
  const workers = [];
  for (const colony of livingColonies()) {
    for (const worker of colony.workers) if (worker.alive !== false && !worker.insideNest) workers.push(worker);
  }
  const colonies = {};
  for (const colony of livingColonies()) {
    const surface = workers.filter((worker) => worker.colonyId === colony.id);
    let densestRadiusCount = 0;
    let nearestSum = 0;
    for (const worker of surface) {
      let local = 0;
      let nearest = Infinity;
      for (const other of workers) {
        if (worker === other) continue;
        const distance = Math.hypot(worker.x - other.x, worker.z - other.z);
        if (distance < 1.5) local++;
        nearest = Math.min(nearest, distance);
      }
      densestRadiusCount = Math.max(densestRadiusCount, local);
      if (Number.isFinite(nearest)) nearestSum += nearest;
    }
    colonies[colony.id] = {
      surfaceWorkers: surface.length,
      densestNeighborsWithin1_5m: densestRadiusCount,
      meanNearestNeighborDistance: Number((nearestSum / Math.max(1, surface.length)).toFixed(2)),
      meanDistanceFromNest: Number((surface.reduce((sum, worker) => sum
        + Math.hypot(worker.x - colony.nest.x, worker.z - colony.nest.y), 0) / Math.max(1, surface.length)).toFixed(2)),
    };
  }
  let crossColonyContactPairs = 0;
  for (let i = 0; i < workers.length; i++) for (let j = i + 1; j < workers.length; j++) {
    if (workers[i].colonyId !== workers[j].colonyId
      && Math.hypot(workers[i].x - workers[j].x, workers[i].z - workers[j].z) < 0.5) crossColonyContactPairs++;
  }
  return { colonies, crossColonyContactPairs };
}

function summarizeEcologicalEquilibrium(state) {
  const samples = state.ecologicalBalance.samples;
  const latest = samples.at(-1) || null;
  const comparison = [...samples].reverse().find((sample) => latest && latest.time - sample.time >= ECOLOGICAL_YEAR_SECONDS * 0.8)
    || samples[0] || null;
  const elapsed = latest && comparison ? latest.time - comparison.time : 0;
  const populationTrendPerYear = elapsed > 0
    ? (latest.totalWorkers - comparison.totalWorkers) * ECOLOGICAL_YEAR_SECONDS / elapsed : 0;
  const activeFood = state.foods.filter((food) => food.amount > 0);
  const activeWorkers = state.totalActiveWorkers();
  return {
    ecologicalYear: Number((state.simTime / ECOLOGICAL_YEAR_SECONDS).toFixed(2)),
    calendar: `${state.environment.season.name} · ${Math.round(state.environment.seasonProgress * 100)}%`,
    checkpointCount: samples.length,
    populationTrendPerYear: Number(populationTrendPerYear.toFixed(1)),
    trendAssessment: activeWorkers === 0 ? 'worker population collapsed'
      : elapsed < ECOLOGICAL_YEAR_SECONDS * 0.5 ? 'collecting baseline'
      : Math.abs(populationTrendPerYear) < Math.max(12, activeWorkers * 0.08) ? 'near dynamic equilibrium'
        : populationTrendPerYear > 0 ? 'expanding' : 'contracting',
    surfaceFoodUnits: Number(activeFood.reduce((sum, food) => sum + food.amount * food.nutrition, 0).toFixed(1)),
    activeFoodSources: activeFood.length,
    retainedFoodRecords: state.foods.length,
    depletedFoodRetired: state.ecologicalBalance.depletedFoodRetired,
    storageOverflow: Object.fromEntries(state.ecologicalBalance.storageOverflow),
    storedFoodMetabolized: Object.fromEntries([...state.ecologicalBalance.storedFoodMetabolized]
      .map(([colonyId, amount]) => [colonyId, Number(amount.toFixed(1))])),
    storedFoodSpoiled: Object.fromEntries([...state.ecologicalBalance.storedFoodSpoiled]
      .map(([colonyId, amount]) => [colonyId, Number(amount.toFixed(1))])),
    recentCheckpoints: samples.slice(-10),
  };
}

export function buildObservationReport(state) {
  const {
    adaptiveVisualState,
    ants,
    averageGenome,
    antNestRoute,
    brood,
    cameraRig,
    colonyBiology,
    colonyForWorker,
    colonyLabor,
    colonyOrder,
    colonySurvival,
    delivered,
    ecologicalBalance,
    entranceBiology,
    environment,
    excavatedSoil,
    followingSelected,
    foods,
    focusedColony,
    getColony,
    homeColonyRecord,
    homeGranaryVisual,
    homeQueenGenome,
    homeReproduction,
    livingColonies,
    NEST,
    obstacles,
    paused,
    plantSeedWindow,
    predator,
    queenEggsLaid,
    regionalLifeHistory,
    regionalLineageHistory,
    regionalMating,
    remains,
    rivalAnts,
    rivalBrood,
    rivalColony,
    rivalColonyRecord,
    rivalEntranceBiology,
    rivalGranaryVisual,
    rivalNestCurves,
    rivalQueenGenome,
    rivalReproduction,
    RIVAL_NEST,
    selectedAnt,
    simTime,
    spider,
    storedFood,
    timeScale,
    totalActiveWorkers,
    tunnelSegments,
    vegetationEcology,
    viewState,
    weather,
    workerDisplayId,
    workerMaturity,
    workersEclosed,
  } = state;
  const carrying = ants.filter((ant) => ant.carrying).length;
  const insideNest = ants.filter((ant) => ant.insideNest).length;
  const states = {};
  for (const ant of ants) states[ant.state] = (states[ant.state] || 0) + 1;
  const demographicSummary = (colony) => summarizeDemographics(colony, state.demographicStateFor);
  const registeredColonySummary = (colony) => summarizeColony(colony, state);
  const colonyArchitectureSummary = (architecture) => summarizeArchitecture(architecture, state);

  return {
    mode: paused ? 'paused' : 'observing',
    timeScale,
    coordinateSystem: 'origin at scene center; +x right/east, +z toward camera/south, negative y descends into the nest',
    timeSeconds: Number(simTime.toFixed(1)),
    ecologicalEquilibrium: summarizeEcologicalEquilibrium(state),
    adaptiveVisualDetail: {
      level: adaptiveVisualState.level,
      animationFrames: adaptiveVisualState.animationFrames,
      shadowStride: adaptiveVisualState.shadowStride,
      terrainNormalAlignment: adaptiveVisualState.useTerrainNormals,
      simulatedSurfaceWorkers: adaptiveVisualState.simulatedSurfaceWorkers,
      renderedSurfaceWorkers: adaptiveVisualState.renderedSurfaceWorkers,
      renderedByPopulation: {
        amber: adaptiveVisualState.renderedHomeWorkers,
        slate: adaptiveVisualState.renderedRivalWorkers,
        descendants: adaptiveVisualState.renderedDescendantWorkers,
      },
      undergroundRepresentatives: adaptiveVisualState.renderedUndergroundWorkers,
      undergroundRepresentativeLimit: adaptiveVisualState.undergroundRepresentativeLimit,
      simulationIndividualsRemovedByDetailSystem: 0,
    },
    weather: weather.rain > 0.6 ? 'rain' : weather.rain > 0.08 ? 'drizzle' : 'clear',
    rainIntensity: Number(weather.rain.toFixed(2)),
    postRainHumidity: Number(weather.postRainHumidity.toFixed(2)),
    population: {
      speciesProfile: SPECIES_PROFILE,
      focusedColonyId: cameraRig.focusedColonyId,
      activeColonies: livingColonies().length,
      totalWorkers: totalActiveWorkers(),
      globalTechnicalSafetyCeiling: TECHNICAL_GLOBAL_WORKER_LIMIT,
      surfaceTraffic: summarizeSurfaceTraffic(livingColonies),
      colonies: colonyOrder.map((id) => registeredColonySummary(getColony(id))),
    },
    colony: {
      ants: ants.length,
      surfaceVisible: ants.length - insideNest,
      insideNest,
      carrying,
      foodDelivered: delivered,
      storedFood: Number(storedFood.toFixed(1)),
      workersEclosed,
      deaths: colonySurvival.deaths,
      states,
      maturity: {
        callow: ants.filter((ant) => workerMaturity(ant.ageDays) === 'callow').length,
        young: ants.filter((ant) => workerMaturity(ant.ageDays) === 'young').length,
        mature: ants.filter((ant) => workerMaturity(ant.ageDays) === 'mature').length,
        veteran: ants.filter((ant) => workerMaturity(ant.ageDays) === 'veteran').length,
      },
      castes: {
        minor: ants.filter((ant) => ant.workerCaste === 'minor').length,
        media: ants.filter((ant) => ant.workerCaste === 'media').length,
        major: ants.filter((ant) => ant.workerCaste === 'major').length,
      },
      genetics: {
        queen: homeQueenGenome,
        livingAverage: averageGenome(ants),
        generations: ants.reduce((counts, ant) => {
          counts[`G${ant.generation}`] = (counts[`G${ant.generation}`] || 0) + 1;
          return counts;
        }, {}),
      },
    },
    biology: {
      queen: {
        state: homeColonyRecord.demographics?.queenState || 'assessing colony conditions',
        eggsLaid: queenEggsLaid,
        layingDrive: Number((homeColonyRecord.demographics?.layingDrive || 0).toFixed(2)),
      },
      brood: {
        total: brood.length,
        eggs: brood.filter((item) => item.stage === 'egg').length,
        larvae: brood.filter((item) => item.stage === 'larva').length,
        pupae: brood.filter((item) => item.stage === 'pupa').length,
        workers: brood.filter((item) => item.destiny === 'worker').length,
        males: brood.filter((item) => item.destiny === 'male').length,
        gynes: brood.filter((item) => item.destiny === 'gyne').length,
        starvedLarvae: colonyBiology.starvedLarvae,
        deaths: colonyBiology.broodDeaths,
        technicalBlockedEclosions: colonyBiology.technicalBlockedEclosions,
      },
      reproduction: {
        system: 'haplodiploid; males are unfertilized maternal offspring and females use stored sperm',
        storedSires: homeReproduction.spermBank.map((sire) => ({
          id: sire.id, lineageId: sire.lineageId, daughters: sire.daughters,
        })),
        reproductiveBudget: Number(homeReproduction.reproductiveBudget.toFixed(2)),
        workerEggsLaid: homeReproduction.workerEggsLaid,
        sexualEggsLaid: homeReproduction.sexualEggsLaid,
        investment: {
          males: Number(homeReproduction.maleInvestment.toFixed(1)),
          gynes: Number(homeReproduction.gyneInvestment.toFixed(1)),
        },
        adultAlates: {
          total: homeReproduction.alates.length,
          males: homeReproduction.alates.filter((alate) => alate.destiny === 'male').length,
          gynes: homeReproduction.alates.filter((alate) => alate.destiny === 'gyne').length,
        },
        flightOutcome: {
          malesLaunched: homeReproduction.malesLaunched,
          gynesLaunched: homeReproduction.gynesLaunched,
          matedGynes: homeReproduction.matedGynes,
        },
        alates: homeReproduction.alates.slice(0, 8).map((alate) => ({
          id: alate.id, sex: alate.sex, destiny: alate.destiny, state: alate.state,
          generation: alate.generation, parentage: alate.parentage,
        })),
      },
      nursery: { activeNurses: colonyBiology.activeNurses, requiredNurses: colonyBiology.requiredNurses },
      entranceVestibule: {
        cachedItems: entranceBiology.cache.length,
        capacity: entranceBiology.capacity,
        activation: Number(entranceBiology.activation.toFixed(2)),
        recentReturns: Number(entranceBiology.recentReturns.toFixed(2)),
        waitingForagers: entranceBiology.waitingForagers,
        activeTransfers: entranceBiology.activeTransfers,
        foodReturned: entranceBiology.foodReturned,
        contactEvents: entranceBiology.contactEvents,
        activatedDepartures: entranceBiology.activatedDepartures,
        withheldDepartures: entranceBiology.withheldDepartures,
        storageTransfers: entranceBiology.storageTransfers,
      },
    },
    nest: { x: NEST.x, z: NEST.y },
    foodSources: foods.filter((food) => food.amount > 0).map((food) => ({
      kind: food.kind,
      nutrition: food.nutrition,
      x: Number(food.x.toFixed(1)),
      z: Number(food.z.toFixed(1)),
      amount: Number(food.amount.toFixed(1)),
      ecologySource: food.ecologySource,
      sourcePlantId: food.sourcePlantId,
      seedSpecies: food.seedSpecies,
    })),
    environment: {
      season: environment.season.name,
      seasonProgress: Number(environment.seasonProgress.toFixed(2)),
      pressure: environment.pressure,
      vegetation: {
        livingPlants: vegetationEcology.plants.filter((plant) => plant.alive).length,
        seedlings: vegetationEcology.plants.filter((plant) => plant.alive && plant.maturity < 0.3).length,
        seedBearingPlants: vegetationEcology.plants.filter((plant) => plant.alive && (plantSeedWindow(plant) || foods.some((food) => food.amount > 0 && food.sourcePlantId === plant.id))).length,
        soilSeedCohorts: vegetationEcology.soilSeeds.length,
        dormantSeedUnits: vegetationEcology.soilSeeds.reduce((sum, cohort) => sum + cohort.count, 0),
        plantSeedPatches: foods.filter((food) => food.amount > 0 && food.ecologySource === 'plant seedfall').length,
        antDispersedPlants: vegetationEcology.plants.filter((plant) => plant.alive && plant.dispersedByColonyId).length,
        bySpecies: Object.keys(PLANT_PROFILES).reduce((counts, species) => {
          counts[species] = vegetationEcology.plants.filter((plant) => plant.alive && plant.species === species).length;
          return counts;
        }, {}),
        flows: Object.fromEntries(Object.entries(vegetationEcology.stats).map(([key, value]) => [key, Number(value.toFixed(1))])),
        plants: vegetationEcology.plants.filter((plant) => plant.alive).slice(0, 24).map((plant) => ({
          id: plant.id,
          species: plant.species,
          x: Number(plant.x.toFixed(1)),
          z: Number(plant.z.toFixed(1)),
          maturity: Number(plant.maturity.toFixed(2)),
          health: Number(plant.health.toFixed(2)),
          phenology: plant.phenology,
          seedsProduced: plant.seedsProduced,
          seedsHarvested: Number(plant.seedsHarvested.toFixed(1)),
          dispersedByColonyId: plant.dispersedByColonyId,
        })),
      },
      nuptialFlightSuitability: Number(regionalMating.lastSuitability.toFixed(2)),
      activePredator: predator.active || spider.active,
      predators: {
        huntingBeetle: { active: predator.active, kills: predator.kills, foodStolen: Number(predator.foodStolen.toFixed(1)), x: Number(predator.x.toFixed(1)), z: Number(predator.z.toFixed(1)) },
        webSpider: { active: spider.active, kills: spider.kills, homeKills: spider.homeKills, rivalKills: spider.rivalKills, webX: Number(spider.webX.toFixed(1)), webZ: Number(spider.webZ.toFixed(1)) },
      },
      disease: {
        infectedWorkers: ants.filter((ant) => ant.infection > 0).length,
        outbreaks: colonySurvival.outbreaks,
        recoveries: colonySurvival.recoveries,
      },
      mortality: {
        total: colonySurvival.deaths,
        predation: colonySurvival.predatorDeaths,
        disease: colonySurvival.diseaseDeaths,
        starvation: colonySurvival.starvationDeaths,
        rivalConflict: colonySurvival.conflictDeaths,
        other: colonySurvival.deaths - colonySurvival.predatorDeaths - colonySurvival.diseaseDeaths - colonySurvival.starvationDeaths - colonySurvival.conflictDeaths,
      },
    },
    rivalColony: {
      nest: { x: RIVAL_NEST.x, z: RIVAL_NEST.y },
      queen: {
        state: rivalColonyRecord.demographics?.queenState || 'assessing colony conditions',
        eggsLaid: rivalColony.eggsLaid,
        layingDrive: Number((rivalColonyRecord.demographics?.layingDrive || 0).toFixed(2)),
      },
      workers: rivalAnts.length,
      roles: {
        foragers: rivalAnts.filter((rival) => rival.role === 'forager').length,
        scouts: rivalAnts.filter((rival) => rival.role === 'scout').length,
        guards: rivalAnts.filter((rival) => rival.role === 'guard').length,
        transfers: rivalAnts.filter((rival) => rival.role === 'transfer').length,
        interiorReserve: rivalAnts.filter((rival) => rival.role === 'interior').length,
      },
      brood: {
        total: rivalBrood.length,
        eggs: rivalBrood.filter((item) => item.stage === 'egg').length,
        larvae: rivalBrood.filter((item) => item.stage === 'larva').length,
        pupae: rivalBrood.filter((item) => item.stage === 'pupa').length,
        workers: rivalBrood.filter((item) => item.destiny === 'worker').length,
        males: rivalBrood.filter((item) => item.destiny === 'male').length,
        gynes: rivalBrood.filter((item) => item.destiny === 'gyne').length,
        deaths: rivalColony.broodDeaths,
        technicalBlockedEclosions: rivalColony.technicalBlockedEclosions,
      },
      reproduction: {
        system: 'haplodiploid; males are unfertilized maternal offspring and females use stored sperm',
        storedSires: rivalReproduction.spermBank.map((sire) => ({
          id: sire.id, lineageId: sire.lineageId, daughters: sire.daughters,
        })),
        reproductiveBudget: Number(rivalReproduction.reproductiveBudget.toFixed(2)),
        workerEggsLaid: rivalReproduction.workerEggsLaid,
        sexualEggsLaid: rivalReproduction.sexualEggsLaid,
        investment: {
          males: Number(rivalReproduction.maleInvestment.toFixed(1)),
          gynes: Number(rivalReproduction.gyneInvestment.toFixed(1)),
        },
        adultAlates: {
          total: rivalReproduction.alates.length,
          males: rivalReproduction.alates.filter((alate) => alate.destiny === 'male').length,
          gynes: rivalReproduction.alates.filter((alate) => alate.destiny === 'gyne').length,
        },
        flightOutcome: {
          malesLaunched: rivalReproduction.malesLaunched,
          gynesLaunched: rivalReproduction.gynesLaunched,
          matedGynes: rivalReproduction.matedGynes,
        },
        alates: rivalReproduction.alates.slice(0, 8).map((alate) => ({
          id: alate.id, sex: alate.sex, destiny: alate.destiny, state: alate.state,
          generation: alate.generation, parentage: alate.parentage,
        })),
      },
      storedFood: Number(rivalColony.storedFood.toFixed(1)),
      foodDelivered: rivalColony.delivered,
      entranceVestibule: {
        cachedItems: rivalEntranceBiology.cache.length,
        capacity: rivalEntranceBiology.capacity,
        activation: Number(rivalEntranceBiology.activation.toFixed(2)),
        recentReturns: Number(rivalEntranceBiology.recentReturns.toFixed(2)),
        activeTransfers: rivalEntranceBiology.activeTransfers,
        foodReturned: rivalEntranceBiology.foodReturned,
        contactEvents: rivalEntranceBiology.contactEvents,
        storageTransfers: rivalEntranceBiology.storageTransfers,
      },
      workersEclosed: rivalColony.workersEclosed,
      deaths: rivalColony.deaths,
      mortality: {
        starvation: rivalColony.starvationDeaths,
        age: rivalColony.ageDeaths,
        crowding: rivalColony.crowdingDeaths,
      },
      genetics: {
        queen: rivalQueenGenome,
        livingAverage: averageGenome(rivalAnts),
        generations: rivalAnts.reduce((counts, rival) => {
          counts[`G${rival.generation}`] = (counts[`G${rival.generation}`] || 0) + 1;
          return counts;
        }, {}),
      },
      states: rivalAnts.reduce((counts, rival) => {
        counts[rival.state] = (counts[rival.state] || 0) + 1;
        return counts;
      }, {}),
    },
    territory: {
      borderMidpoint: { x: Number(((NEST.x + RIVAL_NEST.x) * 0.5).toFixed(1)), z: Number(((NEST.y + RIVAL_NEST.y) * 0.5).toFixed(1)) },
      activeClashes: rivalAnts.filter((rival) => rival.state === 'defending rival territory').length,
      clashes: rivalColony.clashes,
      ourCasualties: rivalColony.ourCasualties,
      rivalCasualties: rivalColony.rivalCasualties,
      contestedFoodSources: foods.filter((food) => food.amount > 0 && Math.abs(Math.hypot(food.x - NEST.x, food.z - NEST.y) - Math.hypot(food.x - RIVAL_NEST.x, food.z - RIVAL_NEST.y)) < 4).length,
      visibleRemains: remains.length,
      sanitizedRemains: colonySurvival.sanitized,
    },
    regionalMating: {
      flightWindow: {
        active: regionalMating.flightWindow.active,
        id: regionalMating.flightWindow.id,
        forced: regionalMating.flightWindow.forced,
        secondsRemaining: Number(Math.max(0, regionalMating.flightWindow.timer).toFixed(1)),
        openedAt: regionalMating.flightWindow.openedAt == null ? null : Number(regionalMating.flightWindow.openedAt.toFixed(1)),
        closedAt: regionalMating.flightWindow.closedAt == null ? null : Number(regionalMating.flightWindow.closedAt.toFixed(1)),
        suitability: Number(regionalMating.lastSuitability.toFixed(2)),
        swarmCenter: {
          x: Number(regionalMating.swarmCenter.x.toFixed(1)),
          y: Number(regionalMating.swarmCenter.y.toFixed(1)),
          z: Number(regionalMating.swarmCenter.z.toFixed(1)),
        },
      },
      airborne: {
        total: regionalMating.flyingAlates.length,
        males: regionalMating.flyingAlates.filter((alate) => alate.destiny === 'male').length,
        gynes: regionalMating.flyingAlates.filter((alate) => alate.destiny === 'gyne').length,
        individuals: regionalMating.flyingAlates.slice(0, 12).map((alate) => ({
          id: alate.id,
          originColonyId: alate.originColonyId,
          sex: alate.sex,
          state: alate.state,
          mates: alate.mates.length,
          targetMates: alate.targetMateCount,
          x: Number(alate.x.toFixed(1)),
          y: Number(alate.y.toFixed(1)),
          z: Number(alate.z.toFixed(1)),
        })),
      },
      outcomes: {
        windowsOpened: regionalMating.windowsOpened,
        matingEvents: regionalMating.matingEvents,
        externalMalesJoined: regionalMating.externalMalesJoined,
        malesDied: regionalMating.malesDied,
        malesDispersed: regionalMating.malesDispersed,
        gynesFailed: regionalMating.gynesFailed,
        foundationsRegistered: regionalMating.matedQueens.filter((queen) => queen.registeredColonyId).length,
        foundationsFailed: regionalMating.matedQueens.filter((queen) => queen.foundingStage === 'failed').length,
        youngColonies: regionalMating.matedQueens.filter((queen) => queen.foundingStage === 'young').length,
        establishedColonies: regionalMating.matedQueens.filter((queen) => queen.foundingStage === 'established').length,
        collapsedColonies: regionalMating.matedQueens.filter((queen) => queen.foundingStage === 'collapsed').length,
      },
      matedQueens: regionalMating.matedQueens.map((queen) => ({
        id: queen.id,
        lineageId: queen.lineageId,
        natalColonyId: queen.natalColonyId,
        natalQueenId: queen.natalQueenId,
        alive: queen.alive,
        dealated: queen.dealated,
        generation: queen.generation,
        parentage: queen.parentage,
        mateCount: queen.mateCount,
        sires: queen.spermBank.map((sire) => ({ id: sire.id, lineageId: sire.lineageId, originColonyId: sire.originColonyId })),
        sireLineages: queen.spermBank.map((sire) => sire.lineageId),
        x: Number(queen.x.toFixed(1)),
        z: Number(queen.z.toFixed(1)),
        founding: {
          stage: queen.foundingStage,
          siteQuality: Number((queen.siteQuality || 0).toFixed(2)),
          rejectedSites: queen.siteRejections || 0,
          chamberProgress: Number((queen.chamberProgress || 0).toFixed(2)),
          entranceOpenProgress: Number((queen.entranceOpenProgress || 0).toFixed(2)),
          reserves: Number((queen.reserves || 0).toFixed(1)),
          colonyFood: Number((queen.colonyFood || 0).toFixed(1)),
          foodDelivered: queen.foodDelivered || 0,
          queenHealth: Number((queen.queenHealth || 0).toFixed(1)),
          stress: Number((queen.foundingStress || 0).toFixed(3)),
          brood: {
            total: queen.foundingBrood?.length || 0,
            eggs: queen.foundingBrood?.filter((item) => item.stage === 'egg').length || 0,
            larvae: queen.foundingBrood?.filter((item) => item.stage === 'larva').length || 0,
            pupae: queen.foundingBrood?.filter((item) => item.stage === 'pupa').length || 0,
            deaths: queen.foundingBroodDeaths || 0,
          },
          nanitics: queen.nanitics?.length || 0,
          surfaceWorkers: queen.nanitics?.filter((worker) => worker.alive && !worker.insideNest).length || 0,
          workerDeaths: queen.workerDeaths || 0,
          registeredColonyId: queen.registeredColonyId,
          settledVacancyId: queen.settledVacancyId,
          demographics: queen.registeredColonyId ? demographicSummary(getColony(queen.registeredColonyId)) : null,
          failureCause: queen.failureCause || null,
          collapseCause: queen.collapseCause || null,
        },
        state: queen.state,
      })),
    },
    regionalLifeHistory: {
      ecologicalYear: Math.floor(simTime / ECOLOGICAL_YEAR_SECONDS),
      queenDeaths: regionalLifeHistory.queenDeaths,
      colonyExtinctions: regionalLifeHistory.colonyExtinctions,
      reproductiveMaturities: regionalLifeHistory.reproductiveMaturities,
      lineageReplacements: regionalLifeHistory.lineageReplacements,
      latestEvent: regionalLifeHistory.latestEvent,
      events: regionalLifeHistory.events.slice(-32),
      vacancies: regionalLifeHistory.vacancies.map((vacancy) => ({
        id: vacancy.id,
        formerColonyId: vacancy.formerColonyId,
        formerLineageId: vacancy.formerLineageId,
        state: vacancy.state,
        openedYear: Number(vacancy.openedYear.toFixed(2)),
        claimantQueenId: vacancy.claimantQueenId,
        replacementColonyId: vacancy.replacementColonyId,
        replacementLineageId: vacancy.replacementLineageId,
        x: Number(vacancy.x.toFixed(1)),
        z: Number(vacancy.z.toFixed(1)),
      })),
      censuses: regionalLifeHistory.censuses.slice(-12),
    },
    lineageHistory: {
      totalEvents: regionalLineageHistory.events.length,
      events: regionalLineageHistory.events.slice(-48),
    },
    userObstacles: obstacles.filter((o) => o.mesh).map((o) => ({ x: Number(o.x.toFixed(1)), z: Number(o.z.toFixed(1)), radius: Number(o.r.toFixed(1)) })),
    view: viewState.undergroundBlend > 0.5 ? 'underground nest scan' : 'surface colony',
    camera: { distance: Number(cameraRig.distance.toFixed(1)), pitch: Number(cameraRig.pitch.toFixed(2)), targetX: Number(cameraRig.target.x.toFixed(1)), targetY: Number(cameraRig.focusY.toFixed(1)), targetZ: Number(cameraRig.target.z.toFixed(1)) },
    selectedAnt: selectedAnt ? {
      id: workerDisplayId(selectedAnt),
      colonyId: colonyForWorker(selectedAnt)?.id || null,
      lineageId: colonyForWorker(selectedAnt)?.lineageId || null,
      tendency: selectedAnt.tendency || selectedAnt.role,
      assignment: selectedAnt.assignedRole || selectedAnt.role,
      maturity: workerMaturity(selectedAnt.ageDays),
      caste: selectedAnt.workerCaste,
      generation: selectedAnt.generation,
      parentage: selectedAnt.parentage,
      genome: Object.fromEntries(GENE_KEYS.map((key) => [key, Number(selectedAnt.genome[key].toFixed(3))])),
      task: selectedAnt.state,
      location: selectedAnt.insideNest
        ? selectedAnt.colony === 'incipient' ? 'claustral founding chamber'
          : selectedAnt.colonyId === RIVAL_COLONY_ID ? 'slate transfer gallery' : antNestRoute(selectedAnt)?.label
        : 'surface',
      energy: Math.round(selectedAnt.energy),
      health: Math.round(selectedAnt.health),
      infection: Number((selectedAnt.infection || 0).toFixed(2)),
      cargo: selectedAnt.transferCargo ? {
        kind: selectedAnt.transferCargo.kind,
        seedSpecies: selectedAnt.transferCargo.seedSpecies || null,
        sourcePlantId: selectedAnt.transferCargo.sourcePlantId || null,
      } : selectedAnt.sanitationCargo ? 'colony remains' : selectedAnt.soilCargo ? 'soil' : selectedAnt.carrying ? {
        kind: selectedAnt.carryingKind,
        seedSpecies: selectedAnt.carryingSeedSpecies || null,
        sourcePlantId: selectedAnt.carryingSourcePlantId || null,
      } : 'none',
      trips: selectedAnt.trips || 0,
      navigation: selectedAnt.navigation ? {
        sectorId: selectedAnt.navigation.sectorId,
        confidence: Number(selectedAnt.navigation.confidence.toFixed(2)),
        guidance: selectedAnt.navigation.guidance,
        learningWalk: Number(selectedAnt.navigation.learningWalk.toFixed(2)),
        successfulTrips: selectedAnt.navigation.successfulTrips,
        failedSearches: selectedAnt.navigation.failedSearches,
        emptySectorSeconds: Number(selectedAnt.navigation.emptySectorTime.toFixed(1)),
        sectorCommitSecondsRemaining: Number(Math.max(0, selectedAnt.navigation.sectorCommitUntil - simTime).toFixed(1)),
        localSearchTarget: selectedAnt.navigation.localTargetX == null ? null : {
          x: Number(selectedAnt.navigation.localTargetX.toFixed(1)),
          z: Number(selectedAnt.navigation.localTargetZ.toFixed(1)),
        },
        nestInspectionTrips: selectedAnt.nestExplorationTrips || 0,
        rememberedFood: selectedAnt.navigation.rememberedX == null ? null : {
          x: Number(selectedAnt.navigation.rememberedX.toFixed(1)),
          z: Number(selectedAnt.navigation.rememberedZ.toFixed(1)),
        },
      } : null,
      following: followingSelected,
    } : null,
    labor: {
      targetForagers: colonyLabor.targetForagers,
      assignedForagers: colonyLabor.assignedForagers,
      targetNurses: colonyLabor.targetNurses,
      assignedNurses: colonyLabor.assignedNurses,
      targetTransfers: colonyLabor.targetTransfers,
      assignedTransfers: colonyLabor.assignedTransfers,
      targetSanitizers: colonyLabor.targetSanitizers,
      assignedSanitizers: colonyLabor.assignedSanitizers,
      targetExcavators: colonyLabor.targetExcavators,
      assignedExcavators: colonyLabor.assignedExcavators,
      assignedInteriorReserve: colonyLabor.assignedInterior,
      activelyDigging: ants.filter((ant) => ant.nestMode === 'digging').length,
      haulingSoil: ants.filter((ant) => ant.soilCargo).length,
      spoilDeposits: excavatedSoil,
    },
    underground: {
      focus: focusedColony()?.displayName || 'unregistered colony',
      focusedColonyId: cameraRig.focusedColonyId,
      livingArchitecture: colonyArchitectureSummary(focusedColony()?.architecture),
      rivalArchitecture: { tunnels: rivalNestCurves.length, broodVisible: rivalBrood.length, alatesVisible: rivalReproduction.alates.length, queenVisible: rivalColonyRecord.queen.alive },
      visibleGranarySeeds: {
        amber: homeGranaryVisual.count,
        slate: rivalGranaryVisual.count,
      },
      completeTunnels: tunnelSegments.filter((segment) => segment.progress >= 0.995).length,
      activeDiggingFronts: tunnelSegments.filter((segment) => segment.available && segment.activeDiggers > 0).length,
      overallConstruction: Number((tunnelSegments.reduce((sum, segment) => sum + segment.progress, 0) / tunnelSegments.length).toFixed(2)),
      deepestDepth: 11.9,
      visibleWorkers: ants.filter((ant) => ant.insideNest).length,
      wingedAlates: homeReproduction.alates.length,
      rivalTransferWorkers: rivalAnts.filter((rival) => rival.insideNest && rival.transferCargo).length,
      projects: tunnelSegments.slice(4).map((segment) => ({
        name: segment.name,
        progress: Number(segment.progress.toFixed(3)),
        status: segment.progress >= 0.999 ? 'complete' : segment.available ? 'active' : 'waiting',
        diggers: segment.activeDiggers,
      })),
    },
    controls: 'click an ant to select/follow; Esc releases; WASD/arrow keys move; Q/E descend/ascend; drag orbit; B toggles above/below; N switches nest focus; [ and ] change time speed; 0 resets time; right-drag pan; wheel zoom; empty click adds food; shift-click stone; R rain; L ideal nuptial-flight window; P hunting beetle; O web spider; space pause; F fullscreen',
  };
}

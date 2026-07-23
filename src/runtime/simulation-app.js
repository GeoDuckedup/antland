import * as THREE from '../../vendor/three.module.js';
import { createProfiler } from '../diagnostics/profiler.js';
import {
  FIXTURE_PATHS,
  canonicalScenarioQuery,
  compareDeterministicFixtures,
  compareWithSavedFixture,
  createDeterministicFixture,
} from '../diagnostics/fixtures.js';
import {
  ANT_CELL_SIZE,
  ANT_GRID_ROWS,
  ARCHITECTURE_TYPES,
  BROOD_STAGE_SECONDS,
  COLONY_REPRODUCTIVE_MATURITY_YEARS,
  CONSTRUCTION_DEPENDENCIES,
  ECOLOGICAL_YEAR_SECONDS,
  FIXED_DT,
  FOOD_NUTRITION,
  FORAGING_SECTOR_COUNT,
  FOUNDING_BROOD_SECONDS,
  HALF_D,
  HALF_W,
  HOME_COLONY_ID,
  HOME_QUEEN_GENOME as homeQueenGenome,
  MAX_SEED_PLANTS,
  NEST_POSITION,
  ORPHAN_TERRITORY_RELEASE_YEARS,
  PHER_H,
  PHER_W,
  PLANT_PROFILES,
  QUEEN_SENESCENCE_YEARS,
  RIVAL_COLONY_ID,
  RIVAL_NEST_POSITION,
  RIVAL_QUEEN_GENOME as rivalQueenGenome,
  SEASONS,
  SEASON_SECONDS,
  SIMULATION_SEED,
  SIM_DAYS_PER_SECOND,
  SIM_SPEEDS,
  SPECIES_PROFILE,
  TECHNICAL_BROOD_LIMIT,
  TECHNICAL_DESCENDANT_WORKER_LIMIT,
  TECHNICAL_GLOBAL_WORKER_LIMIT,
  TECHNICAL_HOME_WORKER_LIMIT,
  TECHNICAL_RIVAL_WORKER_LIMIT,
  UNDERGROUND_WORKER_RENDER_LIMIT,
  VACANCY_REPLACEMENT_RADIUS,
  WORKER_SENESCENCE_DAYS,
  WORKER_SENESCENCE_RATE,
  WORLD_D,
  WORLD_W,
} from '../config/simulation.js';
import { createDeterministicRandom } from '../simulation/random.js';
import { createIntervalScheduler, drainFixedStepBacklog } from '../simulation/scheduler.js';
import { createSpatialHash } from '../simulation/spatial-hash.js';
import { createWorkerCensus } from '../simulation/worker-census.js';
import {
  averageGenome,
  broodStageDuration,
  buildInitialColonyLifeHistory,
  calculateColonyAgeYears,
  calculateDemographicState,
  createLifecyclePolicy,
  hasTechnicalWorkerCapacity,
  isColonyReproductivelyMature,
  nextAlateState,
  queenVitalityAtAge,
  reproductiveCost,
  workerMaturity,
} from '../simulation/lifecycle.js';
import {
  architectureBroodCapacity,
  architectureWorkerCapacity,
  calculateArchitecturePressure,
  calculateFoundingSiteQuality,
  calculateNuptialFlightSuitability,
  calculatePlantSeasonStep,
  calculateSeedCohortStep,
  calculateStoredFoodAcceptance,
  calculateStoredFoodConsumption,
  chooseArchitectureChamberType,
  flightLightLevel as calculateFlightLightLevel,
  foodStorageCapacity,
  plantSeedWindow as isPlantSeedWindow,
  seedBankCapacity,
} from '../simulation/ecology.js';
import { buildObservationReport } from '../observation/report.js';
import { createSimulationUI } from '../ui/presentation.js';
import { createSimulationInput } from '../input/controls.js';
import { createRendererRuntime } from '../presentation/renderer.js';
import { createWorldAssets, createWingTexture } from '../presentation/assets.js';
import { createAntPresentation } from '../presentation/ants.js';
import { createSelectionPresentation } from '../presentation/selection.js';
import { createNestPresenter } from '../presentation/nests.js';
import {
  addNestEdge,
  addNestNode,
  createNestGraph,
  markNestGraphChanged,
  nestEdges,
  nestNodes,
  updateNestEdgeProgress,
} from '../simulation/nest-graph.js';
import {
  clearWorkerFoodCargo,
  createWorkerLookup,
  createWorkerRuntime,
  ensureCanonicalWorkerRecord,
  loadWorkerFoodCargo,
  workerRuntimeUid,
} from '../simulation/workers.js';

export function startAntlandSimulation() {
// ---------- constants and deterministic helpers ----------
const urlParams = new URLSearchParams(window.location.search);
const debugEnabled = urlParams.get('debug') === '1';
const requestedFixtureId = urlParams.get('fixture');
const fixtureExportEnabled = urlParams.get('fixtureExport') === '1';
const profiler = createProfiler({ enabled: debugEnabled });
const simulationUI = createSimulationUI({ debugEnabled });
const { canvas, debugOverlay } = simulationUI;
const initialViewport = simulationUI.readViewport();
const NEST = new THREE.Vector2(NEST_POSITION.x, NEST_POSITION.z);
const RIVAL_NEST = new THREE.Vector2(RIVAL_NEST_POSITION.x, RIVAL_NEST_POSITION.z);
let selectedAnt = null;
let followingSelected = false;

// Phase 7A foundation: every present and future nest is registered through the
// same population interface. Legacy colony-specific mechanics are exposed by
// getters while later subphases migrate them behind the shared record.
const colonyRegistry = new Map();
const colonyOrder = [];
const workerLookup = createWorkerLookup({ displayIdFor: (worker) => workerDisplayId(worker) });
const workerCensus = createWorkerCensus();
const surfaceWorkersNeedingRefresh = new Set();

function registerColony(record) {
  if (!record?.id || colonyRegistry.has(record.id)) throw new Error(`Invalid or duplicate colony id: ${record?.id}`);
  colonyRegistry.set(record.id, record);
  colonyOrder.push(record.id);
  workerCensus.registerColony(record);
  return record;
}

function getColony(colonyId) {
  return colonyRegistry.get(colonyId) || null;
}

function colonyForWorker(worker) {
  return getColony(worker?.colonyId || (worker?.colony === 'rival' ? RIVAL_COLONY_ID : HOME_COLONY_ID));
}

function livingColonies() {
  return colonyOrder.map((id) => getColony(id)).filter((colony) => colony && colony.status !== 'extinct');
}

function colonyAgeYears(colony) {
  return calculateColonyAgeYears(colony, simTime, ECOLOGICAL_YEAR_SECONDS);
}

function territorialColonies() {
  return livingColonies().filter((colony) => {
    const territoryState = colony.lifeHistory?.territoryState;
    return territoryState !== 'vacant' && territoryState !== 'claimed' && territoryState !== 'recolonized';
  });
}

function colonyIsReproductivelyMature(colony) {
  return isColonyReproductivelyMature(colony, colonyAgeYears(colony));
}

function totalActiveWorkers() {
  return workerCensus.totalLiving;
}

function hasTechnicalWorkerRoom(colonyId, currentWorkers) {
  const registered = workerCensus.hasColony(colonyId);
  const colonyWorkers = registered ? workerCensus.colonyCount(colonyId) : currentWorkers;
  const regionalWorkers = workerCensus.totalLiving + (registered ? 0 : currentWorkers);
  return hasTechnicalWorkerCapacity(colonyId, colonyWorkers, regionalWorkers);
}

function workerDisplayId(worker) {
  const colony = colonyForWorker(worker);
  return `${colony?.workerPrefix || 'W'}${String(worker?.id ?? 0).padStart(3, '0')}`;
}

function indexWorker(worker, colony = colonyForWorker(worker)) {
  const indexed = workerLookup.index(worker, colony);
  if (indexed) workerCensus.registerWorker(worker, colony);
  return indexed;
}

function removeWorkerIndex(worker, colony = colonyForWorker(worker)) {
  return workerLookup.remove(worker, colony);
}

function rebuildWorkerIndex() {
  workerLookup.clear();
  for (const colony of colonyRegistry.values()) {
    for (const worker of colony.workers) indexWorker(worker, colony);
  }
}

const { random, rand } = createDeterministicRandom(SIMULATION_SEED);
const {
  mutateGenome,
  createQueenReproduction,
  createOffspringInheritance,
  chooseSexualDestiny,
} = createLifecyclePolicy({ rand });
const clamp = THREE.MathUtils.clamp;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function groundHeight(x, z) {
  const ripple = Math.sin(x * 0.48) * 0.11 + Math.cos(z * 0.57) * 0.09 + Math.sin((x + z) * 0.91) * 0.045;
  const nestX = x - NEST.x;
  const nestZ = z - NEST.y;
  const nestDist2 = nestX ** 2 + nestZ ** 2;
  const broadMound = Math.exp(-nestDist2 / 8.8) * 0.58;
  const asymmetricSoil = Math.exp(-(((nestX + 0.55) ** 2) / 5.4 + ((nestZ - 0.15) ** 2) / 3.5)) * 0.1;
  const craterLobeA = Math.exp(-(((nestX + 0.04) ** 2) / 0.07 + ((nestZ - 0.02) ** 2) / 0.04)) * 0.15;
  const craterLobeB = Math.exp(-(((nestX - 0.15) ** 2) / 0.04 + ((nestZ + 0.08) ** 2) / 0.035)) * 0.07;
  const entranceCrater = craterLobeA + craterLobeB;
  const hollow = -Math.exp(-((x + 0.5) ** 2 + (z - 4.4) ** 2) / 18) * 0.16;
  return ripple + broadMound + asymmetricSoil - entranceCrater + hollow;
}

function groundNormal(x, z, out = new THREE.Vector3()) {
  const epsilon = 0.13;
  const slopeX = (groundHeight(x + epsilon, z) - groundHeight(x - epsilon, z)) / (epsilon * 2);
  const slopeZ = (groundHeight(x, z + epsilon) - groundHeight(x, z - epsilon)) / (epsilon * 2);
  return out.set(-slopeX, 1, -slopeZ).normalize();
}

function alignToGround(object, x, z, rotation = 0, lift = 0.065) {
  const normal = groundNormal(x, z);
  const tilt = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, normal);
  const spin = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, rotation);
  object.position.set(x, groundHeight(x, z) + lift, z);
  object.quaternion.copy(tilt).multiply(spin);
}

// ---------- renderer, scene and camera ----------
const presentation = createRendererRuntime({ canvas, viewport: initialViewport });
const {
  renderer,
  scene,
  surfaceGroup,
  undergroundGroup,
  viewState,
  camera,
  cameraRig,
} = presentation;

// ---------- procedural soil and terrain ----------
const {
  terrain,
  antMaterials,
  propMaterials,
  makeProp,
} = createWorldAssets({
  renderer,
  surfaceGroup,
  groundHeight,
  alignToGround,
  clamp,
});

// ---------- sculptural environment ----------
const entranceShape = new THREE.Shape();
for (let i = 0; i < 15; i++) {
  const angle = (i / 15) * Math.PI * 2;
  const radius = 0.78 + Math.sin(i * 2.37) * 0.15 + Math.sin(i * 0.81 + 0.4) * 0.08;
  const px = Math.cos(angle) * 0.28 * radius;
  const py = Math.sin(angle) * 0.17 * radius;
  if (i === 0) entranceShape.moveTo(px, py);
  else entranceShape.lineTo(px, py);
}
entranceShape.closePath();
const entranceGeometry = new THREE.ShapeGeometry(entranceShape);
entranceGeometry.rotateX(-Math.PI / 2);
entranceGeometry.computeVertexNormals();
const darkEarth = new THREE.MeshStandardMaterial({ color: 0x17140f, roughness: 1, side: THREE.DoubleSide });
const entrance = new THREE.Mesh(entranceGeometry, darkEarth);
alignToGround(entrance, NEST.x, NEST.y, -0.08, 0.014);
surfaceGroup.add(entrance);

const rivalEntrance = new THREE.Mesh(entranceGeometry.clone(), darkEarth.clone());
rivalEntrance.material.color.setHex(0x221a18);
rivalEntrance.scale.set(1.08, 1, 1.08);
alignToGround(rivalEntrance, RIVAL_NEST.x, RIVAL_NEST.y, 0.32, 0.018);
surfaceGroup.add(rivalEntrance);

const rivalRim = new THREE.Group();
for (let i = 0; i < 22; i++) {
  const angle = (i / 22) * Math.PI * 2 + Math.sin(i * 2.1) * 0.16;
  const radius = rand(0.38, 0.88);
  const clod = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16, 0), new THREE.MeshStandardMaterial({ color: i % 3 === 0 ? 0x59413d : 0x6c5142, roughness: 1, flatShading: true }));
  const x = RIVAL_NEST.x + Math.cos(angle) * radius;
  const z = RIVAL_NEST.y + Math.sin(angle) * radius * 0.78;
  clod.position.set(x, groundHeight(x, z) + rand(0.035, 0.1), z);
  clod.scale.set(rand(0.45, 1.1), rand(0.38, 0.78), rand(0.5, 1.05));
  clod.rotation.set(rand(0, 2), rand(0, Math.PI), rand(0, 2));
  rivalRim.add(clod);
}
surfaceGroup.add(rivalRim);

const rimClodGeometry = new THREE.DodecahedronGeometry(0.16, 0);
const rimClodMaterial = new THREE.MeshStandardMaterial({ color: 0x65452c, roughness: 1, flatShading: true });
const rimClods = new THREE.InstancedMesh(rimClodGeometry, rimClodMaterial, 28);
rimClods.castShadow = false;
rimClods.receiveShadow = true;
const rimMatrix = new THREE.Matrix4();
const rimQuaternion = new THREE.Quaternion();
const rimScale = new THREE.Vector3();
for (let i = 0; i < 28; i++) {
  const angle = i < 10 ? rand(-0.45, 2.35) : i < 19 ? rand(3.05, 5.2) : rand(0, Math.PI * 2);
  const radius = i < 19 ? rand(0.32, 0.68) : rand(0.72, 1.28);
  const x = NEST.x + Math.cos(angle) * radius * 1.12;
  const z = NEST.y + Math.sin(angle) * radius * 0.88;
  const size = i < 19 ? rand(0.55, 1.22) : rand(0.28, 0.7);
  rimQuaternion.setFromEuler(new THREE.Euler(rand(0, Math.PI), rand(0, Math.PI), rand(0, Math.PI)));
  rimScale.set(size * rand(0.72, 1.22), size * rand(0.45, 0.85), size * rand(0.7, 1.16));
  rimMatrix.compose(
    new THREE.Vector3(x, groundHeight(x, z) + 0.075 * size, z),
    rimQuaternion,
    rimScale,
  );
  rimClods.setMatrixAt(i, rimMatrix);
  rimClods.setColorAt(i, new THREE.Color().setHSL(rand(0.065, 0.095), rand(0.3, 0.46), rand(0.22, 0.34)));
}
rimClods.instanceMatrix.needsUpdate = true;
rimClods.instanceColor.needsUpdate = true;
surfaceGroup.add(rimClods);

const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x7d725b, roughness: 0.94, flatShading: true });
const rockGeometry = new THREE.DodecahedronGeometry(0.52, 0);
const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, 38);
rocks.castShadow = rocks.receiveShadow = true;
const matrix = new THREE.Matrix4();
const quat = new THREE.Quaternion();
const scale = new THREE.Vector3();
for (let i = 0; i < 38; i++) {
  let x, z;
  do { x = rand(-HALF_W + 1, HALF_W - 1); z = rand(-HALF_D + 1, HALF_D - 1); }
  while (new THREE.Vector2(x, z).distanceTo(NEST) < 2.2);
  quat.setFromEuler(new THREE.Euler(rand(0, Math.PI), rand(0, Math.PI), rand(0, Math.PI)));
  const s = rand(0.18, 0.78);
  scale.set(s * rand(0.8, 1.35), s * rand(0.55, 0.95), s);
  matrix.compose(new THREE.Vector3(x, groundHeight(x, z) + scale.y * 0.28, z), quat, scale);
  rocks.setMatrixAt(i, matrix);
  rocks.setColorAt(i, new THREE.Color().setHSL(rand(0.08, 0.13), rand(0.11, 0.24), rand(0.34, 0.52)));
}
rocks.instanceMatrix.needsUpdate = true;
rocks.instanceColor.needsUpdate = true;
surfaceGroup.add(rocks);

const grassGeometry = new THREE.ConeGeometry(0.055, 1, 3);
grassGeometry.translate(0, 0.5, 0);
const grassMaterial = new THREE.MeshStandardMaterial({ color: 0x667640, roughness: 0.9, side: THREE.DoubleSide });
const grasses = new THREE.InstancedMesh(grassGeometry, grassMaterial, 165);
grasses.castShadow = true;
for (let i = 0; i < 165; i++) {
  let x, z;
  const edgeBias = random() < 0.64;
  if (edgeBias) {
    const angle = rand(0, Math.PI * 2);
    x = Math.cos(angle) * rand(10.2, 16.2);
    z = Math.sin(angle) * rand(8.5, 12.2);
  } else {
    x = rand(-HALF_W + 1, HALF_W - 1);
    z = rand(-HALF_D + 1, HALF_D - 1);
  }
  const h = rand(0.45, 1.45);
  quat.setFromEuler(new THREE.Euler(rand(-0.13, 0.13), rand(0, Math.PI * 2), rand(-0.14, 0.14)));
  scale.set(rand(0.7, 1.3), h, rand(0.7, 1.3));
  matrix.compose(new THREE.Vector3(x, groundHeight(x, z), z), quat, scale);
  grasses.setMatrixAt(i, matrix);
  grasses.setColorAt(i, new THREE.Color().setHSL(rand(0.20, 0.29), rand(0.33, 0.58), rand(0.25, 0.42)));
}
grasses.instanceMatrix.needsUpdate = true;
grasses.instanceColor.needsUpdate = true;
surfaceGroup.add(grasses);

function cylinderBetween(a, b, radius, material) {
  const direction = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius, direction.length(), 8), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = mesh.receiveShadow = true;
  surfaceGroup.add(mesh);
  return mesh;
}

const twigMat = new THREE.MeshStandardMaterial({ color: 0x5b3722, roughness: 0.96 });
const twigA = new THREE.Vector3(3.5, groundHeight(3.5, -1.8) + 0.2, -1.8);
const twigB = new THREE.Vector3(9.2, groundHeight(9.2, 0.4) + 0.31, 0.4);
cylinderBetween(twigA, twigB, 0.15, twigMat);
cylinderBetween(new THREE.Vector3(6.5, groundHeight(6.5, -0.65) + 0.27, -0.65), new THREE.Vector3(7.8, groundHeight(7.8, -2.35) + 0.22, -2.35), 0.095, twigMat);

for (let i = 0; i < 13; i++) {
  const x = rand(-HALF_W + 1.5, HALF_W - 1.5);
  const z = rand(-HALF_D + 1.5, HALF_D - 1.5);
  makeProp('leaf', x, z, rand(1.05, 1.75), rand(0, Math.PI * 2));
}
for (let i = 0; i < 12; i++) {
  const x = rand(-HALF_W + 1.5, HALF_W - 1.5);
  const z = rand(-HALF_D + 1.5, HALF_D - 1.5);
  const moss = makeProp('moss', x, z, rand(0.85, 1.45), rand(0, Math.PI * 2));
  moss.position.y += 0.025;
}

// ---------- pheromone field and food ----------
const colonyPheromoneFields = new Map();

function createColonyPheromoneField(colonyId, lateralSpread = 0.18) {
  const field = {
    colonyId,
    values: new Float32Array(PHER_W * PHER_H),
    next: new Float32Array(PHER_W * PHER_H),
    lateralSpread,
  };
  colonyPheromoneFields.set(colonyId, field);
  return field;
}

const homePheromoneField = createColonyPheromoneField(HOME_COLONY_ID, 0.18);
const rivalPheromoneField = createColonyPheromoneField(RIVAL_COLONY_ID, 0.16);

const colonyForagingNetworks = new Map();

function createForagingNetwork(colonyId, nest, color) {
  const network = {
    colonyId,
    nest,
    color,
    sectors: Array.from({ length: FORAGING_SECTOR_COUNT }, (_, id) => ({
      id,
      angle: (id / FORAGING_SECTOR_COUNT) * Math.PI * 2,
      confidence: 0.04,
      socialPulse: 0,
      successes: 0,
      failures: 0,
      discoveries: 0,
      activeForagers: 0,
      pendingRecruits: 0,
      availableFood: 0,
      resourceSites: 0,
      recruitmentCapacity: 3,
      congestion: 0,
      stale: false,
      centroidX: nest.x,
      centroidZ: nest.y,
      lastDiscoveryAt: null,
      lastSuccessAt: null,
      trunkStrength: 0,
    })),
    routeSwitches: 0,
    learningWalksCompleted: 0,
    memoryGuidedSteps: 0,
    socialGuidedSteps: 0,
    localSearchSteps: 0,
    exploratorySteps: 0,
    congestionReroutes: 0,
    staleMemoriesExpired: 0,
    peakSectorShare: 0,
    currentPeakSectorShare: 0,
  };
  colonyForagingNetworks.set(colonyId, network);
  return network;
}

const homeForagingNetwork = createForagingNetwork(HOME_COLONY_ID, NEST, 0xe2ad6a);
const rivalForagingNetwork = createForagingNetwork(RIVAL_COLONY_ID, RIVAL_NEST, 0x79a8bd);

function sectorForPoint(network, x, z) {
  const angle = (Math.atan2(z - network.nest.y, x - network.nest.x) + Math.PI * 2) % (Math.PI * 2);
  return Math.round(angle / (Math.PI * 2) * FORAGING_SECTOR_COUNT) % FORAGING_SECTOR_COUNT;
}

function ensureWorkerNavigation(worker, experienced = false) {
  worker.navigation ||= {
    sectorId: null,
    confidence: experienced ? rand(0.22, 0.58) : 0,
    rememberedX: null,
    rememberedZ: null,
    successfulTrips: 0,
    failedSearches: 0,
    searchTime: 0,
    emptySectorTime: 0,
    learningWalk: experienced ? 1 : 0,
    guidance: experienced ? 'mixed' : 'learning walk',
    rememberedFood: null,
    memoryUpdatedAt: null,
    memoryLifetime: rand(11, 19),
    sectorCommitUntil: 0,
    localTargetX: null,
    localTargetZ: null,
    targetRefreshAt: 0,
    waypointIndex: Math.floor(rand(0, 24)),
  };
  worker.navigation.emptySectorTime ??= 0;
  worker.navigation.rememberedFood ??= null;
  worker.navigation.memoryUpdatedAt ??= null;
  worker.navigation.memoryLifetime ??= rand(11, 19);
  worker.navigation.sectorCommitUntil ??= 0;
  worker.navigation.localTargetX ??= null;
  worker.navigation.localTargetZ ??= null;
  worker.navigation.targetRefreshAt ??= 0;
  worker.navigation.waypointIndex ??= Math.floor(rand(0, 24));
  return worker.navigation;
}

function chooseForagingSector(worker, network, forceSwitch = false) {
  const navigation = ensureWorkerNavigation(worker);
  const current = navigation.sectorId == null ? null : network.sectors[navigation.sectorId];
  const currentCongested = current && current.congestion > 1.08;
  const currentStale = current && current.stale;
  if (!forceSwitch && current && simTime < navigation.sectorCommitUntil && !currentStale) return current;
  if (!forceSwitch && current && !currentCongested && !currentStale && random() > 0.035) {
    navigation.sectorCommitUntil = simTime + rand(2.5, 5.5);
    return current;
  }
  let best = null;
  let bestScore = -Infinity;
  const explorer = ((worker.id * 7 + network.colonyId.length * 3) % 13) < 2;
  for (const sector of network.sectors) {
    const anticipatedTraffic = sector.activeForagers + sector.pendingRecruits;
    const anticipatedCongestion = anticipatedTraffic / Math.max(1, sector.recruitmentCapacity);
    const privateFamiliarity = navigation.sectorId === sector.id
      ? navigation.confidence * 1.8 * clamp(1.35 - anticipatedCongestion, 0.08, 1) : 0;
    const resourceSignal = (Math.log1p(sector.availableFood) * 0.38 + sector.resourceSites * 0.11) * (explorer ? 0.15 : 1);
    const explorationBonus = sector.discoveries === 0 ? (explorer ? 2.25 : 0.2) : sector.stale ? (explorer ? 1.45 : 0.12) : 0;
    const socialSignal = sector.stale ? 0 : (sector.socialPulse * 1.2 + sector.trunkStrength * 0.62) * (explorer ? 0.15 : 1);
    const score = resourceSignal + socialSignal + sector.confidence * 0.55 + privateFamiliarity
      + explorationBonus - anticipatedCongestion * 1.72 - sector.failures * 0.025
      - (forceSwitch && current?.id === sector.id ? 1.8 : 0) + rand(-0.26, 0.26);
    if (score > bestScore) { bestScore = score; best = sector; }
  }
  if (current && best && current.id !== best.id) {
    network.routeSwitches++;
    if (currentCongested) network.congestionReroutes++;
  }
  navigation.sectorId = best?.id ?? 0;
  navigation.failedSearches = 0;
  navigation.searchTime = 0;
  navigation.emptySectorTime = 0;
  navigation.sectorCommitUntil = simTime + rand(5.5, 12.5);
  navigation.targetRefreshAt = 0;
  if (best) best.pendingRecruits++;
  return best || network.sectors[0];
}

function recordFoodDiscovery(worker, food) {
  const network = colonyForagingNetworks.get(worker.colonyId);
  if (!network) return;
  const navigation = ensureWorkerNavigation(worker);
  const sectorId = sectorForPoint(network, food.x, food.z);
  const sector = network.sectors[sectorId];
  navigation.sectorId = sectorId;
  navigation.rememberedX = food.x;
  navigation.rememberedZ = food.z;
  navigation.rememberedFood = food;
  navigation.memoryUpdatedAt = simTime;
  navigation.memoryLifetime = rand(11, 19);
  navigation.confidence = clamp(navigation.confidence + 0.18 * food.nutrition, 0, 1);
  navigation.searchTime = 0;
  navigation.emptySectorTime = 0;
  navigation.failedSearches = 0;
  navigation.sectorCommitUntil = simTime + rand(7, 14);
  sector.discoveries++;
  sector.lastDiscoveryAt = simTime;
  const weight = Math.min(8, sector.discoveries);
  sector.centroidX += (food.x - sector.centroidX) / weight;
  sector.centroidZ += (food.z - sector.centroidZ) / weight;
  sector.confidence = clamp(sector.confidence + 0.035 * food.nutrition, 0, 1);
}

function recordForagingDelivery(worker) {
  const network = colonyForagingNetworks.get(worker.colonyId);
  const navigation = ensureWorkerNavigation(worker);
  if (!network || navigation.sectorId == null) return;
  const sector = network.sectors[navigation.sectorId];
  navigation.successfulTrips++;
  navigation.confidence = clamp(navigation.confidence + 0.12, 0, 1);
  sector.successes++;
  sector.socialPulse = clamp(sector.socialPulse + 0.2 + (worker.carryingNutrition || 1) * 0.06, 0, 1.6);
  sector.confidence = clamp(sector.confidence + 0.055, 0, 1);
  sector.trunkStrength = clamp(sector.trunkStrength + 0.045, 0, 1);
  sector.lastSuccessAt = simTime;
}

function recordForagingFailure(worker) {
  const network = colonyForagingNetworks.get(worker.colonyId);
  const navigation = ensureWorkerNavigation(worker);
  if (!network || navigation.sectorId == null) return;
  const sector = network.sectors[navigation.sectorId];
  navigation.failedSearches++;
  navigation.emptySectorTime = 0;
  navigation.confidence = Math.max(0, navigation.confidence - 0.13);
  sector.failures++;
  sector.confidence = Math.max(0.02, sector.confidence - 0.035);
  sector.trunkStrength = Math.max(0, sector.trunkStrength - 0.025);
  if (navigation.failedSearches >= 2 || navigation.confidence < 0.12) chooseForagingSector(worker, network, true);
}

function sectorTarget(network, sector) {
  if (sector.discoveries > 0) return { x: sector.centroidX, z: sector.centroidZ };
  const radius = 7.5 + (sector.id % 3) * 1.4;
  return { x: network.nest.x + Math.cos(sector.angle) * radius, z: network.nest.y + Math.sin(sector.angle) * radius };
}

function expireStaleForagingMemory(worker, network) {
  const navigation = ensureWorkerNavigation(worker);
  if (navigation.rememberedX == null) return false;
  const rememberedSourceGone = navigation.rememberedFood && navigation.rememberedFood.amount <= 0;
  const memoryAge = simTime - (navigation.memoryUpdatedAt ?? simTime);
  if (!rememberedSourceGone || memoryAge < navigation.memoryLifetime) return false;
  navigation.rememberedX = null;
  navigation.rememberedZ = null;
  navigation.rememberedFood = null;
  navigation.memoryUpdatedAt = null;
  navigation.confidence *= 0.42;
  navigation.targetRefreshAt = 0;
  network.staleMemoriesExpired++;
  return true;
}

function liveFoodsInSector(network, sector) {
  return foods.filter((food) => food.amount > 0 && sectorForPoint(network, food.x, food.z) === sector.id);
}

function foragingSearchTarget(worker, network, sector, forceRefresh = false) {
  const navigation = ensureWorkerNavigation(worker);
  const reachedTarget = navigation.localTargetX != null
    && Math.hypot(worker.x - navigation.localTargetX, worker.z - navigation.localTargetZ) < 0.48;
  if (!forceRefresh && navigation.localTargetX != null && !reachedTarget && simTime < navigation.targetRefreshAt) {
    return { x: navigation.localTargetX, z: navigation.localTargetZ };
  }

  const sources = liveFoodsInSector(network, sector);
  navigation.waypointIndex++;
  if (sources.length > 0) {
    const offset = navigation.waypointIndex % sources.length;
    const ranked = [...sources].sort((a, b) => {
      const scoreA = Math.log1p(a.amount) * a.nutrition - Math.hypot(a.x - worker.x, a.z - worker.z) * 0.06;
      const scoreB = Math.log1p(b.amount) * b.nutrition - Math.hypot(b.x - worker.x, b.z - worker.z) * 0.06;
      return scoreB - scoreA;
    });
    const source = ranked[offset];
    const fanAngle = (worker.id * 2.399 + navigation.waypointIndex * 1.17) % (Math.PI * 2);
    const fanRadius = 0.12 + (navigation.waypointIndex % 4) * 0.09;
    navigation.localTargetX = clamp(source.x + Math.cos(fanAngle) * fanRadius, -HALF_W + 0.45, HALF_W - 0.45);
    navigation.localTargetZ = clamp(source.z + Math.sin(fanAngle) * fanRadius, -HALF_D + 0.45, HALF_D - 0.45);
    navigation.targetRefreshAt = simTime + rand(2.6, 5.8);
  } else {
    const center = sectorTarget(network, sector);
    const fanAngle = sector.angle + ((worker.id * 0.7549 + navigation.waypointIndex * 1.618) % 1.9) - 0.95;
    const fanRadius = 0.75 + (navigation.waypointIndex % 6) * 0.46 + rand(0, 0.38);
    navigation.localTargetX = clamp(center.x + Math.cos(fanAngle) * fanRadius, -HALF_W + 0.45, HALF_W - 0.45);
    navigation.localTargetZ = clamp(center.z + Math.sin(fanAngle) * fanRadius, -HALF_D + 0.45, HALF_D - 0.45);
    navigation.targetRefreshAt = simTime + rand(2.2, 4.8);
  }
  return { x: navigation.localTargetX, z: navigation.localTargetZ };
}

function advanceForagingSearch(worker, network, sector, dt) {
  const navigation = ensureWorkerNavigation(worker);
  navigation.searchTime += dt;
  network.localSearchSteps += dt;
  if (sector.availableFood <= 0) {
    navigation.emptySectorTime += dt;
    network.exploratorySteps += dt;
  } else navigation.emptySectorTime = Math.max(0, navigation.emptySectorTime - dt * 2.4);
  if (navigation.emptySectorTime > 8 || navigation.searchTime > 24) {
    recordForagingFailure(worker);
    navigation.searchTime = 0;
    navigation.targetRefreshAt = 0;
    return true;
  }
  return false;
}

const trunkRouteVisualPool = Array.from({ length: 24 }, () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  const material = new THREE.LineBasicMaterial({ color: 0xe0af72, transparent: true, opacity: 0, depthWrite: false });
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  line.visible = false;
  line.renderOrder = 4;
  surfaceGroup.add(line);
  return line;
});

const trunkMarkerGeometry = new THREE.CircleGeometry(0.11, 10);
const trunkRouteMarkerPool = Array.from({ length: 144 }, () => {
  const material = new THREE.MeshBasicMaterial({
    color: 0xe0af72,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  const marker = new THREE.Mesh(trunkMarkerGeometry, material);
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;
  marker.renderOrder = 3;
  surfaceGroup.add(marker);
  return marker;
});

function updateForagingNetworks(dt) {
  let routeVisual = 0;
  let routeMarker = 0;
  for (const network of colonyForagingNetworks.values()) {
    for (const sector of network.sectors) {
      sector.activeForagers = 0;
      sector.pendingRecruits = 0;
      sector.availableFood = 0;
      sector.resourceSites = 0;
    }
    const liveCentroids = new Map();
    for (const food of foods) {
      if (food.amount <= 0) continue;
      const sector = network.sectors[sectorForPoint(network, food.x, food.z)];
      sector.availableFood += food.amount;
      sector.resourceSites++;
      const entry = liveCentroids.get(sector.id) || { x: 0, z: 0, weight: 0 };
      const weight = Math.max(1, Math.sqrt(food.amount));
      entry.x += food.x * weight;
      entry.z += food.z * weight;
      entry.weight += weight;
      liveCentroids.set(sector.id, entry);
    }
    for (const sector of network.sectors) {
      const live = liveCentroids.get(sector.id);
      if (live) {
        sector.centroidX = live.x / live.weight;
        sector.centroidZ = live.z / live.weight;
      }
      const lastEvidence = Math.max(sector.lastDiscoveryAt ?? -Infinity, sector.lastSuccessAt ?? -Infinity);
      sector.stale = sector.discoveries > 0 && sector.availableFood <= 0 && simTime - lastEvidence > 14;
      const staleMultiplier = sector.stale ? 7.5 : 1;
      sector.socialPulse = Math.max(0, sector.socialPulse - dt * (0.025 + weather.rain * 0.03) * staleMultiplier);
      sector.trunkStrength = Math.max(0, sector.trunkStrength - dt * (0.0012 + weather.rain * 0.0025) * staleMultiplier);
      sector.confidence = Math.max(0.02, sector.confidence - dt * (sector.stale ? 0.009 : 0.00055));
      sector.recruitmentCapacity = Math.max(3, Math.ceil(2.5 + Math.sqrt(sector.availableFood) * 1.55
        + sector.resourceSites * 1.6 + sector.trunkStrength * 5));
    }
    const colony = getColony(network.colonyId);
    if (colony) for (const worker of colony.workers) {
      if (!worker.alive || worker.insideNest) continue;
      if (worker.carrying || worker.soilCargo || worker.sanitationCargo || worker.transferCargo) continue;
      if (colony.status === 'mature' && ['nurse', 'transfer', 'excavator', 'sanitizer'].includes(worker.assignedRole || worker.role)) continue;
      const navigation = ensureWorkerNavigation(worker, worker.generation === 0);
      if (navigation.sectorId != null) network.sectors[navigation.sectorId].activeForagers++;
    }
    const activeTotal = network.sectors.reduce((sum, sector) => sum + sector.activeForagers, 0);
    network.currentPeakSectorShare = 0;
    for (const sector of network.sectors) {
      sector.congestion = sector.activeForagers / Math.max(1, sector.recruitmentCapacity);
      if (activeTotal > 0) network.currentPeakSectorShare = Math.max(network.currentPeakSectorShare, sector.activeForagers / activeTotal);
    }
    if (activeTotal >= 8) network.peakSectorShare = Math.max(network.currentPeakSectorShare, network.peakSectorShare - dt * 0.006);
    const trunks = network.sectors.filter((sector) => sector.successes >= 2 && sector.trunkStrength > 0.08)
      .sort((a, b) => b.trunkStrength - a.trunkStrength).slice(0, 3);
    for (const sector of trunks) {
      if (routeVisual >= trunkRouteVisualPool.length) break;
      const line = trunkRouteVisualPool[routeVisual++];
      const target = sectorTarget(network, sector);
      const bendX = (network.nest.x + target.x) * 0.5 + Math.sin(sector.angle) * 0.45;
      const bendZ = (network.nest.y + target.z) * 0.5 - Math.cos(sector.angle) * 0.45;
      const positions = line.geometry.attributes.position.array;
      positions.set([
        network.nest.x, groundHeight(network.nest.x, network.nest.y) + 0.055, network.nest.y,
        bendX, groundHeight(bendX, bendZ) + 0.055, bendZ,
        target.x, groundHeight(target.x, target.z) + 0.055, target.z,
      ]);
      line.geometry.attributes.position.needsUpdate = true;
      line.material.color.setHex(network.color);
      line.material.opacity = 0.12 + sector.trunkStrength * 0.42;
      line.visible = true;
      for (let markerIndex = 1; markerIndex <= 6 && routeMarker < trunkRouteMarkerPool.length; markerIndex++) {
        const t = markerIndex / 7;
        const inverse = 1 - t;
        const x = inverse * inverse * network.nest.x + 2 * inverse * t * bendX + t * t * target.x;
        const z = inverse * inverse * network.nest.y + 2 * inverse * t * bendZ + t * t * target.z;
        const marker = trunkRouteMarkerPool[routeMarker++];
        marker.position.set(x, groundHeight(x, z) + 0.047, z);
        marker.material.color.setHex(network.color);
        marker.material.opacity = 0.07 + sector.trunkStrength * 0.17;
        marker.scale.setScalar(0.74 + sector.trunkStrength * 0.48);
        marker.visible = true;
      }
    }
  }
  for (let i = routeVisual; i < trunkRouteVisualPool.length; i++) trunkRouteVisualPool[i].visible = false;
  for (let i = routeMarker; i < trunkRouteMarkerPool.length; i++) trunkRouteMarkerPool[i].visible = false;
}

function pherIndex(x, z) {
  const gx = clamp(Math.floor(((x + HALF_W) / WORLD_W) * PHER_W), 0, PHER_W - 1);
  const gz = clamp(Math.floor(((z + HALF_D) / WORLD_D) * PHER_H), 0, PHER_H - 1);
  return gz * PHER_W + gx;
}

function colonyPherSample(colonyId, x, z) {
  const field = colonyPheromoneFields.get(colonyId);
  return field ? field.values[pherIndex(x, z)] : 0;
}

function colonyPherDeposit(colonyId, x, z, amount) {
  const field = colonyPheromoneFields.get(colonyId);
  if (!field) return;
  const index = pherIndex(x, z);
  field.values[index] = Math.min(1.8, field.values[index] + amount);
  const gx = index % PHER_W;
  const gz = Math.floor(index / PHER_W);
  const spread = amount * field.lateralSpread;
  if (gx > 0) field.values[index - 1] = Math.min(1.8, field.values[index - 1] + spread);
  if (gx < PHER_W - 1) field.values[index + 1] = Math.min(1.8, field.values[index + 1] + spread);
  if (gz > 0) field.values[index - PHER_W] = Math.min(1.8, field.values[index - PHER_W] + spread);
  if (gz < PHER_H - 1) field.values[index + PHER_W] = Math.min(1.8, field.values[index + PHER_W] + spread);
}

function pherSample(x, z) { return colonyPherSample(HOME_COLONY_ID, x, z); }
function pherDeposit(x, z, amount) { colonyPherDeposit(HOME_COLONY_ID, x, z, amount); }
function rivalPherSample(x, z) { return colonyPherSample(RIVAL_COLONY_ID, x, z); }
function rivalPherDeposit(x, z, amount) { colonyPherDeposit(RIVAL_COLONY_ID, x, z, amount); }

function updatePheromones(dt) {
  const profileStartedAt = profiler.begin('pheromones');
  const rainWash = 1 + weather.rain * 5.4;
  const decay = Math.max(0, 1 - dt * 0.053 * rainWash);
  for (const field of colonyPheromoneFields.values()) {
    field.next.fill(0);
    for (let y = 1; y < PHER_H - 1; y++) {
      for (let x = 1; x < PHER_W - 1; x++) {
        const i = y * PHER_W + x;
        const neighbors = (field.values[i - 1] + field.values[i + 1] + field.values[i - PHER_W] + field.values[i + PHER_W]) * 0.25;
        field.next[i] = (field.values[i] * 0.965 + neighbors * 0.035) * decay;
      }
    }
    field.values.set(field.next);
  }
  profiler.end('pheromones', profileStartedAt);
}

const foods = [];
const foodSpatialIndex = createSpatialHash({ cellSize: 1.5 });
const signals = [];
let simTime = 0;
let delivered = 0;
const demographicScenario = urlParams.get('demography');
const RESOURCE_ABUNDANCE_FACTOR = demographicScenario === 'abundance' ? 1.65 : 1;
let storedFood = demographicScenario === 'scarcity' ? 2.5 : demographicScenario === 'abundance' ? 260 : 118;
const environment = { seasonIndex: 0, seasonProgress: 0, season: SEASONS[0], pressure: 'stable' };
const ecologicalBalance = {
  nextCheckpointAt: 0,
  samples: [],
  depletedFoodRetired: 0,
  storageOverflow: new Map(),
  storedFoodSpoiled: new Map(),
  storedFoodMetabolized: new Map(),
  annualFlightWindows: new Map(),
};
const lowFrequencySchedule = createIntervalScheduler();
const requestedSeasonOffset = clamp(Number(urlParams.get('season')) || 0, 0, SEASONS.length - 1);
const predatorsDisabled = urlParams.get('predator') === '0';
const manualFlightOnly = urlParams.get('flight') === 'manual';
const forceFlightWhenReady = urlParams.get('flight') === 'force';
const foundingStressTest = urlParams.get('founding') === 'stress';
const youngColonyStressTest = urlParams.get('young') === 'collapse';
const clearWeatherTest = urlParams.get('weather') === 'clear';
const requestedSuccessionScenario = urlParams.get('succession');
const requestedNestFocus = urlParams.get('nest');
cameraRig.focusedColonyId = requestedNestFocus === 'rival' || requestedNestFocus === RIVAL_COLONY_ID
  ? RIVAL_COLONY_ID
  : HOME_COLONY_ID;

function addFood(x, z, kind = 'crumb', amount = 52, size = 1.5, ecology = {}) {
  x = clamp(x, -HALF_W + 0.8, HALF_W - 0.8);
  z = clamp(z, -HALF_D + 0.8, HALF_D - 0.8);
  const mesh = makeProp(kind, x, z, size, rand(0, Math.PI * 2));
  const food = {
    x, z, kind, amount, initial: amount, size, mesh,
    nutrition: FOOD_NUTRITION[kind] || 0.8,
    createdAt: simTime,
    depletedAt: null,
    ecologySource: ecology.source || 'incidental',
    sourcePlantId: ecology.sourcePlantId || null,
    seedSpecies: ecology.seedSpecies || null,
    sourceColonyId: ecology.sourceColonyId || null,
  };
  foods.push(food);
  foodSpatialIndex.add(food);
  createSignal(x, z, kind === 'beetle' ? 0xb77c4c : 0xf4d278);
  return food;
}

function removeFoodUnits(food, amount = 1, cause = 'ant harvest') {
  if (!food || food.amount <= 0) return 0;
  const removed = Math.min(food.amount, amount);
  food.amount -= removed;
  food.mesh.scale.setScalar(Math.max(0.24, Math.sqrt(food.amount / food.initial)));
  if (food.kind === 'seed' && food.sourcePlantId) {
    const plant = vegetationEcology.plants.find((item) => item.id === food.sourcePlantId);
    if (plant) {
      if (cause === 'ant harvest') plant.seedsHarvested += removed;
      else plant.seedsLost += removed;
    }
    if (cause === 'ant harvest') vegetationEcology.stats.seedsHarvested += removed;
    else vegetationEcology.stats.seedsLostToWildlife += removed;
  }
  if (food.amount <= 0) {
    food.amount = 0;
    food.depletedAt ??= simTime;
    food.mesh.visible = false;
    createSignal(food.x, food.z, cause === 'ant harvest' ? 0x9f9a58 : 0x88483d);
  }
  return removed;
}

if (demographicScenario !== 'scarcity') {
  addFood(7.4, -4.8, 'seed', Math.round(62 * RESOURCE_ABUNDANCE_FACTOR), 1.55);
  addFood(4.7, 5.4, 'crumb', Math.round(78 * RESOURCE_ABUNDANCE_FACTOR), 1.75);
  addFood(-1.2, 7.6, 'beetle', Math.round(115 * RESOURCE_ABUNDANCE_FACTOR), 2.05);
  addFood(11.7, 5.4, 'berry', Math.round(90 * RESOURCE_ABUNDANCE_FACTOR), 1.8);
}

// ---------- renewable seed landscape and colony granaries ----------
const vegetationEcology = {
  plants: [],
  soilSeeds: [],
  nextPlantId: 1,
  nextSoilSeedId: 1,
  stats: {
    seedsProduced: 0,
    seedsHarvested: 0,
    seedsReturnedToSoil: 0,
    seedsLostToWildlife: 0,
    antDispersedSeeds: 0,
    antDispersedGerminations: 0,
    germinations: 0,
    plantDeaths: 0,
  },
};
const colonySeedBanks = new Map();

function createColonySeedBank(colonyId, initialSeeds = 0) {
  const bank = {
    colonyId,
    capacity: seedBankCapacity(colonyId),
    current: initialSeeds,
    totalStored: initialSeeds,
    consumed: 0,
    dispersed: 0,
    sproutedInStore: 0,
    overflowDiscarded: 0,
    discardClock: rand(16, 30),
    wetSproutProgress: 0,
    species: {},
  };
  colonySeedBanks.set(colonyId, bank);
  return bank;
}

const homeSeedBank = createColonySeedBank(HOME_COLONY_ID, 24);
const rivalSeedBank = createColonySeedBank(RIVAL_COLONY_ID, 17);

function storeSeedCargo(colonyId, cargo) {
  if (cargo?.kind !== 'seed') return;
  const bank = colonySeedBanks.get(colonyId) || createColonySeedBank(colonyId);
  const species = cargo.seedSpecies || 'mixed wild seed';
  if (bank.current >= bank.capacity) {
    const colony = getColony(colonyId);
    bank.overflowDiscarded += 1;
    bank.dispersed += 1;
    vegetationEcology.stats.antDispersedSeeds += 1;
    if (colony) {
      const angle = rand(0, Math.PI * 2);
      const radius = rand(3.1, 5.7);
      addSoilSeedCohort(
        colony.nest.x + Math.cos(angle) * radius,
        colony.nest.y + Math.sin(angle) * radius * 0.82,
        species, 1,
        { viability: rand(0.56, 0.9), dispersedByColonyId: colonyId, progress: rand(0.14, 0.58) },
      );
    }
    return;
  }
  bank.current += 1;
  bank.totalStored += 1;
  bank.species[species] = (bank.species[species] || 0) + 1;
}

const plantStemGeometry = new THREE.CylinderGeometry(0.026, 0.04, 1, 5);
plantStemGeometry.translate(0, 0.5, 0);
const plantLeafGeometry = new THREE.ConeGeometry(0.075, 0.62, 4);
plantLeafGeometry.translate(0, 0.31, 0);
const plantSeedGeometry = new THREE.IcosahedronGeometry(0.075, 0);
const shrubGeometry = new THREE.IcosahedronGeometry(0.38, 1);

function makeSeedPlantVisual(species) {
  const profile = PLANT_PROFILES[species];
  const group = new THREE.Group();
  const foliageMaterial = new THREE.MeshStandardMaterial({ color: profile.foliage, roughness: 0.96, flatShading: true });
  const stemMaterial = new THREE.MeshStandardMaterial({ color: 0x655338, roughness: 1, flatShading: true });
  const seedMaterial = new THREE.MeshStandardMaterial({ color: profile.seed, roughness: 0.9, flatShading: true });
  const seedHeads = [];
  if (species === 'needlegrass') {
    for (let i = 0; i < 6; i++) {
      const angle = i * 2.399;
      const stem = new THREE.Mesh(plantStemGeometry, foliageMaterial);
      stem.position.set(Math.cos(angle) * 0.08, 0, Math.sin(angle) * 0.08);
      stem.rotation.z = rand(-0.13, 0.13);
      stem.rotation.x = rand(-0.1, 0.1);
      stem.scale.set(0.65, rand(0.72, 1.16), 0.65);
      const head = new THREE.Mesh(plantSeedGeometry, seedMaterial);
      head.position.set(stem.position.x, stem.scale.y + 0.04, stem.position.z);
      head.scale.set(0.65, 1.7, 0.65);
      group.add(stem, head);
      seedHeads.push(head);
    }
  } else if (species === 'desertForb') {
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI * 0.5 + 0.35;
      const stem = new THREE.Mesh(plantStemGeometry, stemMaterial);
      stem.position.set(Math.cos(angle) * 0.11, 0, Math.sin(angle) * 0.11);
      stem.scale.set(0.8, 0.62 + i * 0.06, 0.8);
      const leaf = new THREE.Mesh(plantLeafGeometry, foliageMaterial);
      leaf.position.set(Math.cos(angle) * 0.18, 0.05, Math.sin(angle) * 0.18);
      leaf.rotation.z = Math.cos(angle) * 0.72;
      leaf.rotation.x = Math.sin(angle) * 0.72;
      leaf.scale.set(1.15, 0.68, 1.15);
      const head = new THREE.Mesh(plantSeedGeometry, seedMaterial);
      head.position.set(stem.position.x, stem.scale.y + 0.08, stem.position.z);
      head.scale.set(1.25, 0.52, 1.25);
      group.add(stem, leaf, head);
      seedHeads.push(head);
    }
  } else {
    const trunk = new THREE.Mesh(plantStemGeometry, stemMaterial);
    trunk.scale.set(1.25, 0.7, 1.25);
    group.add(trunk);
    for (let i = 0; i < 5; i++) {
      const angle = i * 2.399;
      const foliage = new THREE.Mesh(shrubGeometry, foliageMaterial);
      foliage.position.set(Math.cos(angle) * 0.28, 0.34 + (i % 2) * 0.18, Math.sin(angle) * 0.24);
      foliage.scale.set(1, 0.62, 0.86);
      const head = new THREE.Mesh(plantSeedGeometry, seedMaterial);
      head.position.copy(foliage.position).add(new THREE.Vector3(Math.cos(angle) * 0.14, 0.17, Math.sin(angle) * 0.14));
      group.add(foliage, head);
      seedHeads.push(head);
    }
  }
  group.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });
  surfaceGroup.add(group);
  return { group, foliageMaterial, seedMaterial, seedHeads };
}

function plantSpotClear(x, z, minimum = 1.15) {
  if (Math.hypot(x - NEST.x, z - NEST.y) < 2.1 || Math.hypot(x - RIVAL_NEST.x, z - RIVAL_NEST.y) < 2.1) return false;
  return vegetationEcology.plants.every((plant) => !plant.alive || Math.hypot(x - plant.x, z - plant.z) >= minimum);
}

function createSeedPlant(x, z, species = 'needlegrass', maturity = 0.7, dispersedByColonyId = null) {
  if (vegetationEcology.plants.filter((plant) => plant.alive).length >= MAX_SEED_PLANTS || !plantSpotClear(x, z)) return null;
  const visual = makeSeedPlantVisual(species);
  const plant = {
    id: `plant-${String(vegetationEcology.nextPlantId++).padStart(3, '0')}`,
    species,
    x, z,
    maturity: clamp(maturity, 0.05, 1),
    health: rand(0.82, 1),
    alive: true,
    phenology: 'growing',
    cropFoodId: null,
    producedSeasonKey: -1,
    seedsProduced: 0,
    seedsHarvested: 0,
    seedsLost: 0,
    dispersedByColonyId,
    lastWinterCheck: -1,
    visual,
  };
  alignToGround(visual.group, x, z, rand(0, Math.PI * 2), 0.015);
  vegetationEcology.plants.push(plant);
  return plant;
}

function addSoilSeedCohort(x, z, species, count = 1, source = {}) {
  if (count <= 0 || vegetationEcology.soilSeeds.length >= 90) return null;
  const cohort = {
    id: `soil-seed-${vegetationEcology.nextSoilSeedId++}`,
    x: clamp(x, -HALF_W + 0.8, HALF_W - 0.8),
    z: clamp(z, -HALF_D + 0.8, HALF_D - 0.8),
    species: PLANT_PROFILES[species] ? species : 'needlegrass',
    count,
    viability: source.viability ?? rand(0.58, 0.96),
    germinationProgress: source.progress ?? rand(0, 0.58),
    depositedAt: simTime,
    sourcePlantId: source.sourcePlantId || null,
    dispersedByColonyId: source.dispersedByColonyId || null,
  };
  vegetationEcology.soilSeeds.push(cohort);
  vegetationEcology.stats.seedsReturnedToSoil += count;
  return cohort;
}

function plantSeedWindow(plant) {
  return isPlantSeedWindow(plant, environment.season.name, environment.seasonProgress);
}

function updateSeedPlantVisual(plant) {
  const { visual } = plant;
  const season = environment.season.name;
  const growing = season === 'spring' || season === 'summer';
  const speciesScale = plant.species === 'saltbush' ? 0.68 : plant.species === 'desertForb' ? 0.86 : 1;
  const scale = (0.34 + plant.maturity * 0.72) * speciesScale;
  visual.group.scale.set(scale, scale * (season === 'winter' ? 0.72 : 1), scale);
  visual.group.visible = plant.alive;
  const hasCrop = foods.some((food) => food.sourcePlantId === plant.id && food.amount > 0);
  for (const head of visual.seedHeads) head.visible = plantSeedWindow(plant) || hasCrop || season === 'autumn';
  visual.foliageMaterial.color.setHex(growing ? PLANT_PROFILES[plant.species].foliage : PLANT_PROFILES[plant.species].dry);
  visual.foliageMaterial.color.multiplyScalar(0.76 + plant.health * 0.24);
  visual.seedMaterial.color.setHex(PLANT_PROFILES[plant.species].seed);
}

function updateColonySeedBanks(dt) {
  for (const bank of colonySeedBanks.values()) {
    const colony = getColony(bank.colonyId);
    if (!colony || colony.status === 'extinct') continue;
    const consumption = Math.min(bank.current, dt * colony.workers.length * (environment.season.name === 'winter' ? 0.00024 : 0.00016));
    bank.current -= consumption;
    bank.consumed += consumption;
    bank.discardClock -= dt;
    const humidity = weather.postRainHumidity + weather.rain * 0.9;
    bank.wetSproutProgress += dt * bank.current * humidity * 0.00018;
    const shouldDiscard = bank.discardClock <= 0 && bank.current > 5;
    const sprouted = bank.wetSproutProgress >= 1 && bank.current > 1;
    if (!shouldDiscard && !sprouted) continue;
    const amount = Math.min(bank.current, sprouted ? 1 : rand(0.7, 1.5));
    bank.current -= amount;
    bank.dispersed += amount;
    if (sprouted) {
      bank.sproutedInStore += amount;
      bank.wetSproutProgress = Math.max(0, bank.wetSproutProgress - 1);
    }
    bank.discardClock = rand(20, 38);
    vegetationEcology.stats.antDispersedSeeds += amount;
    const angle = rand(0, Math.PI * 2);
    const radius = rand(3.1, 5.7);
    addSoilSeedCohort(
      colony.nest.x + Math.cos(angle) * radius,
      colony.nest.y + Math.sin(angle) * radius * 0.8,
      Object.keys(bank.species).sort((a, b) => (bank.species[b] || 0) - (bank.species[a] || 0))[0] || 'needlegrass',
      Math.max(1, Math.round(amount)),
      { viability: sprouted ? 0.98 : rand(0.55, 0.84), dispersedByColonyId: colony.id, progress: sprouted ? 0.82 : rand(0.08, 0.46) },
    );
  }
}

function updateVegetationEcology(dt) {
  const seasonKey = Math.floor(simTime / SEASON_SECONDS);
  const activePlantCrops = () => foods.filter((food) => food.amount > 0 && food.ecologySource === 'plant seedfall').length;
  for (const plant of vegetationEcology.plants) {
    if (!plant.alive) continue;
    const plantStep = calculatePlantSeasonStep({
      plant,
      dt,
      seasonName: environment.season.name,
      seasonProgress: environment.seasonProgress,
      postRainHumidity: weather.postRainHumidity,
      seasonKey,
    });
    plant.maturity = plantStep.maturity;
    plant.health = plantStep.health;
    plant.phenology = plantStep.phenology;
    plant.lastWinterCheck = plantStep.lastWinterCheck;
    if (plantStep.mortalityRisk != null && random() < plantStep.mortalityRisk) {
      plant.alive = false;
      plant.visual.group.visible = false;
      vegetationEcology.stats.plantDeaths++;
      addSoilSeedCohort(plant.x, plant.z, plant.species, Math.max(1, Math.round(plant.seedsProduced * 0.05)), { sourcePlantId: plant.id, viability: rand(0.35, 0.72) });
      continue;
    }

    if (demographicScenario !== 'scarcity' && plant.maturity > 0.54 && plantSeedWindow(plant)
      && plant.producedSeasonKey !== seasonKey && activePlantCrops() < (demographicScenario === 'abundance' ? 14 : 10)) {
      const profile = PLANT_PROFILES[plant.species];
      const crop = Math.max(6, Math.round(profile.maxCrop * plant.maturity * plant.health
        * rand(0.72, 1.12) * RESOURCE_ABUNDANCE_FACTOR));
      const angle = rand(0, Math.PI * 2);
      const food = addFood(
        plant.x + Math.cos(angle) * rand(0.28, 0.55),
        plant.z + Math.sin(angle) * rand(0.24, 0.48),
        'seed', crop, rand(0.62, 0.92),
        { source: 'plant seedfall', sourcePlantId: plant.id, seedSpecies: plant.species },
      );
      plant.cropFoodId = foods.indexOf(food);
      plant.producedSeasonKey = seasonKey;
      plant.seedsProduced += crop;
      vegetationEcology.stats.seedsProduced += crop;
    }
    updateSeedPlantVisual(plant);
  }

  for (const food of foods) {
    if (food.amount <= 0 || food.ecologySource !== 'plant seedfall' || simTime - food.createdAt < 66) continue;
    const returned = Math.max(1, Math.round(food.amount * 0.34));
    addSoilSeedCohort(food.x, food.z, food.seedSpecies, returned, { sourcePlantId: food.sourcePlantId, viability: rand(0.58, 0.92) });
    food.amount = 0;
    food.depletedAt = simTime;
    food.mesh.visible = false;
  }

  if (environment.season.name === 'spring') {
    for (let i = vegetationEcology.soilSeeds.length - 1; i >= 0; i--) {
      const cohort = vegetationEcology.soilSeeds[i];
      const moisture = 0.34 + weather.postRainHumidity * 0.7 + weather.rain * 0.8;
      Object.assign(cohort, calculateSeedCohortStep(cohort, dt, environment.season.name, moisture));
      if (cohort.germinationProgress < 1 || !plantSpotClear(cohort.x, cohort.z, 1.05)) continue;
      const plant = createSeedPlant(cohort.x, cohort.z, cohort.species, rand(0.06, 0.13), cohort.dispersedByColonyId);
      if (!plant) continue;
      vegetationEcology.stats.germinations++;
      if (cohort.dispersedByColonyId) vegetationEcology.stats.antDispersedGerminations++;
      cohort.count--;
      cohort.germinationProgress = rand(0, 0.18);
      if (cohort.count <= 0) vegetationEcology.soilSeeds.splice(i, 1);
    }
  } else {
    for (const cohort of vegetationEcology.soilSeeds) {
      Object.assign(cohort, calculateSeedCohortStep(cohort, dt, environment.season.name, 0));
    }
  }
  for (let i = vegetationEcology.soilSeeds.length - 1; i >= 0; i--) {
    if (vegetationEcology.soilSeeds[i].viability <= 0.05) vegetationEcology.soilSeeds.splice(i, 1);
  }
  updateColonySeedBanks(dt);
}

function retireDepletedFoodRecords() {
  for (let i = foods.length - 1; i >= 0; i--) {
    const food = foods[i];
    if (food.amount > 0 || food.depletedAt == null || simTime - food.depletedAt < 54) continue;
    food.mesh.parent?.remove(food.mesh);
    foodSpatialIndex.remove(food);
    foods.splice(i, 1);
    ecologicalBalance.depletedFoodRetired++;
  }
}

const initialPlantSpecies = ['needlegrass', 'needlegrass', 'desertForb', 'saltbush'];
for (let i = 0; i < 19; i++) {
  let x;
  let z;
  let attempts = 0;
  do {
    x = rand(-HALF_W + 1.2, HALF_W - 1.2);
    z = rand(-HALF_D + 1.2, HALF_D - 1.2);
    attempts++;
  } while (!plantSpotClear(x, z, 1.35) && attempts < 40);
  createSeedPlant(x, z, initialPlantSpecies[i % initialPlantSpecies.length], rand(0.58, 1));
}
for (let i = 0; i < 14; i++) {
  addSoilSeedCohort(rand(-HALF_W + 1.5, HALF_W - 1.5), rand(-HALF_D + 1.5, HALF_D - 1.5), initialPlantSpecies[i % initialPlantSpecies.length], Math.floor(rand(1, 4)), { progress: rand(0.18, 0.78) });
}

const predatorMesh = makeProp('beetle', HALF_W - 1.2, HALF_D - 1.2, 2.05, 0);
predatorMesh.material = propMaterials.beetle.clone();
predatorMesh.material.color.setHex(0x6d4438);
predatorMesh.visible = false;
predatorMesh.renderOrder = 6;
const predator = {
  active: false,
  x: HALF_W - 1.2,
  z: HALF_D - 1.2,
  heading: Math.PI,
  timer: 0,
  nextVisit: 24,
  targetId: null,
  kills: 0,
  foodStolen: 0,
};

function makeSpiderModel() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x30252b, roughness: 0.78, flatShading: true });
  const abdomen = new THREE.Mesh(new THREE.SphereGeometry(0.36, 10, 7), material);
  abdomen.scale.set(1.15, 0.62, 0.92);
  abdomen.position.x = -0.22;
  group.add(abdomen);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 9, 6), material);
  head.scale.set(0.9, 0.62, 0.82);
  head.position.x = 0.28;
  group.add(head);
  for (let side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const root = new THREE.Vector3(0.14 - i * 0.11, 0, side * 0.12);
      const knee = new THREE.Vector3(0.18 - i * 0.08, 0.03, side * (0.5 + i * 0.08));
      const tip = new THREE.Vector3(-0.05 - i * 0.13, -0.06, side * (0.76 + i * 0.05));
      for (const [a, b] of [[root, knee], [knee, tip]]) {
        const direction = new THREE.Vector3().subVectors(b, a);
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.026, direction.length(), 5), material);
        leg.position.copy(a).add(b).multiplyScalar(0.5);
        leg.quaternion.setFromUnitVectors(Y_AXIS, direction.normalize());
        group.add(leg);
      }
    }
  }
  group.scale.setScalar(1.35);
  group.visible = false;
  group.renderOrder = 7;
  surfaceGroup.add(group);
  return group;
}

const spiderMesh = makeSpiderModel();
const spiderWeb = new THREE.Mesh(
  new THREE.RingGeometry(0.45, 2.15, 40, 4),
  new THREE.MeshBasicMaterial({ color: 0xe3ddd0, wireframe: true, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }),
);
spiderWeb.rotation.x = -Math.PI / 2;
spiderWeb.visible = false;
surfaceGroup.add(spiderWeb);
const spider = {
  active: false, x: 0, z: 0, heading: 0, timer: 0, nextVisit: 58, attackCooldown: 0,
  webX: 0, webZ: 0, kills: 0, homeKills: 0, rivalKills: 0,
};

// ---------- ants, instancing and local behavior ----------
const antPresentation = createAntPresentation({
  surfaceGroup,
  antMaterials,
  groundHeight,
  groundNormal,
  clamp,
});
const {
  antGeometry,
  antMeshes,
  rivalMeshes,
  antInstanceLookup,
  rivalInstanceLookup,
  adaptiveVisualState,
} = antPresentation;

function updateAdaptiveVisualDetail() {
  antPresentation.updateAdaptiveVisualDetail({
    livingColonies,
    viewState,
    cameraRig,
    youngWorkerMeshes,
    youngCargoMesh,
  });
}

function visualFrameForPhase(phase) {
  return antPresentation.visualFrameForPhase(phase);
}

const spoilClods = [];
let excavatedSoil = 0;
function addSpoilClod(x, z) {
  if (spoilClods.length >= 150) {
    const old = spoilClods.shift();
    old.parent?.remove(old);
    old.geometry.dispose();
    old.material.dispose();
  }
  const size = rand(0.09, 0.19);
  const clod = new THREE.Mesh(
    new THREE.DodecahedronGeometry(size, 0),
    new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(rand(0.055, 0.078), rand(0.4, 0.58), rand(0.3, 0.42)), roughness: 1, flatShading: true }),
  );
  clod.position.set(x, groundHeight(x, z) + size * 0.42, z);
  clod.rotation.set(rand(0, Math.PI), rand(0, Math.PI), rand(0, Math.PI));
  clod.scale.y = rand(0.55, 1.15);
  clod.castShadow = clod.receiveShadow = true;
  surfaceGroup.add(clod);
  spoilClods.push(clod);
}

const selectionPresentation = createSelectionPresentation({
  scene,
  surfaceGroup,
  undergroundGroup,
  canvas,
  camera,
  terrain,
  viewState,
});

// ---------- living underground nest scan ----------
const homeNestGraph = createNestGraph({ colonyId: `${HOME_COLONY_ID}-legacy` });
const homeNestPresenter = createNestPresenter({
  parent: undergroundGroup,
  name: 'amber-nest-scan',
  color: 0x8f512f,
  wireColor: 0xd38b45,
  chamberColor: 0x75402a,
  chamberWireColor: 0xe0a45f,
  fillOpacity: 0.07,
  wireOpacity: 0.24,
  chamberFillOpacity: 0.08,
  chamberWireOpacity: 0.3,
  tubeSegments: 78,
  radialSegments: 10,
  chamberSegments: 22,
  chamberRings: 14,
  chamberRevealStart: 0.78,
  createFront: true,
  createFrontFace: true,
  frontColor: 0x9b5e36,
  frontOpacity: 0.58,
  frontScaleFactor: 0.72,
  frontOffset: 0.018,
});
const homeNestScanGroup = homeNestPresenter.group;
const tunnelSegments = [];

function addTunnelSegment(name, points, radius, start, duration, chamberScale, parentSegmentIndex = null) {
  const segmentIndex = tunnelSegments.length;
  const fromNode = parentSegmentIndex == null
    ? addNestNode(homeNestGraph, {
      id: `${HOME_COLONY_ID}-legacy-entrance`,
      type: 'entrance',
      position: points[0],
      completed: true,
      renderChamber: false,
    })
    : homeNestGraph.nodes.get(tunnelSegments[parentSegmentIndex].toNodeId);
  const toNode = addNestNode(homeNestGraph, {
    id: `${HOME_COLONY_ID}-legacy-chamber-${segmentIndex}`,
    type: name,
    position: points[points.length - 1],
    completed: false,
    targetScale: chamberScale,
  });
  const segment = addNestEdge(homeNestGraph, {
    id: `${HOME_COLONY_ID}-legacy-tunnel-${segmentIndex}`,
    name,
    fromNodeId: fromNode.id,
    toNodeId: toNode.id,
    controlPoints: points,
    radius,
    tension: 0.38,
    start,
    duration,
    chamberScale,
    frontRotation: segmentIndex * 0.73,
    progress: 0,
    work: 0,
    available: false,
  });
  segment.activeDiggers = 0;
  homeNestPresenter.syncTopology(homeNestGraph);
  segment.workRequired = Math.max(30, homeNestPresenter.curveFor(segment).getLength() * 20);
  tunnelSegments.push(segment);
  return segment;
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const entranceY = groundHeight(NEST.x, NEST.y) + 0.05;
addTunnelSegment('entrance shaft', [
  V(NEST.x, entranceY, NEST.y), V(-5.65, -0.9, -1.0), V(-5.1, -2.45, -1.65), V(-5.55, -4.15, -0.8),
], 0.36, -50, 25, [1.5, 0.62, 1.1]);
addTunnelSegment('western nursery', [
  V(-5.55, -1.45, -1.2), V(-7.0, -2.0, -2.45), V(-8.8, -2.75, -3.65), V(-10.2, -3.15, -2.55),
], 0.29, -50, 30, [1.8, 0.55, 1.12], 0);
addTunnelSegment('eastern stores', [
  V(-5.18, -2.5, -1.62), V(-3.45, -3.0, -0.35), V(-1.15, -3.75, 1.55), V(0.45, -4.25, 0.65),
], 0.31, -50, 32, [1.65, 0.52, 1.18], 0);
addTunnelSegment('descending gallery', [
  V(-5.55, -4.12, -0.8), V(-4.85, -5.2, -0.05), V(-5.2, -6.45, 1.3), V(-4.4, -7.5, 0.7),
], 0.34, -45, 34, [1.42, 0.58, 1.25], 0);
addTunnelSegment('western deep chamber', [
  V(-5.15, -6.4, 1.25), V(-7.0, -6.85, 2.45), V(-8.8, -7.35, 4.25), V(-10.4, -7.75, 3.5),
], 0.28, 12, 48, [1.72, 0.56, 1.08], 3);
addTunnelSegment('southeast gallery', [
  V(-4.42, -7.48, 0.7), V(-2.05, -7.9, -1.25), V(0.65, -8.15, -3.85), V(2.45, -8.5, -3.25),
], 0.3, 28, 54, [1.7, 0.5, 1.2], 3);
addTunnelSegment('lower shaft', [
  V(-4.42, -7.48, 0.7), V(-4.9, -8.75, 0.15), V(-3.8, -10.15, 1.2), V(-4.35, -11.6, 0.35),
], 0.33, 48, 48, [1.48, 0.6, 1.16], 3);
addTunnelSegment('lower western fork', [
  V(-4.32, -11.55, 0.35), V(-6.25, -11.05, -1.55), V(-8.1, -11.4, -3.5), V(-9.5, -11.75, -4.15),
], 0.27, 76, 52, [1.6, 0.52, 1.08], 6);
addTunnelSegment('lower eastern fork', [
  V(-4.32, -11.55, 0.35), V(-2.5, -11.1, 2.0), V(-0.6, -11.45, 4.15), V(1.25, -11.85, 5.0),
], 0.27, 96, 58, [1.55, 0.5, 1.2], 6);

const homeNestCurve = (segmentOrIndex) => homeNestPresenter.curveFor(
  typeof segmentOrIndex === 'number' ? tunnelSegments[segmentOrIndex] : segmentOrIndex,
);

function closestCurveT(curve, point) {
  let bestT = 0;
  let bestDistance = Infinity;
  const sample = new THREE.Vector3();
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    curve.getPointAt(t, sample);
    const distance = sample.distanceToSquared(point);
    if (distance < bestDistance) { bestDistance = distance; bestT = t; }
  }
  return bestT;
}

function nestLeg(segmentIndex, from = 0, to = 1) {
  const segment = tunnelSegments[segmentIndex];
  return { segmentIndex, from, to, length: Math.max(0.1, homeNestCurve(segment).getLength() * Math.abs(to - from)) };
}

const nurseryJoin = closestCurveT(homeNestCurve(0), homeNestCurve(1).getPointAt(0));
const storesJoin = closestCurveT(homeNestCurve(0), homeNestCurve(2).getPointAt(0));
const VESTIBULE_T = Math.min(0.22, storesJoin * 0.58);
const NEST_ROUTES = {
  vestibule: { label: 'entrance vestibule', legs: [nestLeg(0, 0, VESTIBULE_T)] },
  transferStores: { label: 'vestibule-to-stores transfer route', legs: [nestLeg(0, VESTIBULE_T, storesJoin), nestLeg(2)] },
  nursery: { label: 'nursery chamber', legs: [nestLeg(0, 0, nurseryJoin), nestLeg(1)] },
  stores: { label: 'food stores', legs: [nestLeg(0, 0, storesJoin), nestLeg(2)] },
  rest: { label: 'deep resting chamber', legs: [nestLeg(0), nestLeg(3)] },
};

const vestibuleCenter = homeNestCurve(0).getPointAt(VESTIBULE_T).clone();
const vestibuleShell = new THREE.Group();
const vestibuleGeometry = new THREE.SphereGeometry(1, 18, 11);
vestibuleShell.add(
  new THREE.Mesh(vestibuleGeometry, new THREE.MeshBasicMaterial({ color: 0xb96f3d, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, fog: false })),
  new THREE.Mesh(vestibuleGeometry, new THREE.MeshBasicMaterial({ color: 0xe5a65b, wireframe: true, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false, fog: false })),
);
vestibuleShell.position.copy(vestibuleCenter);
vestibuleShell.scale.set(1.12, 0.58, 0.86);
vestibuleShell.renderOrder = 4;
homeNestScanGroup.add(vestibuleShell);

const vestibuleSignal = new THREE.Mesh(
  new THREE.RingGeometry(0.32, 0.39, 28),
  new THREE.MeshBasicMaterial({ color: 0xf1c36d, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthTest: false, fog: false }),
);
vestibuleSignal.position.copy(vestibuleCenter);
vestibuleSignal.rotation.x = Math.PI / 2;
vestibuleSignal.renderOrder = 8;
homeNestScanGroup.add(vestibuleSignal);

function makeGranaryVisual(parent, center, capacity, color) {
  const mesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.075, 0),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, fog: false }),
    capacity,
  );
  const granaryMatrix = new THREE.Matrix4();
  const granaryScale = new THREE.Vector3();
  const granaryQuaternion = new THREE.Quaternion();
  for (let i = 0; i < capacity; i++) {
    const angle = i * 2.399;
    const ring = 0.16 + Math.sqrt(i / capacity) * 0.86;
    const layer = Math.floor(i / 24);
    granaryScale.set(rand(0.58, 1.18), rand(0.42, 0.72), rand(0.58, 1.12));
    granaryQuaternion.setFromEuler(new THREE.Euler(i * 0.31, i * 0.73, i * 0.17));
    granaryMatrix.compose(
      new THREE.Vector3(
        center.x + Math.cos(angle) * ring,
        center.y - 0.28 + layer * 0.085 + Math.sin(i * 1.7) * 0.025,
        center.z + Math.sin(angle) * ring * 0.55,
      ),
      granaryQuaternion,
      granaryScale,
    );
    mesh.setMatrixAt(i, granaryMatrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.count = 0;
  mesh.renderOrder = 6;
  parent.add(mesh);
  return mesh;
}

const homeGranaryCenter = homeNestCurve(2).getPointAt(1).clone();
const homeGranaryVisual = makeGranaryVisual(homeNestScanGroup, homeGranaryCenter, 76, 0xd9b965);

const entranceCachePool = Array.from({ length: 48 }, () => {
  const item = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.125, 0),
    new THREE.MeshBasicMaterial({ color: 0xd7b360, fog: false, depthTest: false }),
  );
  item.visible = false;
  item.renderOrder = 9;
  homeNestScanGroup.add(item);
  return item;
});

const descendingJoinWestern = closestCurveT(homeNestCurve(3), homeNestCurve(4).getPointAt(0));
for (let i = 0; i < tunnelSegments.length; i++) {
  const established = i <= 3;
  const progress = established ? 1 : (i === 4 ? 0.045 : i === 5 ? 0.025 : 0);
  updateNestEdgeProgress(homeNestGraph, tunnelSegments[i], progress, {
    work: progress * tunnelSegments[i].workRequired,
  });
}

function refreshConstructionProjects() {
  for (let i = 4; i < tunnelSegments.length; i++) {
    const dependencies = CONSTRUCTION_DEPENDENCIES[i] || [];
    tunnelSegments[i].available = tunnelSegments[i].progress < 0.999
      && dependencies.every((index) => tunnelSegments[index].progress >= 0.999);
    tunnelSegments[i].activeDiggers = 0;
  }
}

function activeConstructionProjects() {
  return tunnelSegments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment, index }) => index >= 4 && segment.available);
}

function buildExcavationRoute(projectIndex) {
  const front = Math.max(0.012, tunnelSegments[projectIndex].progress);
  const route = [nestLeg(0), nestLeg(3)];
  if (projectIndex === 4) route[1] = nestLeg(3, 0, descendingJoinWestern);
  if (projectIndex === 7 || projectIndex === 8) route.push(nestLeg(6));
  route.push(nestLeg(projectIndex, 0, front));
  return { label: `dig face · ${tunnelSegments[projectIndex].name}`, legs: route, projectIndex };
}

const alateWingTexture = createWingTexture();

function createAlateVisualPool(parent, bodyTint, count = 36) {
  return Array.from({ length: count }, (_, index) => {
    const group = new THREE.Group();
    const body = new THREE.Sprite(new THREE.SpriteMaterial({
      map: antMaterials[index % antMaterials.length].map,
      color: bodyTint,
      transparent: true,
      alphaTest: 0.04,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }));
    const leftWing = new THREE.Sprite(new THREE.SpriteMaterial({
      map: alateWingTexture, color: 0xddebea, transparent: true, opacity: 0.62,
      depthWrite: false, depthTest: false, fog: false,
    }));
    const rightWing = leftWing.clone();
    leftWing.position.set(-0.18, 0.08, -0.02);
    rightWing.position.set(0.18, 0.08, -0.02);
    leftWing.material.rotation = 0.34;
    rightWing.material = leftWing.material.clone();
    rightWing.material.rotation = Math.PI - 0.34;
    body.renderOrder = 12;
    leftWing.renderOrder = rightWing.renderOrder = 11;
    group.add(leftWing, rightWing, body);
    group.visible = false;
    group.renderOrder = 11;
    parent.add(group);
    return { group, body, leftWing, rightWing };
  });
}

function updateAlateVisualPool(pool, alates, center, palette) {
  const visibleCount = Math.min(pool.length, alates.length);
  for (let i = 0; i < visibleCount; i++) {
    const visual = pool[i];
    const alate = alates[i];
    const angle = i * 2.399 + simTime * (alate.destiny === 'male' ? 0.02 : -0.012);
    const radius = 0.78 + (i % 7) * 0.105;
    visual.group.position.set(
      center.x + Math.cos(angle) * radius,
      center.y + 0.04 + Math.sin(simTime * 1.2 + i) * 0.045,
      center.z + Math.sin(angle) * radius * 0.58,
    );
    const scale = alate.destiny === 'gyne' ? 0.72 : 0.56;
    visual.body.scale.set(scale, scale, 1);
    visual.body.material.color.setHex(alate.destiny === 'gyne' ? palette.gyne : palette.male);
    const flap = Math.sin(simTime * 3.1 + i) * 0.035;
    visual.leftWing.scale.set(scale * 0.92, scale * 0.42 + flap, 1);
    visual.rightWing.scale.set(scale * 0.92, scale * 0.42 - flap, 1);
    visual.group.visible = true;
  }
  for (let i = visibleCount; i < pool.length; i++) pool[i].group.visible = false;
}

const flightAlateVisualPool = createAlateVisualPool(surfaceGroup, 0x765248, 72);
const foundressVisualPool = Array.from({ length: 24 }, (_, index) => {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: antMaterials[index % antMaterials.length].map,
    color: 0x8f493a,
    transparent: true,
    alphaTest: 0.045,
    depthWrite: false,
    depthTest: false,
    fog: true,
  }));
  sprite.visible = false;
  sprite.renderOrder = 8;
  surfaceGroup.add(sprite);
  return sprite;
});
const foundingSiteVisualPool = Array.from({ length: 24 }, (_, index) => {
  const group = new THREE.Group();
  const chamber = new THREE.Mesh(
    new THREE.CircleGeometry(0.72, 30),
    new THREE.MeshBasicMaterial({ color: 0x2a1812, transparent: true, opacity: 0.24, depthWrite: false, side: THREE.DoubleSide }),
  );
  chamber.rotation.x = -Math.PI / 2;
  chamber.renderOrder = 5;
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.72, 30),
    new THREE.MeshBasicMaterial({ color: 0xc28b58, transparent: true, opacity: 0.66, depthWrite: false, side: THREE.DoubleSide }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.012;
  rim.renderOrder = 6;
  const queen = new THREE.Sprite(new THREE.SpriteMaterial({
    map: antMaterials[index % antMaterials.length].map, color: 0x974838,
    transparent: true, alphaTest: 0.045, depthWrite: false, depthTest: false, fog: true,
  }));
  queen.position.set(-0.12, 0.19, 0);
  queen.scale.set(0.92, 0.92, 1);
  queen.renderOrder = 10;
  const brood = Array.from({ length: 9 }, (_, broodIndex) => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 8, 5),
      new THREE.MeshBasicMaterial({ color: 0xf0d9ae, depthTest: false, fog: false }),
    );
    const angle = broodIndex * 2.399;
    mesh.position.set(0.2 + Math.cos(angle) * (0.14 + (broodIndex % 3) * 0.06), 0.12, Math.sin(angle) * 0.2);
    mesh.renderOrder = 9;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  });
  const nanitics = Array.from({ length: 9 }, (_, workerIndex) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: antMaterials[workerIndex % antMaterials.length].map, color: 0xbd765b,
      transparent: true, alphaTest: 0.045, depthWrite: false, depthTest: false, fog: true,
    }));
    sprite.renderOrder = 10;
    sprite.visible = false;
    group.add(sprite);
    return sprite;
  });
  const soil = Array.from({ length: 10 }, (_, soilIndex) => {
    const clod = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.085 + (soilIndex % 3) * 0.018, 0),
      new THREE.MeshStandardMaterial({ color: 0x9b633e, roughness: 1, flatShading: true }),
    );
    const angle = soilIndex * 2.399;
    clod.position.set(Math.cos(angle) * (0.7 + (soilIndex % 2) * 0.11), 0.07, Math.sin(angle) * (0.58 + (soilIndex % 3) * 0.06));
    clod.visible = false;
    group.add(clod);
    return clod;
  });
  group.add(chamber, rim, queen);
  group.visible = false;
  surfaceGroup.add(group);
  return { group, chamber, rim, queen, brood, nanitics, soil };
});
const youngWorkerInstanceLookup = [[], [], [], []];
const youngWorkerMeshes = antMaterials.map((material) => {
  const mesh = new THREE.InstancedMesh(antGeometry, material.clone(), TECHNICAL_GLOBAL_WORKER_LIMIT);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  mesh.renderOrder = 9;
  surfaceGroup.add(mesh);
  return mesh;
});
const youngCargoMesh = new THREE.InstancedMesh(
  new THREE.IcosahedronGeometry(0.085, 0),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
  TECHNICAL_GLOBAL_WORKER_LIMIT,
);
youngCargoMesh.frustumCulled = false;
youngCargoMesh.castShadow = true;
youngCargoMesh.count = 0;
youngCargoMesh.renderOrder = 9;
surfaceGroup.add(youngCargoMesh);
const shedWings = [];

function leaveShedWings(x, z) {
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.28),
      new THREE.MeshBasicMaterial({
        map: alateWingTexture, color: 0xe4ece7, transparent: true, opacity: 0.5,
        alphaTest: 0.03, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    wing.rotation.x = -Math.PI / 2;
    wing.rotation.z = side * rand(0.22, 0.62);
    wing.position.set(x + side * 0.28, groundHeight(x, z) + 0.045, z + rand(-0.12, 0.12));
    wing.userData.life = 70;
    surfaceGroup.add(wing);
    shedWings.push(wing);
  }
  while (shedWings.length > 36) {
    const old = shedWings.shift();
    old.parent?.remove(old);
    old.geometry.dispose();
    old.material.dispose();
  }
}

function renderRegionalReproductionVisuals() {
  const airborne = regionalMating.flyingAlates;
  const visibleFlights = Math.min(airborne.length, flightAlateVisualPool.length);
  for (let i = 0; i < visibleFlights; i++) {
    const alate = airborne[i];
    const visual = flightAlateVisualPool[i];
    visual.group.position.set(alate.x, alate.y, alate.z);
    const scale = alate.destiny === 'gyne' ? 1.18 : 0.88;
    visual.body.scale.set(scale, scale, 1);
    visual.body.material.color.setHex(alate.destiny === 'gyne'
      ? alate.originColonyId === RIVAL_COLONY_ID ? 0x678aa6 : 0xa44636
      : alate.originColonyId === RIVAL_COLONY_ID ? 0x81949e : 0x756158);
    const flap = Math.sin(alate.phase * 2.4) * 0.07;
    visual.leftWing.scale.set(scale * 1.28, scale * (0.54 + flap), 1);
    visual.rightWing.scale.set(scale * 1.28, scale * (0.54 - flap), 1);
    visual.leftWing.material.opacity = visual.rightWing.material.opacity = 0.86;
    visual.group.rotation.y = -alate.heading;
    visual.group.visible = true;
  }
  for (let i = visibleFlights; i < flightAlateVisualPool.length; i++) flightAlateVisualPool[i].group.visible = false;

  const surfaceFoundresses = regionalMating.matedQueens.filter((queen) => queen.alive
    && (!queen.foundingStage || queen.foundingStage === 'assessing' || queen.foundingStage === 'relocating'));
  const visibleFoundresses = Math.min(foundressVisualPool.length, surfaceFoundresses.length);
  for (let i = 0; i < visibleFoundresses; i++) {
    const queen = surfaceFoundresses[i];
    const sprite = foundressVisualPool[i];
    sprite.position.set(queen.x, groundHeight(queen.x, queen.z) + 0.2, queen.z);
    sprite.scale.set(1.28, 1.28, 1);
    sprite.material.color.setHex(queen.natalColonyId === RIVAL_COLONY_ID ? 0x6989a0 : 0x934234);
    sprite.material.rotation = queen.heading - Math.PI * 0.5;
    sprite.visible = true;
  }
  for (let i = visibleFoundresses; i < foundressVisualPool.length; i++) foundressVisualPool[i].visible = false;

  const foundingSites = regionalMating.matedQueens.filter((queen) => queen.foundingStage
    && queen.foundingStage !== 'assessing' && queen.foundingStage !== 'relocating');
  const visibleSites = Math.min(foundingSiteVisualPool.length, foundingSites.length);
  for (let i = 0; i < visibleSites; i++) {
    const foundation = foundingSites[i];
    const visual = foundingSiteVisualPool[i];
    const progress = clamp(foundation.chamberProgress || 0, 0, 1);
    const inactiveSite = foundation.foundingStage === 'failed' || foundation.foundingStage === 'collapsed';
    visual.group.position.set(foundation.x, groundHeight(foundation.x, foundation.z) + 0.055, foundation.z);
    visual.group.scale.setScalar(0.62 + progress * 0.55);
    visual.chamber.material.opacity = inactiveSite ? 0.12 : 0.12 + progress * 0.2;
    visual.chamber.material.color.setHex(inactiveSite ? 0x413933 : 0x2a1812);
    visual.rim.material.color.setHex(foundation.natalColonyId === RIVAL_COLONY_ID ? 0x7596aa : 0xc28b58);
    visual.rim.material.opacity = inactiveSite ? 0.3 : 0.38 + progress * 0.38;
    const surfaceQueenVisible = foundation.foundingStage === 'excavating';
    visual.queen.visible = foundation.alive && !inactiveSite && surfaceQueenVisible;
    visual.queen.position.y = 0.2 - progress * 0.34;
    visual.queen.material.color.setHex(foundation.natalColonyId === RIVAL_COLONY_ID ? 0x6c8da2 : 0x974838);
    visual.queen.material.rotation = foundation.heading - Math.PI * 0.5;
    for (let j = 0; j < visual.soil.length; j++) visual.soil[j].visible = j < Math.floor(progress * visual.soil.length);
    for (let j = 0; j < visual.brood.length; j++) {
      const item = foundation.foundingBrood?.[j];
      const mesh = visual.brood[j];
      mesh.visible = Boolean(item) && foundation.chamberProgress < 1;
      if (!item) continue;
      const scale = item.stage === 'egg' ? 0.72 : item.stage === 'larva' ? 1 : 1.12;
      mesh.scale.set(scale * (item.stage === 'egg' ? 0.72 : 1), scale, scale * 0.82);
      mesh.material.color.setHex(item.stage === 'egg' ? 0xf3e3c3 : item.stage === 'larva' ? 0xe1c28d : 0xb89166);
    }
    const chamberWorkers = foundation.nanitics?.filter((worker) => worker.insideNest && worker.alive) || [];
    for (let j = 0; j < visual.nanitics.length; j++) {
      const worker = chamberWorkers[j];
      const sprite = visual.nanitics[j];
      sprite.visible = Boolean(worker) && foundation.chamberProgress < 1;
      if (!worker) continue;
      const angle = j * 2.399 + simTime * (0.04 + j * 0.003);
      const radius = 0.34 + (j % 3) * 0.1;
      sprite.position.set(Math.cos(angle) * radius, 0.16 + Math.sin(simTime * 1.4 + j) * 0.02, Math.sin(angle) * radius * 0.64);
      sprite.scale.set(0.45, 0.45, 1);
    }
    visual.group.visible = true;
  }
  for (let i = visibleSites; i < foundingSiteVisualPool.length; i++) foundingSiteVisualPool[i].group.visible = false;

  const surfaceYoungWorkers = regionalMating.matedQueens.flatMap((queen) => queen.nanitics || [])
    .filter((worker) => worker.alive && !worker.insideNest);
  const frameCounts = [0, 0, 0, 0];
  youngWorkerInstanceLookup.forEach((lookup) => { lookup.length = 0; });
  let visibleYoungCargo = 0;
  const position = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const groundTilt = new THREE.Quaternion();
  const headingSpin = new THREE.Quaternion();
  const normal = new THREE.Vector3();
  const workerColor = new THREE.Color();
  const lineageColor = new THREE.Color();
  const injuryColor = new THREE.Color(0x9b6a58);
  const cargoColor = new THREE.Color();
  for (const worker of surfaceYoungWorkers) {
    const frame = visualFrameForPhase(worker.phase);
    const instance = frameCounts[frame]++;
    youngWorkerInstanceLookup[frame][instance] = worker;
    const colony = getColony(worker.colonyId);
    position.set(worker.x, groundHeight(worker.x, worker.z) + 0.11 + Math.sin(worker.phase) * 0.009, worker.z);
    if (adaptiveVisualState.useTerrainNormals) groundTilt.setFromUnitVectors(Y_AXIS, groundNormal(worker.x, worker.z, normal));
    else groundTilt.identity();
    headingSpin.setFromAxisAngle(Y_AXIS, -worker.heading - Math.PI / 2);
    orientation.copy(groundTilt).multiply(headingSpin);
    const scale = worker.workerCaste === 'nanitic' ? 0.62 : 0.72;
    matrix.compose(position, orientation, new THREE.Vector3(scale, scale, scale));
    youngWorkerMeshes[frame].setMatrixAt(instance, matrix);
    lineageColor.setHex(colony?.foundedBy === RIVAL_COLONY_ID ? 0x7897a9 : 0xb9664f);
    workerColor.copy(lineageColor).lerp(injuryColor, clamp((62 - worker.health) / 48, 0, 0.72));
    youngWorkerMeshes[frame].setColorAt(instance, workerColor);
    if (worker.carrying) {
      const cargoX = worker.x + Math.cos(worker.heading) * 0.18;
      const cargoZ = worker.z + Math.sin(worker.heading) * 0.18;
      matrix.compose(
        new THREE.Vector3(cargoX, groundHeight(cargoX, cargoZ) + 0.18, cargoZ),
        orientation,
        new THREE.Vector3(1, 0.68, 1),
      );
      youngCargoMesh.setMatrixAt(visibleYoungCargo, matrix);
      cargoColor.setHex(worker.carryingKind === 'berry' ? 0xa86453 : worker.carryingKind === 'beetle' ? 0x826346 : 0xd9b666);
      youngCargoMesh.setColorAt(visibleYoungCargo++, cargoColor);
    }
  }
  youngWorkerMeshes.forEach((mesh, frame) => {
    mesh.count = frameCounts[frame];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  youngCargoMesh.count = visibleYoungCargo;
  youngCargoMesh.instanceMatrix.needsUpdate = true;
  if (youngCargoMesh.instanceColor) youngCargoMesh.instanceColor.needsUpdate = true;
  adaptiveVisualState.renderedDescendantWorkers = surfaceYoungWorkers.length;

}

function updateShedWingLifecycle(dt) {
  for (let i = shedWings.length - 1; i >= 0; i--) {
    const wing = shedWings[i];
    wing.userData.life -= dt;
    wing.material.opacity = clamp(wing.userData.life / 30, 0, 0.5);
    if (wing.userData.life <= 0) {
      wing.parent?.remove(wing);
      wing.geometry.dispose();
      wing.material.dispose();
      shedWings.splice(i, 1);
    }
  }
}

const rivalNestGraph = createNestGraph({ colonyId: `${RIVAL_COLONY_ID}-legacy` });
const rivalNestPresenter = createNestPresenter({
  parent: undergroundGroup,
  name: 'rival-nest-scan',
  color: 0x55738c,
  wireColor: 0x82a9bd,
  chamberColor: 0x55738c,
  chamberWireColor: 0x82a9bd,
  fillOpacity: 0.09,
  wireOpacity: 0.36,
  chamberFillOpacity: 0.09,
  chamberWireOpacity: 0.36,
  tubeSegments: 64,
  radialSegments: 9,
  chamberSegments: 18,
  chamberRings: 12,
  createFront: false,
});
const rivalNestScanGroup = rivalNestPresenter.group;
const rivalNestCurves = [];

function addRivalNestTunnel(points, radius, chamberScale, parentSegmentIndex = null) {
  const segmentIndex = rivalNestCurves.length;
  const fromNode = parentSegmentIndex == null
    ? addNestNode(rivalNestGraph, {
      id: `${RIVAL_COLONY_ID}-legacy-entrance`,
      type: 'entrance',
      position: points[0],
      completed: true,
      renderChamber: false,
    })
    : rivalNestGraph.nodes.get(nestEdges(rivalNestGraph)[parentSegmentIndex].toNodeId);
  const toNode = addNestNode(rivalNestGraph, {
    id: `${RIVAL_COLONY_ID}-legacy-chamber-${segmentIndex}`,
    type: 'legacy',
    position: points[points.length - 1],
    completed: true,
    targetScale: chamberScale,
  });
  const edge = addNestEdge(rivalNestGraph, {
    id: `${RIVAL_COLONY_ID}-legacy-tunnel-${segmentIndex}`,
    fromNodeId: fromNode.id,
    toNodeId: toNode.id,
    controlPoints: points,
    radius,
    tension: 0.4,
    progress: 1,
    completed: true,
    chamberScale,
  });
  rivalNestPresenter.syncTopology(rivalNestGraph);
  const curve = rivalNestPresenter.curveFor(edge);
  rivalNestCurves.push(curve);
  return curve;
}

const rivalEntranceY = groundHeight(RIVAL_NEST.x, RIVAL_NEST.y) + 0.04;
addRivalNestTunnel([
  V(RIVAL_NEST.x, rivalEntranceY, RIVAL_NEST.y), V(9.0, -1.2, -5.5), V(8.6, -2.6, -5.1), V(8.4, -3.6, -4.9),
], 0.34, [1.42, 0.56, 1.05]);
const rivalNurseryCurve = addRivalNestTunnel([
  V(8.4, -3.6, -4.9), V(9.4, -4.0, -5.8), V(10.4, -4.5, -6.6), V(11.25, -4.85, -7.15),
], 0.29, [1.62, 0.52, 1.12], 0);
const rivalStoresCurve = addRivalNestTunnel([
  V(8.4, -3.6, -4.9), V(7.5, -3.9, -4.5), V(6.6, -4.15, -4.0), V(5.7, -4.4, -3.75),
], 0.27, [1.48, 0.48, 1.04], 0);
addRivalNestTunnel([
  V(8.4, -3.6, -4.9), V(8.1, -5.0, -3.8), V(8.65, -6.2, -2.5), V(9.0, -7.15, -1.45),
], 0.31, [1.5, 0.55, 1.1], 0);

const rivalNurseryCenter = rivalNurseryCurve.getPointAt(1).clone();
const rivalGranaryVisual = makeGranaryVisual(rivalNestScanGroup, rivalStoresCurve.getPointAt(1), 58, 0xb9c77a);
const rivalQueenSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: antMaterials[2].map, color: 0x7f9eb2, transparent: true, alphaTest: 0.04, depthWrite: false, depthTest: false, fog: false,
}));
rivalQueenSprite.position.copy(rivalNurseryCenter).add(new THREE.Vector3(0.15, 0.08, 0));
rivalQueenSprite.scale.set(1.48, 1.48, 1);
rivalQueenSprite.renderOrder = 10;
rivalNestScanGroup.add(rivalQueenSprite);
const rivalBroodPool = Array.from({ length: 54 }, () => {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 9, 6),
    new THREE.MeshBasicMaterial({ color: 0xd8e1d9, fog: false, depthTest: false }),
  );
  mesh.visible = false;
  mesh.renderOrder = 9;
  rivalNestScanGroup.add(mesh);
  return mesh;
});
const rivalTransferPool = Array.from({ length: 16 }, (_, i) => {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: antMaterials[i % antMaterials.length].map,
    color: 0x708da3,
    transparent: true,
    alphaTest: 0.05,
    depthWrite: false,
    depthTest: false,
    fog: false,
  }));
  sprite.visible = false;
  sprite.renderOrder = 9;
  sprite.userData.workerUid = null;
  rivalNestScanGroup.add(sprite);
  return sprite;
});
const rivalAlateVisualPool = createAlateVisualPool(rivalNestScanGroup, 0x718fa6);
const rivalNestLight = new THREE.PointLight(0x6f9eb8, 16, 11, 2);
rivalNestLight.position.set(8.5, -4.1, -5.0);
rivalNestScanGroup.add(rivalNestLight);

function updateRivalUndergroundVisuals() {
  const queenAlive = rivalColonyRecord?.queen?.alive !== false;
  rivalQueenSprite.visible = queenAlive;
  rivalQueenSprite.material.rotation = 0.24 + Math.sin(simTime * 0.28) * 0.05;
  let visible = 0;
  for (let i = 0; i < rivalBrood.length && visible < rivalBroodPool.length; i++) {
    const item = rivalBrood[i];
    const mesh = rivalBroodPool[visible++];
    const angle = i * 2.399;
    const ring = 0.38 + (i % 9) * 0.08;
    mesh.position.set(
      rivalNurseryCenter.x + Math.cos(angle) * ring - 0.38,
      rivalNurseryCenter.y - 0.1 + Math.sin(i * 1.4) * 0.1,
      rivalNurseryCenter.z + Math.sin(angle) * ring * 0.56,
    );
    const destinyScale = item.destiny === 'gyne' ? 1.35 : item.destiny === 'male' ? 1.08 : 1;
    const scale = (item.stage === 'egg' ? 0.08 : item.stage === 'larva' ? 0.115 : 0.14) * destinyScale;
    mesh.scale.set(scale, scale * (item.stage === 'egg' ? 1.35 : 0.72), scale * 0.8);
    mesh.material.color.setHex(item.destiny === 'gyne' ? 0xc4c88f : item.destiny === 'male' ? 0xb3c3c9
      : item.stage === 'egg' ? 0xe7ece2 : item.stage === 'larva' ? 0xcdd9cb : 0x9dafaa);
    mesh.visible = true;
  }
  for (let i = visible; i < rivalBroodPool.length; i++) rivalBroodPool[i].visible = false;
  let visibleTransfers = 0;
  for (const rival of rivalAnts) {
    if (!rival.insideNest || !rival.transferCargo || visibleTransfers >= rivalTransferPool.length) continue;
    const sprite = rivalTransferPool[visibleTransfers++];
    const progress = 1 - clamp(rival.transferTimer / Math.max(0.1, rival.transferDuration), 0, 1);
    const curve = rivalNestCurves[Math.min(rivalNestCurves.length - 1, progress < 0.62 ? 0 : 1)];
    const localProgress = progress < 0.62 ? progress / 0.62 : (progress - 0.62) / 0.38;
    curve.getPointAt(clamp(localProgress, 0, 1), sprite.position);
    sprite.position.y += Math.sin(rival.phase) * 0.025;
    rival.nestPosition.copy(sprite.position);
    sprite.scale.setScalar(rival.size * 0.34);
    sprite.material.rotation = -rival.heading + Math.PI * 0.5;
    sprite.userData.workerUid = rival.runtimeUid || workerRuntimeUid(rival.colonyId, rival.id);
    sprite.visible = true;
  }
  for (let i = visibleTransfers; i < rivalTransferPool.length; i++) rivalTransferPool[i].visible = false;
  updateAlateVisualPool(rivalAlateVisualPool, rivalReproduction.alates, rivalNurseryCenter, { gyne: 0x698ca7, male: 0x899ba3 });
}

// ---------- Phase 8A: shared, pressure-driven nest architecture ----------
const colonyNestArchitectures = new Map();
const colonyNestPresentations = new Map();
const architectureSpoilGeometry = new THREE.DodecahedronGeometry(0.11, 0);
const architectureSpoilMaterial = new THREE.MeshStandardMaterial({ color: 0x895a3d, roughness: 1, flatShading: true });
const architectureSpoil = [];

function architectureColor(colony) {
  return new THREE.Color(colony.color || 0xa86b48);
}

function createArchitectureNode(architecture, type, position, options = {}) {
  const profile = ARCHITECTURE_TYPES[type] || ARCHITECTURE_TYPES.resting;
  return addNestNode(architecture, {
    type,
    position,
    parentId: options.parentId || null,
    capacity: options.capacity ?? profile.capacity,
    storageCapacity: options.storageCapacity ?? profile.storage,
    completed: options.completed ?? false,
    renderChamber: options.renderChamber !== false,
    targetScale: profile.scale,
  });
}

function createArchitectureEdge(architecture, fromNode, toNode, options = {}) {
  const fromPosition = new THREE.Vector3(fromNode.position.x, fromNode.position.y, fromNode.position.z);
  const toPosition = new THREE.Vector3(toNode.position.x, toNode.position.y, toNode.position.z);
  const delta = new THREE.Vector3().subVectors(toPosition, fromPosition);
  const side = new THREE.Vector3(-delta.z, 0, delta.x).normalize().multiplyScalar(options.bend ?? rand(-0.42, 0.42));
  const points = [
    fromPosition,
    fromPosition.clone().lerp(toPosition, 0.34).add(side),
    fromPosition.clone().lerp(toPosition, 0.68).addScaledVector(side, -0.55),
    toPosition,
  ];
  const radius = ARCHITECTURE_TYPES[toNode.type]?.radius || 0.23;
  const progress = options.progress ?? 0;
  const edge = addNestEdge(architecture, {
    fromNodeId: fromNode.id,
    toNodeId: toNode.id,
    controlPoints: points,
    radius,
    tension: 0.42,
    progress,
    work: 0,
    completed: progress >= 1,
    chamberScale: toNode.targetScale,
  });
  const presentation = colonyNestPresentations.get(architecture.colonyId);
  presentation.presenter.syncTopology(architecture);
  edge.workRequired = Math.max(54, presentation.presenter.curveFor(edge).getLength() * 31);
  edge.work = edge.workRequired * progress;
  return edge;
}

function createArchitectureWorkerPool(architecture, presentation, count = 18) {
  return Array.from({ length: count }, (_, index) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: antMaterials[index % antMaterials.length].map,
      color: presentation.color,
      transparent: true,
      alphaTest: 0.045,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }));
    sprite.visible = false;
    sprite.renderOrder = 10;
    presentation.presenter.group.add(sprite);
    return sprite;
  });
}

function createArchitectureBroodPool(presentation, count = 18) {
  return Array.from({ length: count }, () => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 8, 5),
      new THREE.MeshBasicMaterial({ color: 0xead9b7, depthTest: false, fog: false }),
    );
    mesh.visible = false;
    mesh.renderOrder = 9;
    presentation.presenter.group.add(mesh);
    return mesh;
  });
}

function createColonyArchitecture(colony, options = {}) {
  if (!colony || colonyNestArchitectures.has(colony.id)) return colonyNestArchitectures.get(colony?.id) || null;
  const color = architectureColor(colony);
  const architecture = createNestGraph({
    colonyId: colony.id,
    capacity: {
      habitable: options.baseCapacity || 0,
      brood: options.baseBroodCapacity || 0,
      storage: options.baseStorageCapacity || 0,
    },
  });
  Object.assign(architecture, {
    color: color.getHex(),
    baseChambers: options.baseChambers || 0,
    baseCapacity: options.baseCapacity || 0,
    baseBroodCapacity: options.baseBroodCapacity || 0,
    baseStorageCapacity: options.baseStorageCapacity || 0,
    completedProjects: 0,
    totalExcavated: 0,
    spoilDeposits: 0,
    lastGrowthAt: simTime - 20,
    growthIndex: 0,
    occupancy: 0,
    growthDrive: 0,
    habitableCapacity: options.baseCapacity || 0,
    storageCapacity: options.baseStorageCapacity || 0,
    legacyVisuals: options.legacyVisuals || false,
    founding: options.founding || false,
    circulatingWorkers: [],
    circulationSeconds: 0,
    inspectionTrips: 0,
    visitedChamberIds: new Set(),
  });
  const presentation = {
    color: color.getHex(),
    presenter: createNestPresenter({
      parent: undergroundGroup,
      name: `${colony.id}-living-architecture`,
      color: color.getHex(),
      wireColor: color.clone().offsetHSL(0.02, -0.05, 0.2).getHex(),
    }),
    queenSprite: null,
    workerPool: null,
    broodPool: null,
    released: false,
  };
  colonyNestPresentations.set(colony.id, presentation);
  const rootPosition = options.anchor?.clone() || new THREE.Vector3(colony.nest.x, groundHeight(colony.nest.x, colony.nest.y) - 0.05, colony.nest.y);
  const root = createArchitectureNode(architecture, 'shaft', rootPosition, { completed: true, renderChamber: false, capacity: 0, storageCapacity: 0 });
  architecture.entranceNodeId = root.id;
  if (architecture.founding) {
    const chamber = createArchitectureNode(
      architecture,
      'founding',
      new THREE.Vector3(colony.nest.x + 0.14, groundHeight(colony.nest.x, colony.nest.y) - 0.82, colony.nest.y + 0.1),
      { completed: true, parentId: root.id },
    );
    createArchitectureEdge(architecture, root, chamber, { progress: 1, bend: 0.08 });
    architecture.completedProjects = 1;
    architecture.lastGrowthAt = simTime;
    const queenMaterial = new THREE.SpriteMaterial({
      map: antMaterials[1].map,
      color,
      transparent: true,
      alphaTest: 0.04,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    presentation.queenSprite = new THREE.Sprite(queenMaterial);
    presentation.queenSprite.position.set(chamber.position.x - 0.15, chamber.position.y + 0.08, chamber.position.z);
    presentation.queenSprite.scale.set(0.82, 0.82, 1);
    presentation.queenSprite.renderOrder = 10;
    presentation.presenter.group.add(presentation.queenSprite);
  }
  presentation.workerPool = createArchitectureWorkerPool(architecture, presentation);
  presentation.broodPool = createArchitectureBroodPool(presentation);
  const light = new THREE.PointLight(color, architecture.founding ? 11 : 8, 9, 2);
  light.position.copy(rootPosition).add(new THREE.Vector3(0, -1.2, 0));
  presentation.presenter.group.add(light);
  colonyNestArchitectures.set(colony.id, architecture);
  colony.architecture = architecture;
  colony.undergroundView = true;
  colony.undergroundFocusY = architecture.founding ? chamberDepth(architecture) : rootPosition.y;
  colony.undergroundDistance = architecture.founding ? 7.2 : colony.undergroundDistance || 10.8;
  return architecture;
}

function chamberDepth(architecture) {
  return nestNodes(architecture).reduce((depth, node) => Math.min(depth, node.position.y), 0);
}

function architectureNodeById(architecture, id) {
  return architecture.nodes.get(id) || null;
}

function architecturePressure(architecture, colony) {
  if (architecture.pressureTopologyRevision !== architecture.graphRevision) {
    const completedNodes = nestNodes(architecture).filter((node) => node.completed);
    architecture.pressureHabitableCapacity = architecture.baseCapacity
      + completedNodes.reduce((sum, node) => sum + node.capacity, 0);
    architecture.pressureStorageCapacity = architecture.baseStorageCapacity
      + completedNodes.reduce((sum, node) => sum + node.storageCapacity, 0);
    architecture.pressureTopologyRevision = architecture.graphRevision;
  }
  const pressure = calculateArchitecturePressure(architecture, colony, {
    livingWorkerCount: workerCensus.colonyCount(colony.id),
    habitableCapacity: architecture.pressureHabitableCapacity,
    storageCapacity: architecture.pressureStorageCapacity,
  });
  architecture.habitableCapacity = pressure.habitableCapacity;
  architecture.storageCapacity = pressure.storageCapacity;
  architecture.occupancy = pressure.occupancy;
  architecture.storagePressure = pressure.storagePressure;
  architecture.usefulStoragePressure = pressure.usefulStoragePressure;
  architecture.reserveRatio = pressure.reserveRatio;
  architecture.growthDrive = pressure.growthDrive;
  return {
    workers: pressure.workers,
    workerCount: pressure.workerCount,
    brood: pressure.brood,
    storagePressure: pressure.storagePressure,
    usefulStoragePressure: pressure.usefulStoragePressure,
    reserveRatio: pressure.reserveRatio,
    broodPressure: pressure.broodPressure,
  };
}

function colonyFoodStorageCapacity(colonyId) {
  return foodStorageCapacity(getColony(colonyId));
}

function acceptColonyStoredFood(colonyId, current, incoming = 0) {
  const capacity = colonyFoodStorageCapacity(colonyId);
  const { next, overflow } = calculateStoredFoodAcceptance(current, incoming, capacity);
  if (overflow > 0) ecologicalBalance.storageOverflow.set(
    colonyId,
    Number(((ecologicalBalance.storageOverflow.get(colonyId) || 0) + overflow).toFixed(2)),
  );
  return next;
}

function consumeColonyStoredFood(colonyId, current, dt, workerCount, options = {}) {
  const colony = getColony(colonyId);
  const completedGranaries = nestNodes(colony?.architecture)
    .filter((node) => node.completed && node.type === 'granary').length || 0;
  const { next, metabolized, spoiled } = calculateStoredFoodConsumption({
    current,
    dt,
    workerCount,
    workerRate: options.workerRate,
    baseRate: options.baseRate,
    seasonName: environment.season.name,
    completedGranaries,
    postRainHumidity: weather.postRainHumidity,
    rain: weather.rain,
  });

  ecologicalBalance.storedFoodMetabolized.set(
    colonyId,
    (ecologicalBalance.storedFoodMetabolized.get(colonyId) || 0) + metabolized,
  );
  ecologicalBalance.storedFoodSpoiled.set(
    colonyId,
    (ecologicalBalance.storedFoodSpoiled.get(colonyId) || 0) + spoiled,
  );
  return next;
}

function demographicStateFor(colony, careRatio = 1) {
  return calculateDemographicState({
    colony,
    careRatio,
    workerCapacity: architectureWorkerCapacity(colony?.architecture),
    broodCapacity: architectureBroodCapacity(colony?.architecture),
    seasonName: environment.season.name,
    environmentPressure: environment.pressure,
  });
}

function startArchitectureProject(architecture, colony, pressure) {
  const nodes = nestNodes(architecture);
  const availableParents = nodes
    .filter((node) => node.completed && node.renderChamber && node.children < 2)
    .sort((a, b) => a.children - b.children || a.position.y - b.position.y);
  const root = architectureNodeById(architecture, architecture.entranceNodeId);
  const parent = availableParents[Math.floor(random() * Math.min(3, availableParents.length))]
    || nodes.filter((node) => node.completed).sort((a, b) => a.position.y - b.position.y)[0]
    || root;
  const type = chooseArchitectureChamberType(architecture, pressure);
  let candidate = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const angle = architecture.growthIndex * 2.399 + attempt * 0.83 + (colony.id.length % 7) * 0.31;
    const horizontal = type === 'shaft' ? rand(0.7, 1.35) : rand(2.15, 3.4);
    const depthDrop = type === 'shaft' ? rand(1.75, 2.5) : rand(0.62, 1.35);
    const y = parent.position.y < -11.4 ? parent.position.y + rand(0.2, 0.65) : parent.position.y - depthDrop;
    const trial = new THREE.Vector3(
      clamp(parent.position.x + Math.cos(angle) * horizontal, -HALF_W + 1, HALF_W - 1),
      Math.max(-12.4, y),
      clamp(parent.position.z + Math.sin(angle) * horizontal, -HALF_D + 1, HALF_D - 1),
    );
    if (nodes.every((node) => Math.hypot(
      node.position.x - trial.x,
      node.position.y - trial.y,
      node.position.z - trial.z,
    ) > 1.45)) { candidate = trial; break; }
  }
  if (!candidate) return null;
  const node = createArchitectureNode(architecture, type, candidate, { parentId: parent.id });
  const edge = createArchitectureEdge(architecture, parent, node);
  if (colony.status !== 'mature') {
    const youngScale = colony.status === 'young' ? 0.58 : 0.78;
    node.capacity = Math.max(6, Math.round(node.capacity * youngScale));
    node.storageCapacity = Math.max(1, Math.round(node.storageCapacity * youngScale));
    const scale = colony.status === 'young' ? 0.74 : 0.86;
    node.targetScale.x *= scale;
    node.targetScale.y *= scale;
    node.targetScale.z *= scale;
    edge.chamberScale = { ...node.targetScale };
    edge.workRequired *= colony.status === 'young' ? 0.44 : 0.68;
    markNestGraphChanged(architecture);
  }
  architecture.growthIndex++;
  architecture.lastGrowthAt = simTime;
  return edge;
}

function depositArchitectureSpoil(architecture, colony) {
  for (let i = 0; i < 5 && architectureSpoil.length < 260; i++) {
    const angle = (architecture.spoilDeposits * 5 + i) * 2.399;
    const radius = 0.85 + ((architecture.spoilDeposits + i) % 6) * 0.16;
    const x = colony.nest.x + Math.cos(angle) * radius;
    const z = colony.nest.y + Math.sin(angle) * radius * 0.78;
    const clod = new THREE.Mesh(architectureSpoilGeometry, architectureSpoilMaterial);
    clod.position.set(x, groundHeight(x, z) + 0.055, z);
    clod.scale.set(rand(0.48, 1.08), rand(0.36, 0.72), rand(0.5, 1.1));
    clod.rotation.set(rand(0, Math.PI), rand(0, Math.PI), rand(0, Math.PI));
    clod.castShadow = clod.receiveShadow = true;
    surfaceGroup.add(clod);
    architectureSpoil.push(clod);
  }
  architecture.spoilDeposits++;
}

function architectureAssignedDiggers(colony, edge) {
  if (!edge) return [];
  const assignedIds = new Set(edge.activeDiggerIds || []);
  return colony.workers.filter((worker) => assignedIds.has(workerDisplayId(worker)));
}

function advanceArchitectureCirculation(architecture, colony, dt, assignedDiggers = []) {
  const completedEdges = nestEdges(architecture).filter((edge) => edge.completed);
  if (completedEdges.length === 0) {
    architecture.circulatingWorkers = [];
    return;
  }
  const diggers = new Set(assignedDiggers);
  const insideWorkers = colony.workers.filter((worker) => worker.alive !== false && worker.insideNest && !diggers.has(worker));
  const desired = Math.min(60, Math.max(3, Math.ceil(insideWorkers.length * 0.34)));
  const active = insideWorkers.filter((worker) => worker.architectureCirculation?.dutyUntil > simTime);
  const recruits = insideWorkers
    .filter((worker) => !active.includes(worker))
    .sort((a, b) => ((a.id * 37 + Math.floor(simTime / 18)) % 101) - ((b.id * 37 + Math.floor(simTime / 18)) % 101));
  while (active.length < desired && recruits.length > 0) {
    const worker = recruits.shift();
    worker.architectureCirculation ||= {
      currentNodeId: architecture.entranceNodeId,
      previousNodeId: null,
      edgeId: null,
      direction: 1,
      t: 0,
      pause: rand(0.2, 1.5),
      position: new THREE.Vector3(
        architectureNodeById(architecture, architecture.entranceNodeId).position.x,
        architectureNodeById(architecture, architecture.entranceNodeId).position.y,
        architectureNodeById(architecture, architecture.entranceNodeId).position.z,
      ),
      heading: 0,
      visits: 0,
      visitedNodeIds: new Set([architecture.entranceNodeId]),
      dutyUntil: 0,
    };
    worker.architectureCirculation.dutyUntil = simTime + rand(24, 52);
    active.push(worker);
  }

  architecture.circulatingWorkers = active;
  architecture.circulationSeconds += active.length * dt;
  for (const worker of active) {
    const route = worker.architectureCirculation;
    route.pause -= dt;
    if (!route.edgeId && route.pause <= 0) {
      const adjacent = completedEdges.filter((edge) => edge.fromNodeId === route.currentNodeId || edge.toNodeId === route.currentNodeId);
      const forwardChoices = adjacent.filter((edge) => {
        const destination = edge.fromNodeId === route.currentNodeId ? edge.toNodeId : edge.fromNodeId;
        return destination !== route.previousNodeId;
      });
      const choices = forwardChoices.length > 0 ? forwardChoices : adjacent;
      choices.sort((a, b) => {
        const aDestination = a.fromNodeId === route.currentNodeId ? a.toNodeId : a.fromNodeId;
        const bDestination = b.fromNodeId === route.currentNodeId ? b.toNodeId : b.fromNodeId;
        return Number(route.visitedNodeIds.has(aDestination)) - Number(route.visitedNodeIds.has(bDestination))
          || ((worker.id + aDestination * 13) % 17) - ((worker.id + bDestination * 13) % 17);
      });
      const edge = choices[0];
      if (edge) {
        route.edgeId = edge.id;
        route.direction = edge.fromNodeId === route.currentNodeId ? 1 : -1;
        route.t = route.direction > 0 ? 0 : 1;
      } else route.pause = rand(0.8, 2.2);
    }
    const edge = route.edgeId ? completedEdges.find((candidate) => candidate.id === route.edgeId) : null;
    if (!edge) {
      const node = architectureNodeById(architecture, route.currentNodeId) || architectureNodeById(architecture, architecture.entranceNodeId);
      route.position.set(node.position.x, node.position.y, node.position.z);
      continue;
    }
    const curve = colonyNestPresentations.get(architecture.colonyId).presenter.curveFor(edge);
    const length = Math.max(0.5, curve.getLength());
    route.t = clamp(route.t + route.direction * dt * (worker.speed || 0.8) * 0.42 / length, 0, 1);
    curve.getPointAt(route.t, route.position);
    const tangent = curve.getTangentAt(route.t);
    route.heading = Math.atan2(tangent.z, tangent.x) + (route.direction < 0 ? Math.PI : 0);
    const arrived = route.direction > 0 ? route.t >= 0.999 : route.t <= 0.001;
    if (arrived) {
      const origin = route.currentNodeId;
      route.currentNodeId = route.direction > 0 ? edge.toNodeId : edge.fromNodeId;
      route.previousNodeId = origin;
      route.edgeId = null;
      route.pause = rand(0.35, 2.4);
      route.visits++;
      route.visitedNodeIds.add(route.currentNodeId);
      architecture.visitedChamberIds.add(route.currentNodeId);
      architecture.inspectionTrips++;
      worker.nestExplorationTrips = (worker.nestExplorationTrips || 0) + 1;
    }
  }
}

function updateArchitectureVisual(architecture, colony) {
  const presentation = colonyNestPresentations.get(architecture.colonyId);
  if (!presentation || presentation.released) return;
  const edges = nestEdges(architecture);
  const nodes = nestNodes(architecture);
  const activeEdge = edges.find((edge) => !edge.completed) || null;
  presentation.presenter.syncGraph(architecture, {
    visible: cameraRig.focusedColonyId === architecture.colonyId,
    simTime,
    activeFrontIds: activeEdge ? [activeEdge.id] : [],
  });

  const workers = colony.workers.filter((worker) => worker.alive !== false && worker.insideNest);
  let visibleWorkers = 0;
  const assigned = architectureAssignedDiggers(colony, activeEdge).filter((worker) => worker.insideNest);
  const activeCurve = activeEdge ? presentation.presenter.curveFor(activeEdge) : null;
  for (let i = 0; i < assigned.length && visibleWorkers < presentation.workerPool.length; i++) {
    const worker = assigned[i];
    const sprite = presentation.workerPool[visibleWorkers++];
    sprite.userData.workerUid = worker.runtimeUid || workerRuntimeUid(worker.colonyId, worker.id);
    activeCurve.getPointAt(Math.max(0.012, activeEdge.progress), sprite.position);
    const angle = i * 2.399 + simTime * 0.8;
    sprite.position.add(new THREE.Vector3(Math.cos(angle) * 0.22, Math.sin(angle * 1.4) * 0.1, Math.sin(angle) * 0.22));
    sprite.scale.setScalar((worker.size || 0.8) * 0.38);
    sprite.material.rotation = angle;
    sprite.visible = true;
  }
  const circulating = architecture.circulatingWorkers.filter((worker) => !assigned.includes(worker));
  for (let i = 0; i < circulating.length && visibleWorkers < presentation.workerPool.length; i++) {
    const worker = circulating[i];
    const route = worker.architectureCirculation;
    const sprite = presentation.workerPool[visibleWorkers++];
    sprite.userData.workerUid = worker.runtimeUid || workerRuntimeUid(worker.colonyId, worker.id);
    sprite.position.copy(route.position);
    sprite.position.y += Math.sin(simTime * 4.2 + worker.id) * 0.035;
    sprite.scale.setScalar((worker.size || 0.72) * 0.37);
    sprite.material.rotation = -route.heading;
    sprite.visible = true;
  }
  if (!architecture.legacyVisuals) {
    const chamberNodes = nodes.filter((node) => node.completed && node.renderChamber);
    for (let i = 0; i < workers.length && visibleWorkers < presentation.workerPool.length && chamberNodes.length > 0; i++) {
      const worker = workers[i];
      if (assigned.includes(worker) || circulating.includes(worker)) continue;
      const sprite = presentation.workerPool[visibleWorkers++];
      sprite.userData.workerUid = worker.runtimeUid || workerRuntimeUid(worker.colonyId, worker.id);
      const node = chamberNodes[i % chamberNodes.length];
      const angle = i * 2.399 + simTime * (0.03 + (i % 4) * 0.008);
      sprite.position.set(
        node.position.x + Math.cos(angle) * 0.42,
        node.position.y + Math.sin(simTime + i) * 0.08,
        node.position.z + Math.sin(angle) * 0.3,
      );
      sprite.scale.setScalar((worker.size || 0.72) * 0.36);
      sprite.material.rotation = -angle;
      sprite.visible = true;
    }
  }
  for (let i = visibleWorkers; i < presentation.workerPool.length; i++) presentation.workerPool[i].visible = false;

  const brood = colony.brood || [];
  const nurseryNodes = nodes.filter((node) => node.completed && (node.type === 'nursery' || node.type === 'founding'));
  let visibleBrood = 0;
  if (!architecture.legacyVisuals && nurseryNodes.length > 0) for (let i = 0; i < brood.length && visibleBrood < presentation.broodPool.length; i++) {
    const item = brood[i];
    const mesh = presentation.broodPool[visibleBrood++];
    const node = nurseryNodes[i % nurseryNodes.length];
    const angle = i * 2.399;
    mesh.position.set(
      node.position.x + Math.cos(angle) * 0.34,
      node.position.y - 0.1 + Math.sin(i) * 0.05,
      node.position.z + Math.sin(angle) * 0.24,
    );
    const scale = item.stage === 'egg' ? 0.075 : item.stage === 'larva' ? 0.105 : 0.13;
    mesh.scale.set(scale, scale * (item.stage === 'egg' ? 1.35 : 0.72), scale * 0.82);
    mesh.material.color.setHex(item.stage === 'egg' ? 0xeee2c6 : item.stage === 'larva' ? 0xd9c59f : 0xb99b78);
    mesh.visible = true;
  }
  for (let i = visibleBrood; i < presentation.broodPool.length; i++) presentation.broodPool[i].visible = false;
  if (presentation.queenSprite) presentation.queenSprite.visible = colony.queen?.alive !== false;
}

function releaseColonyNestPresentation(architecture) {
  const presentation = colonyNestPresentations.get(architecture.colonyId);
  if (!presentation || presentation.released) return;
  presentation.workerPool.forEach((sprite) => sprite.material.dispose());
  presentation.broodPool.forEach((mesh) => {
    mesh.geometry.dispose();
    mesh.material.dispose();
  });
  presentation.queenSprite?.material?.dispose();
  presentation.presenter.release();
  presentation.released = true;
}

function updateColonyArchitectures(dt) {
  const totalStartedAt = profiler.clock();
  let presentationMs = 0;
  const presentingUnderground = viewState.undergroundBlend > 0.035 || cameraRig.desiredPitch < -0.1;
  for (const architecture of colonyNestArchitectures.values()) {
    const colony = getColony(architecture.colonyId);
    if (!colony || colony.status === 'extinct') {
      releaseColonyNestPresentation(architecture);
      continue;
    }
    const pressure = architecturePressure(architecture, colony);
    let activeEdge = nestEdges(architecture).find((edge) => !edge.completed) || null;
    const canExpand = colony.status === 'mature' || colony.status === 'young' || colony.status === 'established';
    const interval = colony.status === 'mature' ? 9 : 14;
    if (!activeEdge && canExpand && architecture.nodes.size < 50
      && simTime - architecture.lastGrowthAt > interval && architecture.growthDrive > 0.64) {
      activeEdge = startArchitectureProject(architecture, colony, pressure);
    }
    if (activeEdge) {
      const livingWorkers = colony.workers.filter((worker) => worker.alive !== false);
      const desired = clamp(Math.ceil(pressure.workerCount * (colony.status === 'mature' ? 0.038 : 0.09)), 1, 12);
      const candidates = livingWorkers
        .filter((worker) => !worker.carrying && !worker.transferCargo && !worker.sanitationCargo)
        .sort((a, b) => Number(Boolean(b.insideNest)) - Number(Boolean(a.insideNest))
          || Number((b.assignedRole || b.role) === 'excavator') - Number((a.assignedRole || a.role) === 'excavator')
          || (b.energy || 50) - (a.energy || 50));
      const activeDiggers = candidates.slice(0, desired);
      activeEdge.activeDiggerIds = activeDiggers.map((worker) => workerDisplayId(worker));
      const labor = activeDiggers.reduce((sum, worker) => sum
        + (worker.genome?.speed || 1) * (worker.genome?.size || 1) * (0.58 + (worker.energy || 50) * 0.004), 0);
      const foodFactor = clamp((colony.storedFood - 2) / 28, colony.status === 'mature' ? 0.16 : 0.3, 1);
      const seasonFactor = environment.season.name === 'winter' ? 0.46 : environment.season.name === 'autumn' ? 0.82 : 1;
      const work = dt * labor * foodFactor * seasonFactor;
      const nextWork = Math.min(activeEdge.workRequired, activeEdge.work + work);
      updateNestEdgeProgress(architecture, activeEdge, clamp(nextWork / activeEdge.workRequired, 0.012, 1), { work: nextWork });
      architecture.totalExcavated += work;
      for (const worker of activeDiggers) worker.architectureAssignment = activeEdge.id;
      if (activeEdge.progress >= 1) {
        activeDiggers.forEach((worker) => { worker.architectureAssignment = null; });
        activeEdge.activeDiggerIds = [];
        const node = architectureNodeById(architecture, activeEdge.toNodeId);
        if (node) node.completed = true;
        markNestGraphChanged(architecture);
        architecture.completedProjects++;
        architecture.lastGrowthAt = simTime;
        depositArchitectureSpoil(architecture, colony);
        createSignal(colony.nest.x, colony.nest.y, architecture.color);
      }
    }
    advanceArchitectureCirculation(architecture, colony, dt, architectureAssignedDiggers(colony, activeEdge));
    colony.undergroundFocusY = Math.max(-9.2, chamberDepth(architecture) * 0.72);
    colony.undergroundDistance = architecture.founding
      ? clamp(4.45 + architecture.nodes.size * 0.34, 5.35, 9.4)
      : clamp(6.8 + (architecture.baseChambers + architecture.nodes.size) * 0.72, 7.2, 14.5);
    if (cameraRig.focusedColonyId === colony.id && cameraRig.desiredPitch < -0.1) {
      const nodes = nestNodes(architecture);
      const centroid = nodes.reduce((sum, node) => sum.add(new THREE.Vector3(node.position.x, node.position.y, node.position.z)), new THREE.Vector3())
        .multiplyScalar(1 / Math.max(1, nodes.length));
      const follow = Math.min(1, dt * 0.9);
      cameraRig.target.x += (centroid.x - cameraRig.target.x) * follow;
      cameraRig.target.z += (centroid.z - cameraRig.target.z) * follow;
      cameraRig.desiredDistance += (colony.undergroundDistance - cameraRig.desiredDistance) * follow;
    }
    const nestPresentation = colonyNestPresentations.get(architecture.colonyId);
    const shouldPresent = presentingUnderground && cameraRig.focusedColonyId === architecture.colonyId;
    if (nestPresentation && !nestPresentation.released) nestPresentation.presenter.group.visible = shouldPresent;
    if (shouldPresent) {
      const presentationStartedAt = profiler.clock();
      updateArchitectureVisual(architecture, colony);
      presentationMs += profiler.clock() - presentationStartedAt;
    }
  }
  const totalMs = profiler.clock() - totalStartedAt;
  profiler.record('architecturePresentation', presentationMs);
  profiler.record('architectureSimulation', Math.max(0, totalMs - presentationMs));
}

undergroundGroup.add(new THREE.AmbientLight(0x9a735a, 1.2));
const nestGlowA = new THREE.PointLight(0xe09a58, 22, 13, 2);
nestGlowA.position.set(-5.2, -3.8, -0.8);
homeNestScanGroup.add(nestGlowA);
const nestGlowB = new THREE.PointLight(0x7b8fc2, 15, 15, 2);
nestGlowB.position.set(-3.5, -9.2, 0.4);
homeNestScanGroup.add(nestGlowB);

const digMoteCount = 96;
const digMoteData = new Float32Array(digMoteCount * 3);
const digMoteGeometry = new THREE.BufferGeometry();
digMoteGeometry.setAttribute('position', new THREE.BufferAttribute(digMoteData, 3));
const digMotes = new THREE.Points(digMoteGeometry, new THREE.PointsMaterial({
  color: 0xffcc7b, size: 0.075, transparent: true, opacity: 0.66, depthWrite: false, fog: false,
}));
digMotes.visible = false;
homeNestScanGroup.add(digMotes);

const undergroundSpritePool = Array.from({ length: UNDERGROUND_WORKER_RENDER_LIMIT }, (_, i) => {
  const material = new THREE.SpriteMaterial({
    map: antMaterials[i % antMaterials.length].map,
    color: 0x5c241d,
    transparent: true,
    alphaTest: 0.055,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const sprite = new THREE.Sprite(material);
  const size = rand(0.68, 0.86);
  sprite.scale.set(size, size, 1);
  sprite.userData = { antId: null };
  sprite.renderOrder = 8;
  homeNestScanGroup.add(sprite);
  return sprite;
});

const undergroundSoilPool = Array.from({ length: 64 }, () => {
  const pellet = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.095, 0),
    new THREE.MeshBasicMaterial({ color: 0xb47748, fog: false, depthTest: false }),
  );
  pellet.visible = false;
  pellet.renderOrder = 9;
  homeNestScanGroup.add(pellet);
  return pellet;
});

const undergroundFoodPool = Array.from({ length: 48 }, () => {
  const food = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.09, 0),
    new THREE.MeshBasicMaterial({ color: 0xe0bd68, fog: false, depthTest: false }),
  );
  food.visible = false;
  food.renderOrder = 9;
  homeNestScanGroup.add(food);
  return food;
});

const nurseryCenter = homeNestCurve(1).getPointAt(1).clone();
const queenMaterial = new THREE.SpriteMaterial({
  map: antMaterials[1].map,
  color: 0x8e392d,
  transparent: true,
  alphaTest: 0.04,
  depthWrite: false,
  depthTest: false,
  fog: false,
});
const queenSprite = new THREE.Sprite(queenMaterial);
queenSprite.position.copy(nurseryCenter).add(new THREE.Vector3(-0.22, 0.12, 0));
queenSprite.scale.set(1.52, 1.52, 1);
queenSprite.renderOrder = 10;
homeNestScanGroup.add(queenSprite);

const queenHalo = new THREE.Mesh(
  new THREE.RingGeometry(0.58, 0.67, 30),
  new THREE.MeshBasicMaterial({ color: 0xe9b66d, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthTest: false, fog: false }),
);
queenHalo.position.copy(nurseryCenter).add(new THREE.Vector3(-0.22, -0.12, 0));
queenHalo.rotation.x = Math.PI / 2;
queenHalo.renderOrder = 9;
homeNestScanGroup.add(queenHalo);

const broodPool = Array.from({ length: 96 }, () => {
  const brood = new THREE.Mesh(
    new THREE.SphereGeometry(1, 10, 7),
    new THREE.MeshBasicMaterial({ color: 0xf1dfb6, fog: false, depthTest: false }),
  );
  brood.visible = false;
  brood.renderOrder = 9;
  homeNestScanGroup.add(brood);
  return brood;
});
const homeAlateVisualPool = createAlateVisualPool(homeNestScanGroup, 0x84382e);

function updateBiologicalVisuals() {
  const queenAlive = homeColonyRecord?.queen?.alive !== false;
  queenSprite.visible = queenAlive;
  queenHalo.visible = queenAlive;
  queenSprite.material.rotation = Math.sin(simTime * 0.34) * 0.055 - 0.25;
  queenHalo.rotation.z = simTime * 0.08;
  queenHalo.scale.setScalar(0.96 + Math.sin(simTime * 1.2) * 0.035);
  let visibleBrood = 0;
  for (const item of brood) {
    if (visibleBrood >= broodPool.length) break;
    const mesh = broodPool[visibleBrood++];
    const angle = item.id * 2.399;
    const ring = 0.38 + (item.id % 11) * 0.075;
    mesh.position.set(
      nurseryCenter.x + Math.cos(angle) * ring + 0.42,
      nurseryCenter.y - 0.12 + Math.sin(item.id * 1.71) * 0.12,
      nurseryCenter.z + Math.sin(angle) * ring * 0.56,
    );
    const stageScale = item.stage === 'egg'
      ? new THREE.Vector3(0.075, 0.115, 0.075)
      : item.stage === 'larva'
        ? new THREE.Vector3(0.13, 0.09, 0.08)
        : new THREE.Vector3(0.15, 0.075, 0.08);
    const destinyScale = item.destiny === 'gyne' ? 1.35 : item.destiny === 'male' ? 1.08 : 1;
    mesh.scale.copy(stageScale).multiplyScalar(destinyScale * (0.94 + Math.sin(simTime * 1.5 + item.id) * 0.035));
    mesh.material.color.setHex(item.destiny === 'gyne' ? 0xe3bd68 : item.destiny === 'male' ? 0xc8c5b6
      : item.stage === 'egg' ? 0xf4e7c6 : item.stage === 'larva' ? 0xe9cf9f : 0xc9a879);
    mesh.visible = true;
  }
  for (let i = visibleBrood; i < broodPool.length; i++) broodPool[i].visible = false;
  updateAlateVisualPool(homeAlateVisualPool, homeReproduction.alates, nurseryCenter, { gyne: 0x9d4032, male: 0x74635a });
}

function updateEntranceVisuals() {
  const visibleItems = Math.min(entranceBiology.cache.length, entranceCachePool.length);
  for (let i = 0; i < visibleItems; i++) {
    const item = entranceCachePool[i];
    const cached = entranceBiology.cache[i];
    const angle = i * 2.399;
    const radius = 0.1 + (i % 8) * 0.047;
    item.position.set(
      vestibuleCenter.x + Math.cos(angle) * radius,
      vestibuleCenter.y - 0.18 + (i % 3) * 0.035,
      vestibuleCenter.z + Math.sin(angle) * radius * 0.62,
    );
    item.scale.set(1, cached.kind === 'berry' ? 1.15 : 0.66, cached.kind === 'beetle' ? 1.3 : 0.86);
    item.material.color.setHex(cached.kind === 'berry' ? 0xa86453 : cached.kind === 'beetle' ? 0x826346 : cached.kind === 'crumb' ? 0xd9c187 : 0xd7b360);
    item.visible = true;
  }
  for (let i = visibleItems; i < entranceCachePool.length; i++) entranceCachePool[i].visible = false;
  const activity = clamp(entranceBiology.activation + entranceBiology.waitingForagers * 0.025, 0, 1);
  vestibuleSignal.material.opacity = 0.08 + activity * 0.46;
  vestibuleSignal.scale.setScalar(0.88 + activity * 0.42 + Math.sin(simTime * 3.2) * 0.035);
  vestibuleSignal.rotation.z = simTime * (0.12 + activity * 0.22);
}

function representativeWorkerSample(workers, limit, priority = null) {
  if (workers.length <= limit) return workers;
  const sampled = [];
  const stride = workers.length / limit;
  for (let i = 0; i < limit; i++) sampled.push(workers[Math.floor((i + 0.5) * stride)]);
  if (priority && workers.includes(priority) && !sampled.includes(priority)) sampled[sampled.length - 1] = priority;
  return sampled;
}

function updateUnderground() {
  const presentingUnderground = viewState.undergroundBlend > 0.035 || cameraRig.desiredPitch < -0.1;
  const focusedColonyId = cameraRig.focusedColonyId;
  homeNestScanGroup.visible = presentingUnderground && focusedColonyId === HOME_COLONY_ID;
  rivalNestScanGroup.visible = presentingUnderground && focusedColonyId === RIVAL_COLONY_ID;
  if (!presentingUnderground) {
    adaptiveVisualState.renderedUndergroundWorkers = 0;
    return;
  }
  if (focusedColonyId === RIVAL_COLONY_ID) {
    rivalNestPresenter.syncGraph(rivalNestGraph, { visible: true, simTime });
    rivalGranaryVisual.count = Math.min(rivalGranaryVisual.instanceMatrix.count, Math.floor(rivalSeedBank.current));
    updateRivalUndergroundVisuals();
    adaptiveVisualState.renderedUndergroundWorkers = rivalTransferPool
      .reduce((count, sprite) => count + Number(sprite.visible), 0);
    return;
  }
  if (focusedColonyId !== HOME_COLONY_ID) {
    adaptiveVisualState.renderedUndergroundWorkers = 0;
    return;
  }
  const active = tunnelSegments.filter((segment, segmentIndex) => (
    segmentIndex >= 4 && segment.available && segment.progress < 0.995 && segment.activeDiggers > 0
  ));
  homeNestPresenter.syncGraph(homeNestGraph, {
    visible: cameraRig.focusedColonyId === HOME_COLONY_ID,
    simTime,
    frontFilter: (segment) => tunnelSegments.indexOf(segment) >= 4 && segment.available && segment.progress < 0.995,
    activeFrontIds: active.map((segment) => segment.id),
  });
  homeGranaryVisual.count = Math.min(homeGranaryVisual.instanceMatrix.count, Math.floor(homeSeedBank.current));
  const tipPosition = new THREE.Vector3();

  digMotes.visible = active.length > 0;
  if (active.length > 0) {
    const positions = digMoteGeometry.attributes.position.array;
    for (let i = 0; i < digMoteCount; i++) {
      const segment = active[i % active.length];
      homeNestCurve(segment).getPointAt(segment.progress, tipPosition);
      const angle = i * 2.399 + simTime * (0.35 + (i % 5) * 0.05);
      const radius = 0.08 + ((i * 17) % 19) * 0.018;
      positions[i * 3] = tipPosition.x + Math.cos(angle) * radius;
      positions[i * 3 + 1] = tipPosition.y + Math.sin(angle * 1.7) * radius + Math.sin(simTime + i) * 0.04;
      positions[i * 3 + 2] = tipPosition.z + Math.sin(angle) * radius;
    }
    digMoteGeometry.attributes.position.needsUpdate = true;
  }

  let visibleNestAnts = 0;
  let visibleSoilLoads = 0;
  let visibleFoodLoads = 0;
  const interiorWorkers = ants.filter((ant) => ant.insideNest && ant.nestPosition);
  const representativeWorkers = representativeWorkerSample(
    interiorWorkers,
    Math.min(undergroundSpritePool.length, adaptiveVisualState.undergroundRepresentativeLimit),
    selectedAnt?.colonyId === HOME_COLONY_ID ? selectedAnt : null,
  );
  for (const ant of representativeWorkers) {
    const sprite = undergroundSpritePool[visibleNestAnts++];
    sprite.position.copy(ant.nestPosition);
    sprite.position.y += Math.sin(ant.phase * 0.5) * 0.025;
    const size = ant.size * (ant === selectedAnt ? 0.48 : 0.32);
    sprite.scale.set(size, size, 1);
    sprite.material.rotation = -ant.nestHeading + Math.PI * 0.5;
    sprite.material.color.setHex(ant === selectedAnt ? 0xffc66e : 0x6f2d24);
    sprite.userData.workerUid = ant.runtimeUid || workerRuntimeUid(ant.colonyId, ant.id);
    sprite.visible = true;
    if (ant.soilCargo && visibleSoilLoads < undergroundSoilPool.length) {
      const pellet = undergroundSoilPool[visibleSoilLoads++];
      pellet.position.copy(sprite.position);
      pellet.position.x += Math.cos(ant.nestHeading || 0) * 0.16;
      pellet.position.z += Math.sin(ant.nestHeading || 0) * 0.16;
      pellet.visible = true;
    }
    if ((ant.transferCargo || ant.pendingDelivery) && visibleFoodLoads < undergroundFoodPool.length) {
      const food = undergroundFoodPool[visibleFoodLoads++];
      food.position.copy(sprite.position);
      food.position.x += Math.cos(ant.nestHeading || 0) * 0.15;
      food.position.z += Math.sin(ant.nestHeading || 0) * 0.15;
      food.material.color.setHex(ant.transferCargo?.kind === 'berry' ? 0xa86453 : ant.transferCargo?.kind === 'beetle' ? 0x826346 : 0xe0bd68);
      food.visible = true;
    }
  }
  for (let i = visibleNestAnts; i < undergroundSpritePool.length; i++) undergroundSpritePool[i].visible = false;
  for (let i = visibleSoilLoads; i < undergroundSoilPool.length; i++) undergroundSoilPool[i].visible = false;
  for (let i = visibleFoodLoads; i < undergroundFoodPool.length; i++) undergroundFoodPool[i].visible = false;
  adaptiveVisualState.renderedUndergroundWorkers = visibleNestAnts;
  updateBiologicalVisuals();
  updateEntranceVisuals();
}

const ants = [];
let nextAntId = 1;
const brood = [];
let nextBroodId = 1;
let queenLayClock = 5;
let queenEggsLaid = 0;
let workersEclosed = 0;
const colonyBiology = {
  activeNurses: 0,
  requiredNurses: 0,
  starvedLarvae: 0,
  broodDeaths: 0,
  technicalBlockedEclosions: 0,
};
const entranceBiology = {
  cache: [],
  capacity: 72,
  activation: 0.24,
  recentReturns: 0,
  waitingForagers: 0,
  activeTransfers: 0,
  foodReturned: 0,
  cacheDeposits: 0,
  contactEvents: 0,
  activatedDepartures: 0,
  withheldDepartures: 0,
  storageTransfers: 0,
};
for (let i = 0; i < 5; i++) entranceBiology.cache.push({ kind: 'seed', nutrition: 1, value: 1.35 });

const homeReproduction = createQueenReproduction('amber', homeQueenGenome, 4);
const rivalReproduction = createQueenReproduction('slate', rivalQueenGenome, 5);

function updateAlateCohort(reproduction, dt) {
  for (const alate of reproduction.alates) {
    Object.assign(alate, nextAlateState(alate, dt, environment.season.name, weather.rain));
  }
}

function addBrood(stage = 'egg', stageAge = 0, genome = null, generation = 1, options = {}) {
  if (brood.length >= TECHNICAL_BROOD_LIMIT) return null;
  const destiny = options.destiny || 'worker';
  const inherited = genome ? {
    sex: destiny === 'male' ? 'male' : 'female',
    destiny,
    genome,
    parentage: options.parentage || { damId: 'founding-population', sireId: null, sireLineageId: null, ploidy: destiny === 'male' ? 'haploid' : 'diploid' },
  } : createOffspringInheritance('queen-amber-001', homeQueenGenome, homeReproduction, destiny);
  const item = {
    id: nextBroodId++, stage, stageAge, care: rand(0.82, 1.08), generation,
    starvation: 0,
    sex: inherited.sex, destiny: inherited.destiny, genome: inherited.genome, parentage: inherited.parentage,
  };
  brood.push(item);
  return item;
}

function ecloseAlate(reproduction, broodItem, colonyId, prefix) {
  if (reproduction.alates.length >= 48) return null;
  const alate = {
    id: `${prefix}-${broodItem.destiny}-${reproduction.nextAlateId++}`,
    colonyId,
    sex: broodItem.sex,
    destiny: broodItem.destiny,
    winged: true,
    ageDays: 0,
    vigor: clamp(0.82 + broodItem.care * 0.16 + rand(-0.04, 0.04), 0.82, 1.08),
    genome: broodItem.genome,
    generation: broodItem.generation,
    parentage: broodItem.parentage,
    state: 'waiting in the alate chamber',
  };
  reproduction.alates.push(alate);
  if (broodItem.destiny === 'male') reproduction.malesEclosed++;
  else reproduction.gynesEclosed++;
  return alate;
}

const regionalMating = {
  flightWindow: { active: false, id: 0, timer: 0, openedAt: null, closedAt: null, forced: false },
  swarmCenter: new THREE.Vector3((NEST.x + RIVAL_NEST.x) * 0.5, 3.4, (NEST.y + RIVAL_NEST.y) * 0.5),
  flyingAlates: [],
  matedQueens: [],
  nextExternalMaleId: 1,
  nextFoundressId: 1,
  lastFlightAt: -100,
  lastSuitability: 0,
  windowsOpened: 0,
  matingEvents: 0,
  malesDied: 0,
  malesDispersed: 0,
  gynesFailed: 0,
  externalMalesJoined: 0,
};
const regionalLineageHistory = { nextEventId: 1, events: [] };
const regionalLifeHistory = {
  nextVacancyId: 1,
  nextCensusYear: 0,
  vacancies: [],
  censuses: [],
  events: [],
  queenDeaths: 0,
  colonyExtinctions: 0,
  reproductiveMaturities: 0,
  lineageReplacements: 0,
  latestEvent: 'baseline census established',
  nextUiUpdate: 0,
};
const territoryVacancyVisuals = new Map();

function recordLineageEvent(type, queen, details = {}) {
  regionalLineageHistory.events.push({
    id: regionalLineageHistory.nextEventId++,
    time: Number(simTime.toFixed(1)),
    type,
    lineageId: queen?.lineageId || null,
    queenId: queen?.id || null,
    colonyId: queen?.registeredColonyId || null,
    natalColonyId: queen?.natalColonyId || null,
    ...details,
  });
  if (regionalLineageHistory.events.length > 96) regionalLineageHistory.events.shift();
}

function recordColonyLifeEvent(type, colony, details = {}) {
  recordLineageEvent(type, colony?.queen, {
    colonyId: colony?.id || null,
    lineageId: colony?.lineageId || null,
    ...details,
  });
  regionalLifeHistory.latestEvent = details.label || type.replaceAll('-', ' ');
  regionalLifeHistory.events.push({
    time: Number(simTime.toFixed(1)),
    year: Number((simTime / ECOLOGICAL_YEAR_SECONDS).toFixed(2)),
    type,
    colonyId: colony?.id || null,
    lineageId: colony?.lineageId || null,
    ...details,
  });
  if (regionalLifeHistory.events.length > 64) regionalLifeHistory.events.shift();
  renderRegionalCensus(true);
}

function initializeColonyLifeHistory(colony) {
  if (!colony || colony.lifeHistory) return colony?.lifeHistory || null;
  const ageYears = colonyAgeYears(colony);
  colony.lifeHistory = buildInitialColonyLifeHistory({
    colony,
    ageYears,
    successionScenario: requestedSuccessionScenario,
  });
  return colony.lifeHistory;
}

function createTerritoryVacancyVisual(vacancy) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.82, 0.98, 40),
    new THREE.MeshBasicMaterial({
      color: vacancy.color,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI * 0.5 + 0.38;
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.055, 0.34, 5),
      new THREE.MeshBasicMaterial({ color: vacancy.color, transparent: true, opacity: 0.28 }),
    );
    marker.position.set(Math.cos(angle) * 0.9, 0.14, Math.sin(angle) * 0.9);
    marker.rotation.z = Math.sin(angle) * 0.2;
    group.add(marker);
  }
  group.position.set(vacancy.x, groundHeight(vacancy.x, vacancy.z) + 0.045, vacancy.z);
  surfaceGroup.add(group);
  territoryVacancyVisuals.set(vacancy.id, { group, ring, markers: group.children.slice(1) });
}

function openTerritoryVacancy(colony) {
  const life = colony.lifeHistory;
  if (!life || life.vacancyId) return regionalLifeHistory.vacancies.find((vacancy) => vacancy.id === life?.vacancyId) || null;
  const vacancy = {
    id: `vacancy-${String(regionalLifeHistory.nextVacancyId++).padStart(3, '0')}`,
    formerColonyId: colony.id,
    formerLineageId: colony.lineageId,
    x: colony.nest.x,
    z: colony.nest.y,
    color: colony.color,
    openedAt: simTime,
    openedYear: simTime / ECOLOGICAL_YEAR_SECONDS,
    state: 'contracting',
    availableAt: null,
    claimedAt: null,
    claimantQueenId: null,
    replacementColonyId: null,
    replacementLineageId: null,
  };
  regionalLifeHistory.vacancies.push(vacancy);
  life.vacancyId = vacancy.id;
  createTerritoryVacancyVisual(vacancy);
  return vacancy;
}

function availableTerritoryVacancies() {
  return regionalLifeHistory.vacancies.filter((vacancy) => vacancy.state === 'vacant');
}

function releaseVacancyClaim(queen) {
  if (!queen?.settledVacancyId) return;
  const vacancy = regionalLifeHistory.vacancies.find((item) => item.id === queen.settledVacancyId);
  if (vacancy?.state === 'claimed' && vacancy.claimantQueenId === queen.id) {
    vacancy.state = 'vacant';
    vacancy.claimedAt = null;
    vacancy.claimantQueenId = null;
  }
}

function claimTerritoryVacancy(queen, vacancyId) {
  const vacancy = regionalLifeHistory.vacancies.find((item) => item.id === vacancyId && item.state === 'vacant');
  if (!vacancy) return null;
  vacancy.state = 'claimed';
  vacancy.claimedAt = simTime;
  vacancy.claimantQueenId = queen.id;
  queen.settledVacancyId = vacancy.id;
  return vacancy;
}

function completeTerritoryReplacement(queen, colony) {
  if (!queen?.settledVacancyId) return;
  const vacancy = regionalLifeHistory.vacancies.find((item) => item.id === queen.settledVacancyId);
  if (!vacancy || vacancy.claimantQueenId !== queen.id) return;
  vacancy.state = 'recolonized';
  vacancy.replacementColonyId = colony.id;
  vacancy.replacementLineageId = colony.lineageId;
  colony.lifeHistory.replacedVacancyId = vacancy.id;
  const former = getColony(vacancy.formerColonyId);
  if (former?.lifeHistory) former.lifeHistory.replacementColonyId = colony.id;
  regionalLifeHistory.lineageReplacements++;
  recordColonyLifeEvent('territory-recolonized', colony, {
    vacancyId: vacancy.id,
    formerColonyId: vacancy.formerColonyId,
    formerLineageId: vacancy.formerLineageId,
    replacementLineageId: colony.lineageId,
    label: `${colony.displayName} replaced ${vacancy.formerLineageId}`,
  });
}

function killColonyQueen(colony, cause = 'natural senescence') {
  const life = colony?.lifeHistory;
  if (!colony || !life || colony.queen?.alive === false) return false;
  colony.queen.alive = false;
  if ('queenHealth' in colony.queen) colony.queen.queenHealth = 0;
  life.lifeStage = 'orphaned';
  life.queenVitality = 0;
  life.queenDiedAt = simTime;
  life.queenDeathAgeYears = colonyAgeYears(colony);
  life.queenDeathCause = cause;
  life.orphanedAt = simTime;
  life.workersAtQueenDeath = workerCensus.colonyCount(colony.id);
  life.territoryState = 'contracting';
  colony.status = 'orphaned';
  regionalLifeHistory.queenDeaths++;
  openTerritoryVacancy(colony);
  recordColonyLifeEvent('queen-died', colony, {
    cause,
    ageYears: Number(life.queenDeathAgeYears.toFixed(2)),
    workers: life.workersAtQueenDeath,
    label: `${colony.displayName} queen died`,
  });
  return true;
}

function recordRegionalCensus() {
  const year = Math.floor(simTime / ECOLOGICAL_YEAR_SECONDS);
  if (year < regionalLifeHistory.nextCensusYear) return;
  regionalLifeHistory.nextCensusYear = year + 1;
  const colonies = colonyOrder.map((id) => getColony(id)).filter(Boolean);
  regionalLifeHistory.censuses.push({
    year,
    time: Number(simTime.toFixed(1)),
    workers: totalActiveWorkers(),
    activeColonies: livingColonies().length,
    reproductiveColonies: livingColonies().filter((colony) => colonyIsReproductivelyMature(colony) && colony.queen?.alive !== false).length,
    orphanedColonies: colonies.filter((colony) => colony.status === 'orphaned').length,
    extinctColonies: colonies.filter((colony) => colony.status === 'extinct').length,
    occupiedLineages: livingColonies().map((colony) => colony.lineageId),
    vacancies: regionalLifeHistory.vacancies.filter((vacancy) => vacancy.state === 'vacant').length,
    queenDeaths: regionalLifeHistory.queenDeaths,
    lineageReplacements: regionalLifeHistory.lineageReplacements,
    births: colonies.reduce((sum, colony) => sum + (colony.workersEclosed || 0), 0),
    deaths: colonies.reduce((sum, colony) => sum + (colony.deaths || 0), 0),
  });
  if (regionalLifeHistory.censuses.length > 32) regionalLifeHistory.censuses.shift();
  renderRegionalCensus(true);
}

function renderRegionalCensus(force = false) {
  if (!force && simTime < regionalLifeHistory.nextUiUpdate) return;
  regionalLifeHistory.nextUiUpdate = simTime + 2;
  const year = Math.floor(simTime / ECOLOGICAL_YEAR_SECONDS);
  const colonies = colonyOrder.map((id) => getColony(id)).filter(Boolean);
  const live = livingColonies();
  const orphaned = colonies.filter((colony) => colony.status === 'orphaned').length;
  const vacant = regionalLifeHistory.vacancies.filter((vacancy) => vacancy.state === 'vacant').length;
  const recent = regionalLifeHistory.censuses.slice(-12);
  const maxWorkers = Math.max(1, ...recent.map((census) => census.workers));
  simulationUI.renderCensus({
    title: `Ecological year ${year}`,
    timeline: recent.map((census, index) => {
    const previous = recent[index - 1];
      return {
        year: census.year,
        title: `Year ${census.year}: ${census.workers} workers, ${census.activeColonies} colonies`,
        heightPercent: Math.max(8, census.workers / maxWorkers * 100),
        orphaned: Boolean(previous && census.queenDeaths > previous.queenDeaths),
        replaced: Boolean(previous && census.lineageReplacements > previous.lineageReplacements),
      };
    }),
    summary: `${totalActiveWorkers()} workers · ${live.length} active colonies · ${orphaned} orphaned · ${vacant} vacant territories`,
    event: regionalLifeHistory.latestEvent,
  });
}

function updateTerritoryVacancyVisuals() {
  for (const vacancy of regionalLifeHistory.vacancies) {
    const visual = territoryVacancyVisuals.get(vacancy.id);
    if (!visual) continue;
    const pulse = 0.92 + Math.sin(simTime * 1.2 + vacancy.openedYear) * 0.08;
    const stateOpacity = vacancy.state === 'contracting' ? 0.09
      : vacancy.state === 'vacant' ? 0.26
        : vacancy.state === 'claimed' ? 0.34 : 0.13;
    visual.ring.material.opacity = stateOpacity * pulse;
    visual.ring.material.color.setHex(vacancy.state === 'claimed' ? 0xf0cf7b
      : vacancy.state === 'recolonized' ? 0x9abe7b : vacancy.color);
    for (const marker of visual.markers) {
      marker.material.opacity = stateOpacity * 1.15;
      marker.material.color.copy(visual.ring.material.color);
    }
    visual.group.scale.setScalar(vacancy.state === 'vacant' ? 1.08 : vacancy.state === 'claimed' ? 0.92 : 1);
  }
}

function updateColonyLifeHistories({ refreshSummary = false } = {}) {
  for (const colony of colonyRegistry.values()) {
    const life = initializeColonyLifeHistory(colony);
    const ageYears = colonyAgeYears(colony);
    life.queenAgeYears = ageYears;
    if (colony.status === 'extinct') continue;

    if (colony.queen?.alive !== false) {
      const yearsRemaining = life.queenLongevityYears - ageYears;
      life.queenVitality = queenVitalityAtAge(
        ageYears,
        life.queenLongevityYears,
        QUEEN_SENESCENCE_YEARS,
      );
      if (ageYears >= life.reproductiveMaturityAgeYears && !life.maturityRecorded) {
        life.maturityRecorded = true;
        life.lifeStage = 'reproductive prime';
        if (colony.status === 'established') colony.status = 'mature';
        regionalLifeHistory.reproductiveMaturities++;
        recordColonyLifeEvent('colony-reproductive-maturity', colony, {
          ageYears: Number(ageYears.toFixed(2)),
          workers: workerCensus.colonyCount(colony.id),
          label: `${colony.displayName} reached reproductive maturity`,
        });
      } else if (ageYears < life.reproductiveMaturityAgeYears) {
        life.lifeStage = colony.status === 'incipient' ? 'incipient'
          : colony.status === 'young' ? 'young' : 'pre-reproductive';
      }
      if (yearsRemaining <= QUEEN_SENESCENCE_YEARS && !life.senescenceRecorded) {
        life.senescenceRecorded = true;
        life.lifeStage = 'queen senescence';
        recordColonyLifeEvent('queen-senescence-began', colony, {
          ageYears: Number(ageYears.toFixed(2)),
          expectedLongevityYears: Number(life.queenLongevityYears.toFixed(2)),
        });
      }
      if (ageYears >= life.queenLongevityYears) killColonyQueen(colony);
      continue;
    }

    if (life.lifeStage !== 'orphaned') life.lifeStage = 'orphaned';
    const livingWorkers = workerCensus.colonyCount(colony.id);
    const orphanYears = Math.max(0, simTime - (life.orphanedAt || simTime)) / ECOLOGICAL_YEAR_SECONDS;
    const vacancy = regionalLifeHistory.vacancies.find((item) => item.id === life.vacancyId);
    const workforceReleased = livingWorkers <= Math.max(8, Math.round((life.workersAtQueenDeath || 0) * 0.45));
    if (life.territoryState === 'contracting'
      && (orphanYears >= ORPHAN_TERRITORY_RELEASE_YEARS || (orphanYears > 0.16 && workforceReleased))) {
      life.territoryState = 'vacant';
      if (vacancy) {
        vacancy.state = 'vacant';
        vacancy.availableAt = simTime;
      }
      recordColonyLifeEvent('territory-vacated', colony, {
        vacancyId: life.vacancyId,
        remainingWorkers: livingWorkers,
        label: `${colony.displayName} territory became vacant`,
      });
    }
    if (livingWorkers === 0 && colony.brood.length === 0 && life.extinctAt == null) {
      life.extinctAt = simTime;
      life.lifeStage = 'extinct';
      life.territoryState = 'vacant';
      colony.status = 'extinct';
      if (life.territoryState === 'contracting') life.territoryState = 'vacant';
      if (vacancy?.state === 'contracting') {
        vacancy.state = 'vacant';
        vacancy.availableAt = simTime;
      }
      regionalLifeHistory.colonyExtinctions++;
      recordColonyLifeEvent('colony-extinct', colony, {
        vacancyId: life.vacancyId,
        label: `${colony.displayName} became extinct`,
      });
    }
  }
  // The year boundary check is O(1) and remains fixed-step so the census is
  // stamped at the same biological instant; DOM and vacancy presentation are 4 Hz.
  recordRegionalCensus();
  if (refreshSummary) {
    updateTerritoryVacancyVisuals();
    renderRegionalCensus();
  }
}

function flightLightLevel() {
  return calculateFlightLightLevel(simTime);
}

function nuptialFlightSuitability() {
  return calculateNuptialFlightSuitability({
    simTime,
    seasonName: environment.season.name,
    rain: weather.rain,
    postRainHumidity: weather.postRainHumidity,
  });
}

function matureFlightAlates(reproduction, destiny) {
  return reproduction.alates.filter((alate) => alate.destiny === destiny && alate.ageDays >= 7);
}

function createFlyingAlate(alate, nest, reproduction, external = false) {
  const originColonyId = external ? 'regional' : alate.colonyId;
  const startAngle = rand(0, Math.PI * 2);
  const startRadius = external ? rand(5.5, 9.5) : rand(0.24, 0.64);
  const x = external ? regionalMating.swarmCenter.x + Math.cos(startAngle) * startRadius : nest.x + Math.cos(startAngle) * startRadius;
  const z = external ? regionalMating.swarmCenter.z + Math.sin(startAngle) * startRadius : nest.y + Math.sin(startAngle) * startRadius;
  return {
    id: alate.id,
    originColonyId,
    natalQueenId: alate.parentage?.damId || null,
    sex: alate.sex,
    destiny: alate.destiny,
    winged: true,
    genome: alate.genome,
    generation: alate.generation || 1,
    parentage: alate.parentage,
    lineageId: external ? alate.lineageId : getColony(originColonyId)?.lineageId || `lineage-${originColonyId}`,
    x, z, y: groundHeight(x, z) + rand(0.24, 0.5),
    heading: startAngle + Math.PI,
    phase: rand(0, 10),
    speed: (alate.destiny === 'gyne' ? rand(1.12, 1.42) : rand(1.46, 1.86)) * (alate.genome?.speed || 1),
    airborneAge: 0,
    life: alate.destiny === 'gyne' ? rand(42, 54) : rand(21, 31),
    state: external ? 'joining the regional male swarm' : 'climbing from the natal nest',
    mates: [],
    targetMateCount: alate.destiny === 'gyne' ? 2 + Math.floor(random() * 3) : 0,
    usedMaleIds: [],
    mateCooldown: rand(0.8, 1.7),
    landingSite: null,
    dispersalHeading: rand(0, Math.PI * 2),
    external,
    reproduction,
  };
}

function spawnRegionalMales(count) {
  const neutralGenome = { speed: 1, size: 0.95, diseaseResistance: 1, aggression: 0.92, foraging: 0.96 };
  for (let i = 0; i < count && regionalMating.flyingAlates.length < 72; i++) {
    const id = `regional-male-${regionalMating.nextExternalMaleId++}`;
    const lineageId = `regional-flight-${1 + Math.floor(random() * 12)}`;
    const male = {
      id, colonyId: 'regional', sex: 'male', destiny: 'male', winged: true,
      genome: mutateGenome(neutralGenome, 0.16), generation: 0, lineageId,
      parentage: { damId: `off-map-${lineageId}`, sireId: null, sireLineageId: null, ploidy: 'haploid' },
    };
    regionalMating.flyingAlates.push(createFlyingAlate(male, NEST, null, true));
    regionalMating.externalMalesJoined++;
  }
}

function releaseColonyAlates(colonyId, nest, reproduction) {
  let launchedMales = 0;
  let launchedGynes = 0;
  for (let i = reproduction.alates.length - 1; i >= 0 && regionalMating.flyingAlates.length < 66; i--) {
    const alate = reproduction.alates[i];
    if (alate.ageDays < 7) continue;
    reproduction.alates.splice(i, 1);
    regionalMating.flyingAlates.push(createFlyingAlate(alate, nest, reproduction));
    if (alate.destiny === 'male') { reproduction.malesLaunched++; launchedMales++; }
    else { reproduction.gynesLaunched++; launchedGynes++; }
  }
  return { colonyId, males: launchedMales, gynes: launchedGynes };
}

function reproductiveFlightColonies() {
  return livingColonies().filter((colony) => {
    const maturityAge = colony.lifeHistory?.reproductiveMaturityAgeYears ?? COLONY_REPRODUCTIVE_MATURITY_YEARS;
    const hasCaretakers = colony.workers.some((worker) => worker.alive !== false);
    return colony.reproduction && colonyAgeYears(colony) >= maturityAge
      && (colony.queen?.alive !== false || hasCaretakers);
  });
}

function availableMatureGynes() {
  return reproductiveFlightColonies().reduce(
    (sum, colony) => sum + matureFlightAlates(colony.reproduction, 'gyne').length, 0,
  );
}

function openNuptialFlight(forced = false) {
  if (regionalMating.flightWindow.active || availableMatureGynes() <= 0) return false;
  if (forced) {
    weather.rainTimer = 0;
    weather.rain = 0;
    weather.postRainHumidity = 1;
    weather.nextRain = simTime + 58;
  }
  regionalMating.flightWindow = {
    active: true,
    id: regionalMating.flightWindow.id + 1,
    timer: forced ? 22 : rand(15, 21),
    openedAt: simTime,
    closedAt: null,
    forced,
  };
  regionalMating.lastFlightAt = simTime;
  regionalMating.windowsOpened++;
  const flightYear = Math.floor(simTime / ECOLOGICAL_YEAR_SECONDS);
  ecologicalBalance.annualFlightWindows.set(flightYear, (ecologicalBalance.annualFlightWindows.get(flightYear) || 0) + 1);
  const sourceColonies = reproductiveFlightColonies();
  const centroid = sourceColonies.reduce((point, colony) => point.add(colony.nest), new THREE.Vector2())
    .multiplyScalar(1 / Math.max(1, sourceColonies.length));
  regionalMating.swarmCenter.set(
    centroid.x + rand(-1.2, 1.2),
    rand(3.1, 4.1),
    centroid.y + rand(-1, 1),
  );
  let totalGynes = 0;
  for (const colony of sourceColonies) {
    const launch = releaseColonyAlates(colony.id, colony.nest, colony.reproduction);
    totalGynes += launch.gynes;
  }
  spawnRegionalMales(clamp(totalGynes * 4 + 4, 7, 22));
  createSignal(regionalMating.swarmCenter.x, regionalMating.swarmCenter.z, 0xe7e0b0);
  return true;
}

function chooseFoundingSite(natalColonyId) {
  let best = null;
  let bestScore = -Infinity;
  const vacancies = availableTerritoryVacancies();
  for (let i = 0; i < 28; i++) {
    const vacancy = i < Math.min(12, vacancies.length * 4) ? vacancies[i % vacancies.length] : null;
    const x = vacancy ? clamp(vacancy.x + rand(-1.15, 1.15), -HALF_W + 3, HALF_W - 3)
      : rand(-HALF_W + 5.5, HALF_W - 5.5);
    const z = vacancy ? clamp(vacancy.z + rand(-1.15, 1.15), -HALF_D + 3, HALF_D - 3)
      : rand(-HALF_D + 5.5, HALF_D - 5.5);
    const nestClearance = territorialColonies().reduce((min, colony) => Math.min(min, Math.hypot(x - colony.nest.x, z - colony.nest.y)), 20);
    const queenClearance = regionalMating.matedQueens.filter((queen) => queen.alive).reduce(
      (min, queen) => Math.min(min, Math.hypot(x - queen.x, z - queen.z)), 20,
    );
    const obstacleClearance = obstacles.reduce((min, obstacle) => Math.min(min, Math.hypot(x - obstacle.x, z - obstacle.z) - obstacle.r), 8);
    const natalNest = natalColonyId === RIVAL_COLONY_ID ? RIVAL_NEST : NEST;
    const dispersal = Math.hypot(x - natalNest.x, z - natalNest.y);
    const vacancyDistance = vacancy ? Math.hypot(x - vacancy.x, z - vacancy.z) : Infinity;
    const vacancyBonus = vacancy ? 15 + clamp((VACANCY_REPLACEMENT_RADIUS - vacancyDistance) * 1.8, 0, 6) : 0;
    const score = Math.min(nestClearance, 8) * 1.3 + Math.min(queenClearance, 6)
      + Math.min(obstacleClearance, 4) + Math.min(dispersal, 10) * 0.35 + vacancyBonus;
    if (score > bestScore) { bestScore = score; best = { x, z, vacancyId: vacancy?.id || null }; }
  }
  return best || { x: rand(-12, 12), z: rand(-8, 8) };
}

function evaluateFoundingSite(x, z) {
  return calculateFoundingSiteQuality({
    groundNormalY: groundNormal(x, z).y,
    x,
    z,
    territorialColonies: territorialColonies(),
    obstacles,
    postRainHumidity: weather.postRainHumidity,
    rain: weather.rain,
  });
}

function createFoundressReproduction(queen) {
  return {
    spermBank: queen.spermBank,
    reproductiveBudget: 0,
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

function beginGyneDescent(gyne) {
  if (!gyne.landingSite) gyne.landingSite = chooseFoundingSite(gyne.originColonyId);
  gyne.state = 'descending toward a founding site';
}

function completeGyneDealation(gyne) {
  if (regionalMating.matedQueens.length >= foundressVisualPool.length) {
    regionalMating.gynesFailed++;
    return;
  }
  const foundressNumber = regionalMating.nextFoundressId++;
  const queen = {
    id: `foundress-${String(foundressNumber).padStart(3, '0')}`,
    lineageId: `lineage-foundress-${String(foundressNumber).padStart(3, '0')}`,
    natalColonyId: gyne.originColonyId,
    natalQueenId: gyne.natalQueenId,
    genome: gyne.genome,
    generation: gyne.generation,
    parentage: gyne.parentage,
    x: gyne.landingSite.x,
    z: gyne.landingSite.z,
    heading: rand(0, Math.PI * 2),
    winged: false,
    dealated: true,
    alive: true,
    matedAt: simTime,
    mateCount: gyne.mates.length,
    spermBank: gyne.mates.map((mate, index) => ({
      id: mate.id,
      lineageId: mate.lineageId,
      originColonyId: mate.originColonyId,
      genome: mate.genome,
      storedShare: rand(0.74, 1.26),
      daughters: 0,
      matingOrder: index + 1,
    })),
    foundingStage: 'assessing',
    stageAge: 0,
    siteQuality: foundingStressTest ? 0.3 : evaluateFoundingSite(gyne.landingSite.x, gyne.landingSite.z),
    siteRejections: foundingStressTest ? 2 : 0,
    relocationTarget: null,
    chamberProgress: 0,
    entranceOpenProgress: 0,
    reserves: foundingStressTest ? 22 : clamp(94 + gyne.genome.size * 12 + gyne.mates.length * 2, 96, 116),
    colonyFood: 0,
    foodDelivered: 0,
    queenHealth: 100,
    workerDeaths: 0,
    openedAt: null,
    firstDeliveryRecorded: false,
    collapseCause: null,
    foundingStress: 0,
    failureThreshold: foundingStressTest ? 0.065 : rand(0.78, 1.08),
    foundingBrood: [],
    nanitics: [],
    eggsLaid: 0,
    workersEclosed: 0,
    foundingDeaths: 0,
    foundingBroodDeaths: 0,
    technicalBlockedEclosions: 0,
    nextBroodId: 1,
    nextNaniticId: 1,
    layClock: rand(2.2, 3.4),
    registeredColonyId: null,
    settledVacancyId: null,
    acceptedAt: null,
    state: 'dealated and assessing a founding refuge',
  };
  queen.reproduction = createFoundressReproduction(queen);
  if (gyne.landingSite.vacancyId) claimTerritoryVacancy(queen, gyne.landingSite.vacancyId);
  regionalMating.matedQueens.push(queen);
  recordLineageEvent('queen-dealated', queen, { mateCount: queen.mateCount, x: Number(queen.x.toFixed(1)), z: Number(queen.z.toFixed(1)) });
  if (gyne.reproduction) gyne.reproduction.matedGynes++;
  leaveShedWings(queen.x, queen.z);
  createSignal(queen.x, queen.z, queen.natalColonyId === RIVAL_COLONY_ID ? 0x8ab1c4 : 0xe0a06d);
}

function failFoundation(queen, cause) {
  if (!queen.alive || queen.registeredColonyId) return;
  queen.alive = false;
  queen.foundingStage = 'failed';
  queen.foundingDeaths++;
  queen.failureCause = cause;
  queen.state = `founding failed · ${cause}`;
  queen.foundingBrood.length = 0;
  releaseVacancyClaim(queen);
  regionalMating.gynesFailed++;
  recordLineageEvent('foundation-failed', queen, { cause, stage: queen.foundingStage });
}

function addFoundingEgg(queen, resource = 'reserves', destiny = 'worker') {
  const available = resource === 'colonyFood' ? queen.colonyFood : queen.reserves;
  const cost = resource === 'colonyFood' ? reproductiveCost(destiny) : 1.55;
  if (queen.foundingBrood.length >= TECHNICAL_BROOD_LIMIT || available < (resource === 'colonyFood' ? cost + 1 : 18)) return null;
  const inherited = createOffspringInheritance(queen.id, queen.genome, queen.reproduction, destiny);
  const item = {
    id: `${queen.id}-brood-${queen.nextBroodId++}`,
    stage: 'egg',
    stageAge: 0,
    sex: inherited.sex,
    destiny,
    genome: inherited.genome,
    parentage: inherited.parentage,
    generation: queen.generation + 1,
    care: clamp(0.86 + queen.genome.size * 0.08 + rand(-0.04, 0.04), 0.86, 1.06),
    starvation: 0,
  };
  queen.foundingBrood.push(item);
  queen.eggsLaid++;
  if (destiny === 'worker') queen.reproduction.workerEggsLaid++;
  else {
    queen.reproduction.sexualEggsLaid++;
    queen.reproduction.reproductiveBudget = Math.max(0, queen.reproduction.reproductiveBudget - cost);
    if (destiny === 'male') queen.reproduction.maleInvestment += cost;
    else queen.reproduction.gyneInvestment += cost;
  }
  if (resource === 'colonyFood') queen.colonyFood = Math.max(0, queen.colonyFood - cost);
  else queen.reserves = Math.max(0, queen.reserves - 1.55);
  if (queen.eggsLaid === 1) recordLineageEvent('first-egg-laid', queen, { generation: item.generation });
  return item;
}

function createNanitic(queen, broodItem) {
  const colonyId = queen.registeredColonyId || `incipient-${queen.id}`;
  if (!hasTechnicalWorkerRoom(colonyId, queen.nanitics.length)) return null;
  const firstCohort = queen.workersEclosed < 7;
  const worker = {
    id: queen.nextNaniticId++,
    colonyId,
    colony: 'incipient',
    alive: true,
    insideNest: true,
    location: 'founding chamber',
    nestPosition: new THREE.Vector3(queen.x, groundHeight(queen.x, queen.z) - 0.28, queen.z),
    x: queen.x,
    z: queen.z,
    heading: rand(0, Math.PI * 2),
    desired: rand(0, Math.PI * 2),
    phase: rand(0, 10),
    laneBias: rand(-0.18, 0.18),
    speed: rand(0.66, 0.86) * broodItem.genome.speed,
    genome: broodItem.genome,
    parentage: broodItem.parentage,
    generation: broodItem.generation,
    workerCaste: firstCohort ? 'nanitic' : 'minor',
    ageDays: 0,
    health: clamp(78 + broodItem.care * 12, 78, 94),
    energy: clamp(62 + queen.reserves * 0.12, 62, 78),
    size: firstCohort ? clamp(0.62 + broodItem.genome.size * 0.08, 0.66, 0.74)
      : clamp(0.76 + broodItem.genome.size * 0.1, 0.8, 0.92),
    tendency: 'nurse',
    assignedRole: 'nurse',
    state: 'tending siblings in the founding chamber',
    carrying: false,
    carryingKind: null,
    carryingNutrition: 1,
    targetFood: null,
    turnClock: rand(0.4, 1.6),
    nestTimer: rand(3, 7),
    distanceTraveled: 0,
    trips: 0,
    tasksCompleted: 0,
    infection: 0,
  };
  ensureWorkerNavigation(worker, false);
  queen.nanitics.push(worker);
  const registeredColony = getColony(worker.colonyId);
  if (registeredColony) indexWorker(worker, registeredColony);
  queen.workersEclosed++;
  recordLineageEvent(queen.workersEclosed === 1 ? 'first-nanitic-eclosed' : 'worker-eclosed', queen, {
    workerId: worker.id, generation: worker.generation, caste: worker.workerCaste,
  });
  return worker;
}

function registerFoundingColony(queen) {
  if (queen.registeredColonyId) return getColony(queen.registeredColonyId);
  const colonyId = `incipient-${queen.id}`;
  queen.registeredColonyId = colonyId;
  for (const worker of queen.nanitics) worker.colonyId = colonyId;
  const entrance = {
    cache: [], capacity: 12, activation: 0, recentReturns: 0, foodReturned: 0,
    contactEvents: 0, activeTransfers: 0, storageTransfers: 0,
  };
  const pheromoneField = createColonyPheromoneField(colonyId, 0.12);
  const foragingNetwork = createForagingNetwork(
    colonyId,
    new THREE.Vector2(queen.x, queen.z),
    queen.natalColonyId === RIVAL_COLONY_ID ? 0x7ba9bc : 0xd98763,
  );
  const seedBank = createColonySeedBank(colonyId, 0);
  const record = registerColony({
    id: colonyId,
    lineageId: queen.lineageId,
    displayName: `Foundress ${queen.id.slice(-3)} colony`,
    workerPrefix: `F${queen.id.slice(-3)}-`,
    workerRuntimePolicy: 'descendant',
    workerPresentation: { palette: queen.natalColonyId === RIVAL_COLONY_ID ? 'slate-descendant' : 'amber-descendant' },
    speciesProfile: SPECIES_PROFILE,
    status: 'incipient',
    ageAtStartYears: 0,
    foundedAt: simTime,
    foundedBy: queen.natalColonyId,
    nest: new THREE.Vector2(queen.x, queen.z),
    focusOffset: new THREE.Vector2(0, 0),
    undergroundFocusY: -0.35,
    undergroundDistance: 6.8,
    undergroundView: false,
    color: queen.natalColonyId === RIVAL_COLONY_ID ? 0x7191a8 : 0xa5533f,
    get maxWorkers() { return architectureWorkerCapacity(this.architecture); },
    technicalWorkerLimit: TECHNICAL_DESCENDANT_WORKER_LIMIT,
    workers: queen.nanitics,
    brood: queen.foundingBrood,
    reproduction: queen.reproduction,
    entrance,
    pheromoneField,
    foragingNetwork,
    seedBank,
    queen,
    get storedFood() { return queen.colonyFood; },
    get foodDelivered() { return queen.foodDelivered; },
    get eggsLaid() { return queen.eggsLaid; },
    get workersEclosed() { return queen.workersEclosed; },
    get deaths() { return queen.foundingDeaths; },
  });
  for (const worker of record.workers) indexWorker(worker, record);
  initializeColonyLifeHistory(record);
  completeTerritoryReplacement(queen, record);
  queen.foundingStage = 'incipient';
  const architecture = createColonyArchitecture(record, { founding: true, baseCapacity: 0, baseStorageCapacity: 0 });
  queen.architectureId = architecture?.colonyId || null;
  if (requestedNestFocus === 'young') focusCameraOnColony(record, true);
  queen.state = 'first nanitic eclosed · incipient colony registered';
  recordLineageEvent('colony-registered', queen, { status: 'incipient', workers: queen.nanitics.length });
  createSignal(queen.x, queen.z, 0xf1c776);
  return record;
}

function updateFoundingBrood(queen, dt) {
  const temperatureFactor = environment.season.name === 'winter' ? 0.68 : environment.season.name === 'autumn' ? 0.86 : 1;
  for (let i = queen.foundingBrood.length - 1; i >= 0; i--) {
    const item = queen.foundingBrood[i];
    let development = (0.78 + queen.siteQuality * 0.32) * item.care * temperatureFactor;
    if (item.stage === 'larva') {
      const usesExternalFood = queen.foundingStage === 'young' || queen.foundingStage === 'established';
      const available = usesExternalFood ? queen.colonyFood : queen.reserves;
      const requiredRation = dt * 0.032;
      const ration = Math.min(available, requiredRation);
      if (usesExternalFood) queen.colonyFood -= ration;
      else queen.reserves -= ration;
      const rationRatio = ration / Math.max(0.0001, requiredRation);
      if (rationRatio < 0.7) development *= 0.38;
      item.starvation = clamp((item.starvation || 0)
        + dt * Math.max(0, 0.72 - rationRatio) * 0.038
        - dt * Math.max(0, rationRatio - 0.72) * 0.018, 0, 1.2);
      if (item.starvation >= 1) {
        queen.foundingBrood.splice(i, 1);
        queen.foundingBroodDeaths = (queen.foundingBroodDeaths || 0) + 1;
        recordLineageEvent('brood-died', queen, { cause: 'larval starvation', stage: item.stage });
        continue;
      }
    }
    item.stageAge += dt * development;
    if (item.stageAge < FOUNDING_BROOD_SECONDS[item.stage]) continue;
    if (item.stage === 'egg') { item.stage = 'larva'; item.stageAge = 0; }
    else if (item.stage === 'larva') { item.stage = 'pupa'; item.stageAge = 0; }
    else {
      const eclosed = item.destiny === 'worker'
        ? createNanitic(queen, item)
        : ecloseAlate(queen.reproduction, item, queen.registeredColonyId || `incipient-${queen.id}`, queen.id);
      if (!eclosed) {
        if (!item.technicalBlockReported) {
          item.technicalBlockReported = true;
          queen.technicalBlockedEclosions = (queen.technicalBlockedEclosions || 0) + 1;
        }
        item.stageAge = FOUNDING_BROOD_SECONDS.pupa;
        continue;
      }
      queen.foundingBrood.splice(i, 1);
      if (item.destiny === 'worker' && !queen.registeredColonyId) registerFoundingColony(queen);
    }
  }
}

function chooseYoungColonyFood(worker) {
  const network = colonyForagingNetworks.get(worker.colonyId);
  const navigation = ensureWorkerNavigation(worker);
  const sector = network ? chooseForagingSector(worker, network) : null;
  let best = null;
  let bestScore = -Infinity;
  const candidates = network && sector ? liveFoodsInSector(network, sector) : foods.filter((food) => food.amount > 0);
  for (const food of candidates) {
    const distance = Math.hypot(food.x - worker.x, food.z - worker.z);
    const memoryDistance = navigation.rememberedX == null ? 0
      : Math.hypot(food.x - navigation.rememberedX, food.z - navigation.rememberedZ);
    const privateWeight = navigation.confidence * (0.55 + flightLightLevel() * 0.85);
    const socialWeight = (sector?.socialPulse || 0) * 0.58;
    const score = food.nutrition * 3.2 * worker.genome.foraging + Math.log1p(food.amount) - distance * 0.2
      - memoryDistance * privateWeight * 0.22 + socialWeight * 0.5;
    if (score > bestScore) { bestScore = score; best = food; }
  }
  if (network && sector) {
    const privateWeight = navigation.confidence * (0.55 + flightLightLevel() * 0.85);
    const socialWeight = sector.socialPulse * 0.58 + sector.trunkStrength * 0.32;
    navigation.guidance = privateWeight > socialWeight ? 'private route memory' : socialWeight > 0.12 ? 'social sector activation' : 'sector exploration';
  }
  return best;
}

function updateDescendantWorkerPolicy(queen, worker, dt) {
  if (worker.insideNest) {
    worker.nestTimer -= dt;
    worker.energy = Math.min(100, worker.energy + dt * (queen.colonyFood > 0 ? 0.72 : 0.18));
    worker.state = queen.foundingBrood.length > 0 ? 'tending young-colony brood' : 'waiting in the opened founding chamber';
    const activeOutside = queen.nanitics.filter((other) => other.alive && !other.insideNest).length;
    const seasonalForaging = environment.season.name === 'winter' ? 0.38 : environment.season.name === 'autumn' ? 0.78 : 1;
    const youngReserveTarget = 8 + queen.nanitics.length * 0.22 + queen.foundingBrood.length * 0.42;
    const youngFoodPressure = clamp((youngReserveTarget - queen.colonyFood) / Math.max(1, youngReserveTarget), 0, 1);
    const targetOutside = clamp(Math.floor(queen.nanitics.length * (0.3 + youngFoodPressure * 0.32) * seasonalForaging),
      1, Math.max(1, queen.nanitics.length - 1));
    if (worker.nestTimer <= 0 && activeOutside < targetOutside && weather.rain < 0.62) {
      const angle = rand(0, Math.PI * 2);
      worker.insideNest = false;
      worker.x = queen.x + Math.cos(angle) * 0.42;
      worker.z = queen.z + Math.sin(angle) * 0.42;
      worker.heading = angle;
      worker.desired = angle;
      worker.state = 'emerging for the first independent forage';
    }
    return;
  }

  worker.turnClock -= dt;
  worker.energy = Math.max(0, worker.energy - dt * 0.075);
  if (weather.rain > 0.7 && !worker.carrying) {
    worker.targetFood = null;
    worker.state = 'returning to the young nest in rain';
  }

  const nestDx = queen.x - worker.x;
  const nestDz = queen.z - worker.z;
  const nestDistance = Math.hypot(nestDx, nestDz);
  const navigation = ensureWorkerNavigation(worker);
  if (!worker.carrying && navigation.learningWalk < 1) {
    const outward = Math.atan2(worker.z - queen.z, worker.x - queen.x);
    worker.desired = outward + Math.PI * 0.5 + Math.sin(worker.phase * 0.16) * 0.3;
    if (nestDistance > 1.45) worker.desired = Math.atan2(nestDz, nestDx) + Math.PI * 0.42;
    applyNeighborAvoidance(worker);
    worker.heading += clamp(wrapAngle(worker.desired - worker.heading), -dt * 3.2, dt * 3.2);
    const velocity = worker.speed * 0.62;
    worker.x += Math.cos(worker.heading) * velocity * dt;
    worker.z += Math.sin(worker.heading) * velocity * dt;
    worker.distanceTraveled += velocity * dt;
    navigation.learningWalk = clamp(navigation.learningWalk + dt * 0.14, 0, 1);
    navigation.guidance = 'learning walk';
    worker.state = 'learning nest panorama before first forage';
    if (navigation.learningWalk >= 1) {
      const network = colonyForagingNetworks.get(worker.colonyId);
      if (network) {
        network.learningWalksCompleted++;
        chooseForagingSector(worker, network, true);
      }
    }
    return;
  }
  if (worker.carrying || worker.energy < 18 || weather.rain > 0.7) {
    worker.desired = Math.atan2(nestDz, nestDx);
    worker.state = worker.carrying ? 'carrying food to the incipient colony' : 'returning to the founding chamber';
    if (worker.carrying) colonyPherDeposit(worker.colonyId, worker.x, worker.z, 0.018);
    if (nestDistance < 0.5) {
      if (worker.carrying) {
        recordForagingDelivery(worker);
        queen.colonyFood = acceptColonyStoredFood(
          worker.colonyId,
          queen.colonyFood,
          1.25 * worker.carryingNutrition,
        );
        queen.foodDelivered++;
        storeSeedCargo(worker.colonyId, {
          kind: worker.carryingKind,
          seedSpecies: worker.carryingSeedSpecies,
          sourcePlantId: worker.carryingSourcePlantId,
        });
        if (!queen.firstDeliveryRecorded) {
          queen.firstDeliveryRecorded = true;
          recordLineageEvent('first-food-delivery', queen, { workerId: worker.id, kind: worker.carryingKind });
        }
        clearWorkerFoodCargo(worker);
        worker.trips++;
        worker.tasksCompleted++;
      }
      worker.insideNest = true;
      worker.nestTimer = rand(3.5, 7.5);
      worker.nestPosition.set(queen.x, groundHeight(queen.x, queen.z) - 0.28, queen.z);
      return;
    }
  } else {
    const network = colonyForagingNetworks.get(worker.colonyId);
    if (network) expireStaleForagingMemory(worker, network);
    if (!worker.targetFood || worker.targetFood.amount <= 0 || worker.turnClock <= 0) {
      if (worker.targetFood && worker.targetFood.amount <= 0 && !worker.carrying) recordForagingFailure(worker);
      worker.targetFood = youngColonyStressTest ? null : chooseYoungColonyFood(worker);
      worker.turnClock = rand(1.2, 2.6);
    }
    if (worker.targetFood) {
      const dx = worker.targetFood.x - worker.x;
      const dz = worker.targetFood.z - worker.z;
      const distance = Math.hypot(dx, dz);
      worker.desired = Math.atan2(dz, dx) + Math.sin(worker.phase * 0.13) * 0.09;
      worker.state = `foraging by ${navigation.guidance}`;
      const network = colonyForagingNetworks.get(worker.colonyId);
      if (network && navigation.guidance === 'private route memory') network.memoryGuidedSteps += dt;
      else if (network && navigation.guidance === 'social sector activation') network.socialGuidedSteps += dt;
      if (network) {
        const sector = network.sectors[navigation.sectorId ?? 0];
        advanceForagingSearch(worker, network, sector, dt);
      }
      if (distance < 0.42 && worker.targetFood.amount > 0) {
        loadWorkerFoodCargo(worker, worker.targetFood);
        recordFoodDiscovery(worker, worker.targetFood);
        removeFoodUnits(worker.targetFood, 1, 'ant harvest');
      }
    } else {
      const network = colonyForagingNetworks.get(worker.colonyId);
      const sector = network && navigation.sectorId != null ? network.sectors[navigation.sectorId] : null;
      if (network && sector) {
        const target = foragingSearchTarget(worker, network, sector);
        worker.desired = Math.atan2(target.z - worker.z, target.x - worker.x) + Math.sin(worker.phase * 0.11) * 0.16;
        advanceForagingSearch(worker, network, sector, dt);
      } else if (worker.turnClock <= 0) worker.desired += rand(-0.9, 0.9);
      if (nestDistance > 7.5) worker.desired = Math.atan2(nestDz, nestDx);
      worker.state = 'searching the local sector for food';
    }
  }

  applyNeighborAvoidance(worker);
  worker.heading += clamp(wrapAngle(worker.desired - worker.heading), -dt * 3.6, dt * 3.6);
  const velocity = worker.speed * (1 - weather.rain * 0.24) * (worker.carrying ? 1.04 : 1);
  worker.x = clamp(worker.x + Math.cos(worker.heading) * velocity * dt, -HALF_W + 0.35, HALF_W - 0.35);
  worker.z = clamp(worker.z + Math.sin(worker.heading) * velocity * dt, -HALF_D + 0.35, HALF_D - 0.35);
  worker.distanceTraveled += velocity * dt;

  if (youngColonyStressTest) worker.health -= dt * 1.35;
  else {
    const seniority = Math.max(0, worker.ageDays - WORKER_SENESCENCE_DAYS);
    worker.health -= dt * seniority * WORKER_SENESCENCE_RATE * (worker.insideNest ? 0.72 : 1.18);
    if (worker.energy <= 0 && queen.colonyFood <= 0) worker.health -= dt * 0.07;
  }
}

function recordDescendantWorkerDeath(queen, worker, cause) {
  queen.workerDeaths++;
  queen.foundingDeaths++;
  recordLineageEvent('young-worker-died', queen, { workerId: worker.id, cause, caste: worker.workerCaste });
}

function collapseYoungColony(queen, cause) {
  if (queen.foundingStage === 'collapsed') return;
  const colony = getColony(queen.registeredColonyId);
  if (colony?.lifeHistory && queen.alive) killColonyQueen(colony, cause);
  queen.alive = false;
  queen.queenHealth = 0;
  queen.collapseCause = cause;
  queen.foundingStage = 'collapsed';
  queen.state = `young colony collapsed · ${cause}`;
  queen.foundingBrood.length = 0;
  for (const worker of queen.nanitics) markRegisteredWorkerDead(worker, 'colony collapse');
  if (colony) removeDeadRegisteredWorkers(colony);
  if (colony) {
    colony.status = 'extinct';
    colony.lifeHistory.lifeStage = 'extinct';
    if (colony.lifeHistory.extinctAt == null) regionalLifeHistory.colonyExtinctions++;
    colony.lifeHistory.extinctAt = simTime;
    colony.lifeHistory.territoryState = 'vacant';
    const vacancy = regionalLifeHistory.vacancies.find((item) => item.id === colony.lifeHistory.vacancyId);
    if (vacancy && vacancy.state !== 'recolonized') vacancy.state = 'vacant';
    recordColonyLifeEvent('colony-extinct', colony, {
      vacancyId: colony.lifeHistory.vacancyId,
      cause,
      label: `${colony.displayName} became extinct`,
    });
  }
  recordLineageEvent('colony-collapsed', queen, { cause, workersEclosed: queen.workersEclosed, foodDelivered: queen.foodDelivered });
}

function updateYoungColony(queen, dt, queenMayLay = true) {
  const colony = getColony(queen.registeredColonyId);
  queen.colonyFood = acceptColonyStoredFood(queen.registeredColonyId, queen.colonyFood);
  queen.colonyFood = consumeColonyStoredFood(
    queen.registeredColonyId,
    queen.colonyFood,
    dt,
    queen.nanitics.length,
    { baseRate: 0.004, workerRate: 0.0014 },
  );
  const activeNurses = queen.nanitics.filter((worker) => worker.alive && worker.insideNest).length;
  const requiredNurses = Math.max(1, Math.ceil(queen.foundingBrood.length / 3.4));
  const careRatio = clamp(activeNurses / requiredNurses, 0.35, 1.15);
  let demographics = demographicStateFor(colony, careRatio);
  if (colony) colony.demographics = demographics;
  for (const worker of queen.nanitics) {
    updateWorker(workerWorld, colony, worker, dt);
    worker.health -= dt * demographics.starvationPressure * 0.082;
    worker.health -= dt * demographics.crowdingPressure * 0.014;
  }
  for (let i = queen.nanitics.length - 1; i >= 0; i--) {
    const worker = queen.nanitics[i];
    if (worker.health > 0) continue;
    const cause = youngColonyStressTest ? 'controlled resource collapse'
      : demographics.starvationPressure > 0.45 ? 'starvation'
        : demographics.crowdingPressure > 0.6 ? 'crowding stress' : 'age';
    markRegisteredWorkerDead(worker, cause);
  }
  if (colony) removeDeadRegisteredWorkers(colony);

  queen.layClock -= dt;
  demographics = demographicStateFor(colony, careRatio);
  if (colony) colony.demographics = demographics;
  updateAlateCohort(queen.reproduction, dt);
  const reproductivelyMature = colonyIsReproductivelyMature(colony);
  if (queenMayLay && reproductivelyMature
    && (environment.season.name === 'spring' || environment.season.name === 'summer') && queen.colonyFood > 48) {
    queen.reproduction.reproductiveBudget = clamp(
      queen.reproduction.reproductiveBudget + dt * 0.016 * clamp((queen.colonyFood - 48) / 50, 0, 1), 0, 18,
    );
  }
  if (queen.layClock <= 0) {
    const canLay = queenMayLay && demographics.layingDrive > 0.08
      && queen.foundingBrood.length < demographics.broodCapacity
      && queen.foundingBrood.length < TECHNICAL_BROOD_LIMIT;
    let destiny = 'worker';
    if (canLay && reproductivelyMature && queen.nanitics.length >= 45 && queen.colonyFood > 58
      && queen.reproduction.reproductiveBudget >= reproductiveCost('male') && random() < 0.36) {
      const candidate = chooseSexualDestiny(queen.reproduction);
      if (queen.reproduction.reproductiveBudget >= reproductiveCost(candidate)) destiny = candidate;
    }
    if (canLay && addFoundingEgg(queen, 'colonyFood', destiny)) {
      queen.state = destiny === 'worker' ? 'laying a food-supported worker cohort' : `investing in a ${destiny} alate`;
    }
    queen.layClock = canLay
      ? rand(5.2, 7.4) / clamp(0.62 + demographics.layingDrive * 0.58, 0.62, 1.2)
      : rand(3.2, 5.4);
  }
  updateFoundingBrood(queen, dt);

  if (queenMayLay) {
    if (youngColonyStressTest) queen.queenHealth -= dt * 1.7;
    else if (queen.nanitics.length === 0 && queen.colonyFood <= 0) queen.queenHealth -= dt * 0.12;
    else if (queen.colonyFood > 4) queen.queenHealth = Math.min(100, queen.queenHealth + dt * 0.02);
  }

  if (queenMayLay && (queen.queenHealth <= 0 || (queen.nanitics.length === 0 && simTime - queen.openedAt > 24))) {
    collapseYoungColony(queen, queen.queenHealth <= 0 ? 'queen starvation' : 'loss of the nanitic workforce');
    return;
  }
  if (queenMayLay && queen.nanitics.length >= 18 && queen.colonyFood > 18
    && (colony?.status === 'incipient' || colony?.status === 'young')) {
    if (colony) colony.status = 'established';
    queen.foundingStage = 'established';
    queen.state = 'established young colony with sustained foraging';
    recordLineageEvent('colony-established', queen, { workers: queen.nanitics.length, storedFood: Number(queen.colonyFood.toFixed(1)) });
  } else if (queen.foundingStage === 'young') {
    queen.state = demographics.layingDrive < 0.08
      ? `young colony constrained by ${demographics.limitingFactor}` : 'young colony sustaining queen and brood';
  } else if (!queenMayLay) {
    queen.state = 'orphaned workers maintaining the former nest';
  } else if (queen.foundingStage === 'established') {
    queen.state = environment.season.name === 'winter'
      ? 'established colony in winter conservation'
      : demographics.layingDrive < 0.08
        ? `established colony constrained by ${demographics.limitingFactor}`
        : 'established colony sustaining foraging and brood';
  }
}

function updateFoundingQueen(queen, dt) {
  if (!queen.alive) {
    const colony = getColony(queen.registeredColonyId);
    if (colony && colony.status !== 'extinct') updateYoungColony(queen, dt, false);
    return;
  }
  queen.stageAge += dt;
  if (!queen.registeredColonyId) {
    const exposure = queen.foundingStage === 'assessing' || queen.foundingStage === 'relocating';
    const siteStress = Math.max(0, 0.5 - queen.siteQuality) * dt * 0.008;
    const reserveStress = queen.reserves < 24 ? dt * (24 - queen.reserves) * 0.0009 : 0;
    const weatherStress = exposure ? dt * weather.rain * 0.0022 : 0;
    const coldStress = environment.season.name === 'winter' ? dt * 0.00035 : 0;
    queen.foundingStress += siteStress + reserveStress + weatherStress + coldStress;
    if (queen.reserves <= 0 || queen.foundingStress >= queen.failureThreshold) {
      failFoundation(queen, queen.reserves <= 0 ? 'reserve exhaustion' : 'site and weather stress');
      return;
    }
  }

  if (queen.foundingStage === 'assessing') {
    queen.reserves = Math.max(0, queen.reserves - dt * 0.028);
    queen.state = `assessing soil and shelter · quality ${queen.siteQuality.toFixed(2)}`;
    if (queen.stageAge < 4.2 + (1 - queen.siteQuality) * 3.2) return;
    if (queen.siteQuality < 0.52 && queen.siteRejections < 2) {
      queen.siteRejections++;
      recordLineageEvent('founding-site-rejected', queen, { quality: Number(queen.siteQuality.toFixed(2)), rejection: queen.siteRejections });
      queen.relocationTarget = chooseFoundingSite(queen.natalColonyId);
      if (queen.relocationTarget.vacancyId !== queen.settledVacancyId) {
        releaseVacancyClaim(queen);
        queen.settledVacancyId = null;
        if (queen.relocationTarget.vacancyId) claimTerritoryVacancy(queen, queen.relocationTarget.vacancyId);
      }
      queen.foundingStage = 'relocating';
      queen.stageAge = 0;
      queen.state = 'rejecting site and searching nearby';
      return;
    }
    queen.foundingStage = 'excavating';
    queen.acceptedAt = simTime;
    queen.stageAge = 0;
    queen.state = 'excavating the claustral founding chamber';
    recordLineageEvent('founding-site-accepted', queen, { quality: Number(queen.siteQuality.toFixed(2)), x: Number(queen.x.toFixed(1)), z: Number(queen.z.toFixed(1)) });
    return;
  }

  if (queen.foundingStage === 'relocating') {
    const dx = queen.relocationTarget.x - queen.x;
    const dz = queen.relocationTarget.z - queen.z;
    const distance = Math.hypot(dx, dz);
    queen.heading = Math.atan2(dz, dx);
    queen.reserves = Math.max(0, queen.reserves - dt * 0.052);
    if (distance > 0.1) {
      queen.x += (dx / distance) * Math.min(distance, dt * 0.52);
      queen.z += (dz / distance) * Math.min(distance, dt * 0.52);
      return;
    }
    queen.siteQuality = evaluateFoundingSite(queen.x, queen.z);
    queen.foundingStage = 'assessing';
    queen.stageAge = 0;
    queen.relocationTarget = null;
    return;
  }

  if (queen.foundingStage === 'excavating') {
    const excavationRate = 0.041 + queen.siteQuality * 0.018 + queen.genome.size * 0.004;
    queen.chamberProgress = clamp(queen.chamberProgress + dt * excavationRate, 0, 1);
    queen.reserves = Math.max(0, queen.reserves - dt * (0.11 + (1 - queen.siteQuality) * 0.05));
    queen.state = `excavating and sealing chamber · ${Math.round(queen.chamberProgress * 100)}%`;
    if (queen.chamberProgress >= 1) {
      queen.foundingStage = 'claustral';
      queen.stageAge = 0;
      queen.state = 'sealed underground · converting reserves into first brood';
      recordLineageEvent('claustral-chamber-sealed', queen, { reserves: Number(queen.reserves.toFixed(1)) });
    }
    return;
  }

  if (queen.foundingStage === 'opening') {
    queen.entranceOpenProgress = clamp(queen.entranceOpenProgress + dt * (0.068 + queen.nanitics.length * 0.003), 0, 1);
    queen.reserves = Math.max(0, queen.reserves - dt * 0.008);
    queen.state = `nanitics opening the founding chamber · ${Math.round(queen.entranceOpenProgress * 100)}%`;
    updateFoundingBrood(queen, dt);
    if (queen.entranceOpenProgress >= 1) {
      queen.foundingStage = 'young';
      queen.openedAt = simTime;
      const colony = getColony(queen.registeredColonyId);
      if (colony) colony.status = 'young';
      for (const worker of queen.nanitics) worker.nestTimer = rand(0.4, 3.2);
      queen.state = 'young colony entrance open · nanitics beginning to forage';
      recordLineageEvent('founding-chamber-opened', queen, { workers: queen.nanitics.length, reserves: Number(queen.reserves.toFixed(1)) });
    }
    return;
  }

  if (queen.foundingStage === 'young' || queen.foundingStage === 'established') {
    updateYoungColony(queen, dt);
    return;
  }

  if (queen.foundingStage === 'claustral' || queen.foundingStage === 'incipient') {
    queen.reserves = Math.max(0, queen.reserves - dt * (0.012 + queen.nanitics.length * 0.0025));
    queen.layClock -= dt;
    const eggTarget = 5 + Math.floor(queen.siteQuality * 3);
    if (queen.layClock <= 0 && queen.eggsLaid < eggTarget && queen.foundingBrood.length < 9 && queen.reserves > 28) {
      addFoundingEgg(queen);
      queen.layClock = rand(3, 4.4);
      queen.state = queen.registeredColonyId ? 'laying a second nanitic cohort' : 'laying the first claustral egg cohort';
    }
    updateFoundingBrood(queen, dt);
    for (const worker of queen.nanitics) worker.ageDays += dt * SIM_DAYS_PER_SECOND;
    if (queen.registeredColonyId && queen.nanitics.length >= 3) {
      queen.state = 'incipient colony · nanitics tending queen and brood';
    }
    if (queen.registeredColonyId && queen.nanitics.length >= 4) {
      queen.foundingStage = 'opening';
      queen.stageAge = 0;
      queen.state = 'nanitics cutting an exit from the sealed chamber';
      recordLineageEvent('entrance-excavation-started', queen, { workers: queen.nanitics.length });
    }
  }
}

function updateFoundingQueens(dt) {
  for (const queen of regionalMating.matedQueens) updateFoundingQueen(queen, dt);
}

function tryAirborneMating(gyne) {
  if (gyne.mates.length >= gyne.targetMateCount || gyne.mateCooldown > 0) return;
  const candidates = regionalMating.flyingAlates.filter((male) => male.destiny === 'male'
    && male.state !== 'post-mating decline'
    && male.originColonyId !== gyne.originColonyId
    && !gyne.usedMaleIds.includes(male.id)
    && Math.hypot(male.x - gyne.x, male.y - gyne.y, male.z - gyne.z) < 4.2);
  if (candidates.length === 0) return;
  candidates.sort((a, b) => Math.hypot(a.x - gyne.x, a.y - gyne.y, a.z - gyne.z)
    - Math.hypot(b.x - gyne.x, b.y - gyne.y, b.z - gyne.z));
  const male = candidates[0];
  gyne.usedMaleIds.push(male.id);
  gyne.mates.push({
    id: male.id,
    lineageId: male.lineageId,
    originColonyId: male.originColonyId,
    genome: male.genome,
  });
  gyne.mateCooldown = rand(0.85, 1.4);
  gyne.state = `mating in flight · ${gyne.mates.length}/${gyne.targetMateCount}`;
  male.state = 'post-mating decline';
  male.life = Math.min(male.life, rand(1.6, 2.8));
  regionalMating.matingEvents++;
  if (gyne.mates.length >= gyne.targetMateCount) beginGyneDescent(gyne);
}

function removeFlyingAlate(index, outcome) {
  const alate = regionalMating.flyingAlates[index];
  regionalMating.flyingAlates.splice(index, 1);
  if (alate.destiny === 'male') {
    if (outcome === 'dispersed') regionalMating.malesDispersed++;
    else regionalMating.malesDied++;
  } else if (outcome === 'failed') regionalMating.gynesFailed++;
}

function updateNuptialFlight(dt) {
  regionalMating.lastSuitability = nuptialFlightSuitability();
  const matureMales = reproductiveFlightColonies().reduce(
    (sum, colony) => sum + matureFlightAlates(colony.reproduction, 'male').length, 0,
  );
  const enoughAlates = availableMatureGynes() > 0
    && matureMales > 0;
  const successionReady = requestedSuccessionScenario !== 'amber' || availableTerritoryVacancies().length > 0;
  if (forceFlightWhenReady && regionalMating.windowsOpened === 0 && availableMatureGynes() > 0 && successionReady) openNuptialFlight(true);
  else if (!manualFlightOnly && !forceFlightWhenReady && !regionalMating.flightWindow.active && enoughAlates
    && (ecologicalBalance.annualFlightWindows.get(Math.floor(simTime / ECOLOGICAL_YEAR_SECONDS)) || 0) < 1
    && simTime - regionalMating.lastFlightAt > 60
    && regionalMating.lastSuitability > 0.38) openNuptialFlight(false);

  if (regionalMating.flightWindow.active) {
    regionalMating.flightWindow.timer -= dt;
    if (regionalMating.flightWindow.timer <= 0 || weather.rain > 0.36) {
      regionalMating.flightWindow.active = false;
      regionalMating.flightWindow.closedAt = simTime;
    }
  }

  for (let i = regionalMating.flyingAlates.length - 1; i >= 0; i--) {
    const alate = regionalMating.flyingAlates[i];
    alate.airborneAge += dt;
    alate.life -= dt;
    alate.phase += dt * (alate.destiny === 'gyne' ? 7.4 : 9.2);
    alate.mateCooldown -= dt;

    if (alate.destiny === 'gyne' && alate.state === 'descending toward a founding site') {
      const dx = alate.landingSite.x - alate.x;
      const dz = alate.landingSite.z - alate.z;
      const distance = Math.hypot(dx, dz);
      alate.heading = Math.atan2(dz, dx);
      if (distance > 0.12) {
        alate.x += (dx / distance) * Math.min(distance, dt * alate.speed * 1.15);
        alate.z += (dz / distance) * Math.min(distance, dt * alate.speed * 1.15);
      }
      const landingHeight = groundHeight(alate.landingSite.x, alate.landingSite.z) + 0.18;
      alate.y = Math.max(landingHeight, alate.y - dt * 0.72);
      if (distance < 0.16 && alate.y <= landingHeight + 0.02) {
        completeGyneDealation(alate);
        removeFlyingAlate(i, 'landed');
      }
      continue;
    }

    if (alate.destiny === 'male' && !regionalMating.flightWindow.active && alate.state !== 'post-mating decline') {
      alate.state = 'dispersing beyond the study plot';
      alate.heading += clamp(wrapAngle(alate.dispersalHeading - alate.heading), -dt * 2.2, dt * 2.2);
      alate.x += Math.cos(alate.heading) * alate.speed * dt * 1.28;
      alate.z += Math.sin(alate.heading) * alate.speed * dt * 1.28;
      alate.y += (4.8 - alate.y) * Math.min(1, dt * 0.7);
      if (Math.abs(alate.x) > HALF_W + 2 || Math.abs(alate.z) > HALF_D + 2 || alate.life <= 0) {
        removeFlyingAlate(i, 'dispersed');
      }
      continue;
    }

    const dx = regionalMating.swarmCenter.x - alate.x;
    const dz = regionalMating.swarmCenter.z - alate.z;
    const distance = Math.max(0.001, Math.hypot(dx, dz));
    const orbit = alate.destiny === 'gyne' ? 0.22 : 0.42;
    const desired = Math.atan2(dz, dx) + Math.sin(alate.phase * 0.21) * orbit;
    alate.heading += clamp(wrapAngle(desired - alate.heading), -dt * 2.8, dt * 2.8);
    alate.x += Math.cos(alate.heading) * alate.speed * dt;
    alate.z += Math.sin(alate.heading) * alate.speed * dt;
    const targetY = regionalMating.swarmCenter.y + Math.sin(alate.phase * 0.33 + distance) * 0.72;
    alate.y += (targetY - alate.y) * Math.min(1, dt * 1.25);
    alate.state = alate.state === 'post-mating decline' ? alate.state
      : distance > 3.2 ? 'flying toward the regional swarm' : 'circling in the regional mating swarm';

    if (alate.destiny === 'gyne' && alate.airborneAge > 2.4) {
      tryAirborneMating(alate);
      if (!regionalMating.flightWindow.active && alate.mates.length >= 2) beginGyneDescent(alate);
    }

    if (alate.life <= 0) {
      if (alate.destiny === 'gyne' && alate.mates.length >= 2) {
        beginGyneDescent(alate);
        alate.life = 12;
      } else removeFlyingAlate(i, alate.destiny === 'male' && distance > 7 ? 'dispersed' : 'failed');
    }
  }

  for (const queen of regionalMating.matedQueens) {
    queen.heading += Math.sin(simTime * 0.22 + queen.x) * dt * 0.08;
  }
  updateFoundingQueens(dt);
  updateShedWingLifecycle(dt);
}

function chooseNestPurpose(ant) {
  if (ant.carrying) return 'vestibule';
  if (ant.assignedRole === 'transfer') return 'vestibule';
  if (ant.assignedRole === 'nurse' && brood.length > 0) return 'nursery';
  if (weather.rain > 0.45 || ant.energy < 38) return 'rest';
  return random() < 0.42 ? 'nursery' : 'rest';
}

function antNestRoute(ant) {
  return ant.nestRoute || NEST_ROUTES[ant.nestRouteKey] || NEST_ROUTES.rest;
}

function setNestPosition(ant) {
  const route = antNestRoute(ant);
  const leg = route.legs[ant.nestLeg];
  placeAntOnNestCurve(ant, homeNestCurve(leg.segmentIndex), ant.nestT);
}

function placeAntOnNestCurve(ant, curve, t) {
  curve.getPointAt(t, ant.nestPosition);
  const tangent = curve.getTangentAt(t);
  const side = new THREE.Vector3().crossVectors(tangent, Y_AXIS);
  if (side.lengthSq() < 0.01) side.set(1, 0, 0);
  side.normalize();
  const up = new THREE.Vector3().crossVectors(side, tangent).normalize();
  const radius = ant.nestLaneRadius;
  ant.nestPosition.addScaledVector(side, Math.cos(ant.nestLaneAngle) * radius);
  ant.nestPosition.addScaledVector(up, Math.sin(ant.nestLaneAngle) * radius * 0.72);
}

function beginNestJourney(ant, purpose = chooseNestPurpose(ant), alreadyInside = false) {
  const route = NEST_ROUTES[purpose] || NEST_ROUTES.rest;
  ant.insideNest = true;
  ant.location = 'nest';
  ant.nestRouteKey = purpose;
  ant.nestRoute = null;
  ant.excavationProject = null;
  ant.nestDirection = 1;
  ant.nestLeg = alreadyInside ? route.legs.length - 1 : 0;
  ant.nestT = alreadyInside ? route.legs[route.legs.length - 1].to : route.legs[0].from;
  ant.nestMode = alreadyInside ? 'working' : 'traveling';
  ant.nestTimer = alreadyInside ? rand(2.8, 7.2) : 0;
  ant.pendingDelivery = ant.carrying;
  ant.nestPosition ||= new THREE.Vector3();
  ant.state = alreadyInside ? `working in ${route.label}` : `descending to ${route.label}`;
  setNestPosition(ant);
}

function chooseExcavationProject() {
  const projects = activeConstructionProjects();
  if (projects.length === 0) return null;
  projects.sort((a, b) => a.segment.activeDiggers - b.segment.activeDiggers || a.segment.progress - b.segment.progress);
  return projects[0].index;
}

function beginExcavationJourney(ant, projectIndex = chooseExcavationProject()) {
  if (projectIndex == null) return false;
  const route = buildExcavationRoute(projectIndex);
  ant.insideNest = true;
  ant.location = 'nest';
  ant.nestRouteKey = 'excavation';
  ant.nestRoute = route;
  ant.excavationProject = projectIndex;
  ant.nestDirection = 1;
  ant.nestLeg = 0;
  ant.nestT = route.legs[0].from;
  ant.nestMode = 'traveling';
  ant.nestTimer = 0;
  ant.pendingDelivery = false;
  ant.nestPosition ||= new THREE.Vector3();
  ant.state = `descending to ${tunnelSegments[projectIndex].name}`;
  setNestPosition(ant);
  return true;
}

function spawnAnt(initialPopulation = false, options = {}) {
  if (!hasTechnicalWorkerRoom(HOME_COLONY_ID, ants.length)) return null;
  const angle = rand(0, Math.PI * 2);
  const ageDays = options.ageDays ?? rand(7, 47);
  const genome = options.genome || mutateGenome(homeQueenGenome, initialPopulation ? 0.09 : 0.055);
  const workerCaste = options.workerCaste || (random() < 0.13 ? 'major' : random() < 0.44 ? 'minor' : 'media');
  const casteScale = workerCaste === 'major' ? 1.12 : workerCaste === 'minor' ? 0.9 : 1;
  const ant = {
    id: nextAntId++,
    colonyId: HOME_COLONY_ID,
    colony: 'formicarium',
    x: NEST.x + Math.cos(angle) * rand(0.56, 0.82),
    z: NEST.y + Math.sin(angle) * rand(0.56, 0.82),
    heading: angle,
    desired: angle,
    carrying: false,
    carryingNutrition: 1,
    carryingKind: null,
    transferCargo: null,
    phase: rand(0, 10),
    speed: rand(0.78, 1.18) * genome.speed,
    size: rand(0.9, 1.06) * casteScale * genome.size,
    laneBias: rand(-0.15, 0.15),
    turnClock: rand(0.2, 1.8),
    pause: rand(0, 0.35),
    insideNest: false,
    nestTimer: rand(0.3, 3.8),
    nestPosition: new THREE.Vector3(),
    nestLaneAngle: rand(0, Math.PI * 2),
    nestLaneRadius: rand(0.07, 0.23),
    location: 'surface',
    tendency: ageDays < 14 ? 'nurse' : random() < clamp(0.58 * genome.foraging, 0.42, 0.74) ? 'forager' : random() < 0.72 ? 'nurse' : 'excavator',
    assignedRole: 'forager',
    workerCaste,
    genome,
    generation: options.generation || 0,
    parentage: options.parentage || { damId: 'founding-population', sireId: null, sireLineageId: null, ploidy: 'diploid' },
    soilCargo: false,
    sanitationCargo: false,
    sanitationTarget: null,
    spoilTarget: null,
    excavationProject: null,
    nestRoute: null,
    ageDays,
    energy: rand(62, 100),
    health: clamp(rand(88, 100) + (genome.diseaseResistance - 1) * 12, 76, 100),
    infection: 0,
    infectionTimer: 0,
    alive: true,
    borderCooldown: rand(0, 0.7),
    trips: 0,
    tasksCompleted: 0,
    distanceTraveled: 0,
    responseThresholds: {
      nurse: rand(0.26, 0.7),
      transfer: rand(0.3, 0.72),
      excavator: rand(0.32, 0.78),
      sanitizer: rand(0.42, 0.82),
      forager: rand(0.28, 0.76),
    },
    taskExperience: { nurse: 0, transfer: 0, excavator: 0, sanitizer: 0, forager: initialPopulation ? rand(0, 5) : 0 },
    state: 'exploring',
  };
  ensureWorkerNavigation(ant, initialPopulation);
  ant.assignedRole = ant.tendency;
  ants.push(ant);
  const registeredColony = getColony(HOME_COLONY_ID);
  if (registeredColony) {
    indexWorker(ant, registeredColony);
    surfaceWorkersNeedingRefresh.add(ant);
  }
  if (options.newborn) {
    ant.tendency = 'nurse';
    ant.assignedRole = 'nurse';
    ant.energy = rand(72, 88);
    ant.state = 'newly eclosed in nursery';
    beginNestJourney(ant, 'nursery', true);
    ant.nestTimer = rand(7, 12);
  } else if (random() < 0.28) beginNestJourney(ant, ant.tendency === 'nurse' ? 'nursery' : 'rest', true);
  else if (initialPopulation) {
    const spreadAngle = rand(0, Math.PI * 2);
    const spreadRadius = Math.sqrt(random()) * rand(2.2, 12.5);
    ant.x = clamp(NEST.x + Math.cos(spreadAngle) * spreadRadius, -HALF_W + 0.7, HALF_W - 0.7);
    ant.z = clamp(NEST.y + Math.sin(spreadAngle) * spreadRadius * 0.72, -HALF_D + 0.7, HALF_D - 0.7);
    ant.heading = rand(0, Math.PI * 2);
    ant.desired = ant.heading;
  }
  return ant;
}
for (let i = 0; i < 138; i++) spawnAnt(true);
for (let i = 0; i < 10; i++) addBrood('egg', rand(0, BROOD_STAGE_SECONDS.egg * 0.95));
for (let i = 0; i < 11; i++) addBrood('larva', rand(0, BROOD_STAGE_SECONDS.larva * 0.92));
for (let i = 0; i < 8; i++) addBrood('pupa', rand(0, BROOD_STAGE_SECONDS.pupa * 0.88));
addBrood('pupa', BROOD_STAGE_SECONDS.pupa * 0.78, null, 1, { destiny: 'male' });
addBrood('pupa', BROOD_STAGE_SECONDS.pupa * 0.7, null, 1, { destiny: 'gyne' });
addBrood('larva', BROOD_STAGE_SECONDS.larva * 0.66, null, 1, { destiny: 'male' });

const colonySurvival = {
  mode: 'growth',
  deaths: 0,
  predatorDeaths: 0,
  diseaseDeaths: 0,
  starvationDeaths: 0,
  conflictDeaths: 0,
  outbreaks: 0,
  recoveries: 0,
  sanitized: 0,
  outbreakClock: 34,
};
const remains = [];
const remainsSpatialIndex = createSpatialHash({ cellSize: 2 });

function leaveWorkerRemains(ant) {
  if (ant.insideNest || remains.length >= 28) return;
  const material = antMaterials[0].clone();
  material.color.setHex(0x3c2920);
  material.transparent = true;
  material.opacity = 0.72;
  const mesh = new THREE.Mesh(antGeometry, material);
  mesh.position.set(ant.x, groundHeight(ant.x, ant.z) + 0.045, ant.z);
  mesh.rotation.y = -ant.heading - Math.PI / 2;
  mesh.scale.setScalar(ant.size * 0.82);
  surfaceGroup.add(mesh);
  const remain = { mesh, life: 48, x: ant.x, z: ant.z, colonyId: ant.colonyId || HOME_COLONY_ID };
  remains.push(remain);
  remainsSpatialIndex.add(remain);
}

function recordAmberWorkerDeath(ant, cause) {
  colonySurvival.deaths++;
  if (cause === 'predation') colonySurvival.predatorDeaths++;
  else if (cause === 'disease') colonySurvival.diseaseDeaths++;
  else if (cause === 'starvation') colonySurvival.starvationDeaths++;
  else if (cause === 'rival conflict') colonySurvival.conflictDeaths++;
  leaveWorkerRemains(ant);
  if (selectedAnt === ant) selectAnt(null);
}

function startPredatorVisit(forcedNearNest = false) {
  const surfaceWorkers = ants.filter((ant) => !ant.insideNest && ant.alive);
  if (surfaceWorkers.length === 0) return;
  const target = forcedNearNest
    ? surfaceWorkers.reduce((best, ant) => Math.hypot(ant.x - NEST.x, ant.z - NEST.y) < Math.hypot(best.x - NEST.x, best.z - NEST.y) ? ant : best)
    : surfaceWorkers[Math.floor(random() * surfaceWorkers.length)];
  const angle = forcedNearNest ? 0.58 : rand(0, Math.PI * 2);
  predator.x = forcedNearNest ? NEST.x + 3.4 : clamp(target.x + Math.cos(angle) * 3.4, -HALF_W + 0.7, HALF_W - 0.7);
  predator.z = forcedNearNest ? NEST.y + 2.3 : clamp(target.z + Math.sin(angle) * 3.4, -HALF_D + 0.7, HALF_D - 0.7);
  predator.heading = Math.atan2(target.z - predator.z, target.x - predator.x);
  predator.active = true;
  predator.timer = rand(26, 38);
  predator.attackCooldown = 0;
  predator.feedTimer = 0;
  predator.targetId = target.id;
  predatorMesh.visible = true;
  createSignal(predator.x, predator.z, 0xb44c3c);
}

function updatePredator(dt) {
  if (predatorsDisabled) { predator.active = false; predatorMesh.visible = false; return; }
  if (!predator.active) {
    predatorMesh.visible = false;
    if (simTime >= predator.nextVisit) startPredatorVisit();
    return;
  }
  predator.timer -= dt;
  predator.attackCooldown -= dt;
  predator.feedTimer -= dt;
  if (predator.feedTimer > 0) {
    let source = null;
    let bestFoodDistance = Infinity;
    for (const food of foods) {
      if (food.amount <= 0) continue;
      const distance = (food.x - predator.x) ** 2 + (food.z - predator.z) ** 2;
      if (distance < bestFoodDistance) { bestFoodDistance = distance; source = food; }
    }
    if (source) {
      const dx = source.x - predator.x;
      const dz = source.z - predator.z;
      predator.heading = Math.atan2(dz, dx);
      predator.x += Math.cos(predator.heading) * dt * 1.25;
      predator.z += Math.sin(predator.heading) * dt * 1.25;
      if (Math.hypot(dx, dz) < 0.72) {
        const stolen = Math.min(source.amount, dt * 1.15);
        removeFoodUnits(source, stolen, 'wildlife');
        predator.foodStolen += stolen;
      }
    }
    alignToGround(predatorMesh, predator.x, predator.z, -predator.heading - Math.PI / 2, 0.12);
    return;
  }
  let target = predator.targetId == null ? null
    : workerLookup.resolveRuntimeUid(workerRuntimeUid(HOME_COLONY_ID, predator.targetId));
  if (target && (!target.alive || target.insideNest)) target = null;
  if (!target) {
    target = nearestSurfaceWorkerAt(predator.x, predator.z, Math.hypot(WORLD_W, WORLD_D), {
      accept: (worker) => worker.colonyId === HOME_COLONY_ID,
    });
    predator.targetId = target?.id || null;
  }
  if (target) {
    const dx = target.x - predator.x;
    const dz = target.z - predator.z;
    const distance = Math.hypot(dx, dz);
    predator.heading = Math.atan2(dz, dx);
    predator.x += Math.cos(predator.heading) * dt * 2.02;
    predator.z += Math.sin(predator.heading) * dt * 2.02;
    if (distance < 0.46 && predator.attackCooldown <= 0) {
      target.health -= 52;
      target.state = 'injured by hunting beetle';
      predator.attackCooldown = 1.25;
      if (target.health <= 0) {
        markRegisteredWorkerDead(target, 'predation');
        predator.kills++;
        if (predator.kills % 3 === 0) predator.feedTimer = 6.5;
        predator.targetId = null;
      }
    }
  } else {
    const source = foods.find((food) => food.amount > 0);
    if (source) {
      const dx = source.x - predator.x;
      const dz = source.z - predator.z;
      predator.heading = Math.atan2(dz, dx);
      predator.x += Math.cos(predator.heading) * dt * 1.1;
      predator.z += Math.sin(predator.heading) * dt * 1.1;
      if (Math.hypot(dx, dz) < 0.7) {
        const stolen = Math.min(source.amount, dt * 0.7);
        removeFoodUnits(source, stolen, 'wildlife');
        predator.foodStolen += stolen;
      }
    }
  }
  alignToGround(predatorMesh, predator.x, predator.z, -predator.heading - Math.PI / 2, 0.12);
  if (predator.timer <= 0) {
    predator.active = false;
    predator.targetId = null;
    predator.nextVisit = simTime + rand(72, 108);
    predatorMesh.visible = false;
  }
}

function startSpiderVisit() {
  spider.webX = (NEST.x + RIVAL_NEST.x) * 0.5 + rand(-1.4, 1.4);
  spider.webZ = (NEST.y + RIVAL_NEST.y) * 0.5 + rand(-1.2, 1.2);
  spider.x = spider.webX + rand(-1.4, 1.4);
  spider.z = spider.webZ + rand(-1.1, 1.1);
  spider.heading = rand(0, Math.PI * 2);
  spider.timer = rand(34, 46);
  spider.attackCooldown = 0;
  spider.active = true;
  spiderMesh.visible = true;
  spiderWeb.visible = true;
  spiderWeb.position.set(spider.webX, groundHeight(spider.webX, spider.webZ) + 0.055, spider.webZ);
  createSignal(spider.webX, spider.webZ, 0xd5d0c8);
}

function webSlowAt(x, z) {
  if (!spider.active) return 1;
  const distance = Math.hypot(x - spider.webX, z - spider.webZ);
  return distance < 2.1 ? THREE.MathUtils.lerp(0.48, 0.9, clamp(distance / 2.1, 0, 1)) : 1;
}

function updateSpider(dt) {
  if (predatorsDisabled) { spider.active = false; spiderMesh.visible = false; spiderWeb.visible = false; return; }
  if (!spider.active) {
    if (simTime >= spider.nextVisit) startSpiderVisit();
    return;
  }
  spider.timer -= dt;
  spider.attackCooldown -= dt;
  const target = nearestSurfaceWorkerAt(spider.x, spider.z, Math.hypot(WORLD_W, WORLD_D), {
    accept: (worker) => (worker.colonyId === HOME_COLONY_ID || worker.colonyId === RIVAL_COLONY_ID)
      && Math.hypot(worker.x - spider.webX, worker.z - spider.webZ) <= 3.25,
  });
  const bestDistance = target ? Math.hypot(target.x - spider.x, target.z - spider.z) : Infinity;
  if (target) {
    spider.heading = Math.atan2(target.z - spider.z, target.x - spider.x);
    spider.x += Math.cos(spider.heading) * dt * 1.32;
    spider.z += Math.sin(spider.heading) * dt * 1.32;
    if (bestDistance < 0.52 && spider.attackCooldown <= 0) {
      target.health -= 34;
      target.state = 'bitten in spider web';
      spider.attackCooldown = 1.5;
      if (target.health <= 0) {
        if (target.colonyId === RIVAL_COLONY_ID) {
          markRegisteredWorkerDead(target, 'spider');
          spider.rivalKills++;
        } else {
          markRegisteredWorkerDead(target, 'predation');
          spider.homeKills++;
        }
        spider.kills++;
      }
    }
  } else {
    spider.heading = Math.atan2(spider.webZ - spider.z, spider.webX - spider.x);
    spider.x += Math.cos(spider.heading) * dt * 0.72;
    spider.z += Math.sin(spider.heading) * dt * 0.72;
  }
  spiderMesh.position.set(spider.x, groundHeight(spider.x, spider.z) + 0.16, spider.z);
  spiderMesh.rotation.y = -spider.heading;
  spiderWeb.material.opacity = 0.2 + Math.sin(simTime * 1.4) * 0.07;
  if (spider.timer <= 0) {
    spider.active = false;
    spiderMesh.visible = false;
    spiderWeb.visible = false;
    spider.nextVisit = simTime + rand(105, 145);
  }
}

function updateSurvival(dt) {
  environment.seasonIndex = (Math.floor(simTime / SEASON_SECONDS) + requestedSeasonOffset) % SEASONS.length;
  environment.seasonProgress = (simTime % SEASON_SECONDS) / SEASON_SECONDS;
  environment.season = SEASONS[environment.seasonIndex];
  const infected = ants.filter((ant) => ant.infection > 0);
  const prevalence = infected.length / Math.max(1, ants.length);
  const careRatio = colonyBiology.requiredNurses > 0
    ? colonyBiology.activeNurses / colonyBiology.requiredNurses : 1;
  const demographics = demographicStateFor(homeColonyRecord, careRatio);
  homeColonyRecord.demographics = demographics;
  environment.pressure = demographics.reserveRatio < 0.34 ? 'food crisis'
    : prevalence > 0.09 ? 'disease outbreak'
      : predator.active || spider.active ? 'predator alarm'
        : environment.season.name === 'winter' ? 'winter conservation' : 'stable';
  colonySurvival.mode = environment.pressure === 'stable' ? 'growth' : environment.pressure;

  colonySurvival.outbreakClock -= dt * (environment.season.name === 'autumn' ? 1.35 : 1);
  if (colonySurvival.outbreakClock <= 0 && ants.length > 70) {
    const candidates = ants.filter((ant) => ant.infection <= 0);
    const patient = candidates[Math.floor(random() * candidates.length)];
    if (patient) {
      patient.infection = rand(0.42, 0.7);
      patient.infectionTimer = rand(38, 58);
      colonySurvival.outbreaks++;
    }
    colonySurvival.outbreakClock = rand(82, 122);
  }

  for (const ant of ants) {
    if (!ant.alive) continue;
    const seniority = Math.max(0, ant.ageDays - WORKER_SENESCENCE_DAYS);
    ant.health -= dt * seniority * WORKER_SENESCENCE_RATE * (ant.insideNest ? 0.72 : 1.18);
    ant.health -= dt * demographics.starvationPressure * 0.072;
    ant.health -= dt * demographics.crowdingPressure * 0.012;
    if (ant.infection > 0) {
      ant.infectionTimer -= dt;
      ant.infection = clamp(ant.infection + dt * 0.004 / ant.genome.diseaseResistance, 0, 1);
      ant.health -= dt * (0.025 + ant.infection * 0.045) / ant.genome.diseaseResistance;
      if (ant.insideNest && random() < dt * 0.0022) {
        const susceptible = ants[Math.floor(random() * ants.length)];
        if (susceptible && susceptible.infection <= 0 && susceptible.insideNest && random() < 1 / susceptible.genome.diseaseResistance) {
          susceptible.infection = 0.28;
          susceptible.infectionTimer = rand(34, 54);
        }
      }
      if (ant.infectionTimer <= 0) {
        ant.infection = 0;
        colonySurvival.recoveries++;
      }
    } else if (ant.insideNest && storedFood > 24) {
      ant.health = Math.min(100, ant.health + dt * 0.018);
    }
    if (ant.health <= 0) {
      markRegisteredWorkerDead(ant, demographics.starvationPressure > 0.45 ? 'starvation'
        : ant.infection > 0 ? 'disease'
          : demographics.crowdingPressure > 0.6 ? 'crowding stress' : 'age');
    }
  }

  for (let i = remains.length - 1; i >= 0; i--) {
    const remain = remains[i];
    remain.life -= dt;
    remain.mesh.material.opacity = clamp(remain.life / 12, 0, 0.72);
    if (remain.life <= 0) {
      surfaceGroup.remove(remain.mesh);
      remain.mesh.material.dispose();
      remainsSpatialIndex.remove(remain);
      remains.splice(i, 1);
    }
  }
}

const rivalAnts = [];
const rivalBrood = [];
let nextRivalId = 1;
const rivalColony = {
  storedFood: demographicScenario === 'scarcity' ? 2 : demographicScenario === 'abundance' ? 220 : 82,
  delivered: 0,
  eggsLaid: 0,
  workersEclosed: 0,
  deaths: 0,
  layClock: 8,
  roleClock: 0,
  clashes: 0,
  ourCasualties: 0,
  rivalCasualties: 0,
  sanitized: 0,
  broodDeaths: 0,
  ageDeaths: 0,
  starvationDeaths: 0,
  crowdingDeaths: 0,
  technicalBlockedEclosions: 0,
};
const rivalEntranceBiology = {
  cache: [],
  capacity: 54,
  activation: 0.2,
  recentReturns: 0,
  foodReturned: 0,
  cacheDeposits: 0,
  contactEvents: 0,
  storageTransfers: 0,
  activeTransfers: 0,
};
for (let i = 0; i < 4; i++) rivalEntranceBiology.cache.push({ kind: 'seed', nutrition: 1, value: 1.35 });

function recordSlateWorkerDeath(rival, cause = 'territorial conflict') {
  rivalColony.deaths++;
  if (cause === 'territorial conflict') rivalColony.rivalCasualties++;
  else if (cause === 'starvation') rivalColony.starvationDeaths++;
  else if (cause === 'age') rivalColony.ageDeaths++;
  else if (cause === 'crowding stress') rivalColony.crowdingDeaths++;
  leaveWorkerRemains(rival);
}

function spawnRival(newborn = false, options = {}) {
  if (!hasTechnicalWorkerRoom(RIVAL_COLONY_ID, rivalAnts.length)) return null;
  const angle = rand(0, Math.PI * 2);
  const radius = newborn ? rand(0.4, 0.75) : Math.sqrt(random()) * rand(1.2, 8.5);
  const roleRoll = random();
  const genome = options.genome || mutateGenome(rivalQueenGenome, newborn ? 0.055 : 0.09);
  const rival = {
    id: nextRivalId++,
    colonyId: RIVAL_COLONY_ID,
    colony: 'rival',
    x: clamp(RIVAL_NEST.x + Math.cos(angle) * radius, -HALF_W + 0.5, HALF_W - 0.5),
    z: clamp(RIVAL_NEST.y + Math.sin(angle) * radius * 0.78, -HALF_D + 0.5, HALF_D - 0.5),
    heading: angle,
    desired: angle,
    phase: rand(0, 10),
    laneBias: rand(-0.18, 0.18),
    speed: rand(0.82, 1.16) * genome.speed,
    size: (roleRoll < 0.18 ? rand(1.03, 1.16) : rand(0.82, 1.02)) * genome.size,
    role: roleRoll < 0.18 ? 'guard' : roleRoll < 0.32 ? 'scout' : 'forager',
    assignedRole: roleRoll < 0.18 ? 'guard' : roleRoll < 0.32 ? 'scout' : 'forager',
    tendency: roleRoll < 0.18 ? 'guard' : roleRoll < 0.32 ? 'scout' : 'forager',
    workerCaste: roleRoll < 0.18 ? 'major' : roleRoll < 0.32 ? 'minor' : 'media',
    ageDays: options.ageDays ?? rand(newborn ? 0 : 12, newborn ? 1 : 48),
    energy: rand(62, 100),
    health: clamp((newborn ? 82 : rand(84, 100)) + (genome.diseaseResistance - 1) * 10, 72, 100),
    infection: 0,
    genome,
    generation: options.generation || 0,
    parentage: options.parentage || { damId: 'founding-population', sireId: null, sireLineageId: null, ploidy: 'diploid' },
    carrying: false,
    carryingNutrition: 1,
    carryingKind: null,
    transferCargo: null,
    transferTimer: 0,
    transferDuration: 0,
    previousRole: null,
    departureThreshold: rand(0.3, 0.74),
    targetFood: null,
    turnClock: rand(0.2, 1.5),
    fightCooldown: rand(0, 0.8),
    alive: true,
    insideNest: false,
    nestPosition: new THREE.Vector3(),
    nestHeading: 0,
    tasksCompleted: 0,
    trips: 0,
    distanceTraveled: 0,
    state: newborn ? 'newly eclosed' : 'patrolling rival territory',
  };
  ensureWorkerNavigation(rival, !newborn);
  rivalAnts.push(rival);
  const registeredColony = getColony(RIVAL_COLONY_ID);
  if (registeredColony) indexWorker(rival, registeredColony);
  return rival;
}

function addRivalBrood(stage = 'egg', stageAge = 0, genome = null, generation = 1, options = {}) {
  if (rivalBrood.length >= TECHNICAL_BROOD_LIMIT) return null;
  const destiny = options.destiny || 'worker';
  const inherited = genome ? {
    sex: destiny === 'male' ? 'male' : 'female',
    destiny,
    genome,
    parentage: options.parentage || { damId: 'founding-population', sireId: null, sireLineageId: null, ploidy: destiny === 'male' ? 'haploid' : 'diploid' },
  } : createOffspringInheritance('queen-slate-001', rivalQueenGenome, rivalReproduction, destiny);
  const item = {
    stage, stageAge, vigor: rand(0.88, 1.1), starvation: 0, generation,
    sex: inherited.sex, destiny: inherited.destiny, genome: inherited.genome, parentage: inherited.parentage,
  };
  rivalBrood.push(item);
  return item;
}

for (let i = 0; i < 68; i++) spawnRival(false);
for (let i = 0; i < 6; i++) addRivalBrood('egg', rand(0, BROOD_STAGE_SECONDS.egg));
for (let i = 0; i < 7; i++) addRivalBrood('larva', rand(0, BROOD_STAGE_SECONDS.larva));
for (let i = 0; i < 5; i++) addRivalBrood('pupa', rand(0, BROOD_STAGE_SECONDS.pupa));
addRivalBrood('pupa', BROOD_STAGE_SECONDS.pupa * 0.76, null, 1, { destiny: 'male' });
addRivalBrood('pupa', BROOD_STAGE_SECONDS.pupa * 0.68, null, 1, { destiny: 'gyne' });
addRivalBrood('larva', BROOD_STAGE_SECONDS.larva * 0.62, null, 1, { destiny: 'gyne' });

const homeColonyRecord = registerColony({
  id: HOME_COLONY_ID,
  lineageId: 'lineage-amber-001',
  displayName: 'Amber colony',
  workerPrefix: 'A',
  workerRuntimePolicy: 'amber',
  workerPresentation: { palette: 'amber' },
  speciesProfile: SPECIES_PROFILE,
  status: 'mature',
  ageAtStartYears: 7,
  foundedBy: null,
  nest: NEST,
  focusOffset: new THREE.Vector2(0.8, 0.25),
  undergroundFocusY: -3.75,
  undergroundDistance: 11.8,
  color: 0xa84f36,
  get maxWorkers() { return architectureWorkerCapacity(this.architecture); },
  technicalWorkerLimit: TECHNICAL_HOME_WORKER_LIMIT,
  workers: ants,
  brood,
  reproduction: homeReproduction,
  entrance: entranceBiology,
  pheromoneField: homePheromoneField,
  foragingNetwork: homeForagingNetwork,
  seedBank: homeSeedBank,
  queen: { id: 'queen-amber-001', alive: true, genome: homeQueenGenome },
  get storedFood() { return storedFood; },
  get foodDelivered() { return delivered; },
  get eggsLaid() { return queenEggsLaid; },
  get workersEclosed() { return workersEclosed; },
  get deaths() { return colonySurvival.deaths; },
});

const rivalColonyRecord = registerColony({
  id: RIVAL_COLONY_ID,
  lineageId: 'lineage-slate-001',
  displayName: 'Slate colony',
  workerPrefix: 'S',
  workerRuntimePolicy: 'slate',
  workerPresentation: { palette: 'slate' },
  encounterPolicy: { conflictColonyIds: [HOME_COLONY_ID] },
  speciesProfile: SPECIES_PROFILE,
  status: 'mature',
  ageAtStartYears: 6,
  foundedBy: null,
  nest: RIVAL_NEST,
  focusOffset: new THREE.Vector2(-0.4, 0.25),
  undergroundFocusY: -4.55,
  undergroundDistance: 10.8,
  color: 0x748fa6,
  get maxWorkers() { return architectureWorkerCapacity(this.architecture); },
  technicalWorkerLimit: TECHNICAL_RIVAL_WORKER_LIMIT,
  workers: rivalAnts,
  brood: rivalBrood,
  reproduction: rivalReproduction,
  entrance: rivalEntranceBiology,
  pheromoneField: rivalPheromoneField,
  foragingNetwork: rivalForagingNetwork,
  seedBank: rivalSeedBank,
  queen: { id: 'queen-slate-001', alive: true, genome: rivalQueenGenome },
  get storedFood() { return rivalColony.storedFood; },
  get foodDelivered() { return rivalColony.delivered; },
  get eggsLaid() { return rivalColony.eggsLaid; },
  get workersEclosed() { return rivalColony.workersEclosed; },
  get deaths() { return rivalColony.deaths; },
});

createColonyArchitecture(homeColonyRecord, {
  anchor: homeNestCurve(3).getPointAt(1),
  baseChambers: 4,
  baseCapacity: 150,
  baseBroodCapacity: 60,
  baseStorageCapacity: 118,
  legacyVisuals: true,
});
createColonyArchitecture(rivalColonyRecord, {
  anchor: rivalNestCurves[0].getPointAt(1),
  baseChambers: 4,
  baseCapacity: 76,
  baseBroodCapacity: 54,
  baseStorageCapacity: 88,
  legacyVisuals: true,
});
initializeColonyLifeHistory(homeColonyRecord);
initializeColonyLifeHistory(rivalColonyRecord);

const workerRuntime = createWorkerRuntime({
  policies: {
    amber: {
      phaseDelta: (worker, dt) => dt * (8.4 * worker.speed),
      update: (_world, _colony, worker, dt) => updateAmberWorkerPolicy(worker, dt),
      onDeath: (_world, _colony, worker, cause) => recordAmberWorkerDeath(worker, cause),
    },
    slate: {
      phaseDelta: (worker, dt) => dt * worker.speed * 8.1,
      update: (_world, _colony, worker, dt) => updateSlateWorkerPolicy(worker, dt),
      onDeath: (_world, _colony, worker, cause) => recordSlateWorkerDeath(worker, cause),
    },
    descendant: {
      phaseDelta: (_worker, dt) => dt * 7.8,
      update: (_world, colony, worker, dt) => updateDescendantWorkerPolicy(colony.queen, worker, dt),
      onDeath: (_world, colony, worker, cause) => recordDescendantWorkerDeath(colony.queen, worker, cause),
    },
  },
});
const workerWorld = {
  simDaysPerSecond: SIM_DAYS_PER_SECOND,
  indexWorker,
  removeWorkerIndex,
  nearestForeignWorker: (worker, radius) => nearestForeignSurfaceWorker(worker, radius),
};

function updateWorker(world, colony, worker, dt) {
  return workerRuntime.updateWorker(world, colony, worker, dt);
}

function markRegisteredWorkerDead(worker, cause) {
  const colony = colonyForWorker(worker);
  if (!colony) return false;
  const marked = workerRuntime.markWorkerDead(workerWorld, colony, worker, cause);
  if (marked) {
    workerCensus.markDead(worker, colony);
    surfaceWorkersNeedingRefresh.add(worker);
  }
  return marked;
}

function removeDeadRegisteredWorkers(colony) {
  return workerRuntime.removeDeadWorkers(colony);
}

rebuildWorkerIndex();

function focusedColony() {
  return getColony(cameraRig.focusedColonyId) || homeColonyRecord;
}

function focusCameraOnColony(colony, underground = true) {
  if (!colony) return;
  cameraRig.focusedColonyId = colony.id;
  const architecture = colony.architecture;
  const useArchitectureFocus = architecture && (underground || cameraRig.desiredPitch < -0.1);
  if (useArchitectureFocus) {
    const focusNodes = nestNodes(architecture);
    const centroid = focusNodes.reduce(
      (sum, node) => sum.add(new THREE.Vector3(node.position.x, node.position.y, node.position.z)),
      new THREE.Vector3(),
    ).multiplyScalar(1 / Math.max(1, focusNodes.length));
    cameraRig.target.x = centroid.x;
    cameraRig.target.z = centroid.z;
    if (architecture.founding && underground) cameraRig.yaw = 1.22;
  } else {
    cameraRig.target.x = colony.nest.x + colony.focusOffset.x;
    cameraRig.target.z = colony.nest.y + colony.focusOffset.y;
  }
  if (underground && colony.undergroundView !== false) {
    cameraRig.desiredPitch = -0.32;
    cameraRig.desiredDistance = colony.undergroundDistance || 10.8;
  } else if (colony.undergroundView === false) {
    cameraRig.desiredPitch = 0.68;
    cameraRig.desiredDistance = colony.undergroundDistance || 8.2;
  }
  followingSelected = false;
}

function cycleFocusedColony() {
  const colonies = livingColonies();
  if (colonies.length === 0) return;
  const currentIndex = colonies.findIndex((colony) => colony.id === cameraRig.focusedColonyId);
  focusCameraOnColony(colonies[(currentIndex + 1 + colonies.length) % colonies.length]);
}

function moveRival(rival, dt, speedFactor = 1) {
  applyNeighborAvoidance(rival);
  const turnRate = dt * 4.2;
  rival.heading += clamp(wrapAngle(rival.desired - rival.heading), -turnRate, turnRate);
  const speed = rival.speed * speedFactor * (1 - weather.rain * 0.22) * webSlowAt(rival.x, rival.z);
  rival.x = clamp(rival.x + Math.cos(rival.heading) * speed * dt, -HALF_W + 0.35, HALF_W - 0.35);
  rival.z = clamp(rival.z + Math.sin(rival.heading) * speed * dt, -HALF_D + 0.35, HALF_D - 0.35);
  rival.distanceTraveled += speed * dt;
  rival.energy = Math.max(0, rival.energy - speed * dt * 0.07);
}

function nearestRivalFood(rival, pickupDistance = 0.58) {
  return foodSpatialIndex.nearest(
    rival.x,
    rival.z,
    pickupDistance,
    (food) => food.amount > 0,
  )?.entity || null;
}

function updateSlateWorkerPolicy(rival, dt) {
  if (!rival.alive) return;
  rival.turnClock -= dt;
  rival.fightCooldown -= dt;

  if (rival.insideNest) {
    rival.transferTimer -= dt;
    rival.energy = Math.min(100, rival.energy + dt * 0.7);
    rival.state = rival.role === 'interior' ? 'circulating through slate interior galleries' : 'moving cached food through slate nest';
    if (rival.role === 'interior') {
      if (rival.transferTimer <= 0) {
        rival.transferTimer = rand(4, 9);
        rival.nestExplorationTrips = (rival.nestExplorationTrips || 0) + 1;
      }
      return;
    }
    if (rival.transferTimer <= 0 && rival.transferCargo) {
      rivalColony.storedFood = acceptColonyStoredFood(RIVAL_COLONY_ID, rivalColony.storedFood, rival.transferCargo.value);
      storeSeedCargo(RIVAL_COLONY_ID, rival.transferCargo);
      rivalColony.delivered++;
      rivalEntranceBiology.storageTransfers++;
      rival.tasksCompleted++;
      rival.trips++;
      rival.transferCargo = null;
      if (rivalEntranceBiology.cache.length > 0) {
        rival.transferCargo = rivalEntranceBiology.cache.shift();
        rival.transferDuration = rival.transferTimer = rand(4.2, 7.4);
      } else {
        rival.insideNest = false;
        rival.role = rival.assignedRole = rival.previousRole || 'forager';
        rival.previousRole = null;
        const emergeAngle = rand(0, Math.PI * 2);
        rival.x = RIVAL_NEST.x + Math.cos(emergeAngle) * rand(0.42, 0.68);
        rival.z = RIVAL_NEST.y + Math.sin(emergeAngle) * rand(0.36, 0.58);
        rival.state = 'leaving slate entrance after transfer work';
      }
    }
    if (rival.transferTimer <= 0 && !rival.transferCargo && rival.role !== 'transfer') {
      rival.insideNest = false;
      const emergeAngle = rand(0, Math.PI * 2);
      rival.x = RIVAL_NEST.x + Math.cos(emergeAngle) * rand(0.5, 0.78);
      rival.z = RIVAL_NEST.y + Math.sin(emergeAngle) * rand(0.42, 0.66);
      rival.heading = emergeAngle;
      rival.desired = emergeAngle;
      rival.state = 'leaving slate interior for surface duty';
    }
    return;
  }

  if (predator.active) {
    const predatorDistance = Math.hypot(rival.x - predator.x, rival.z - predator.z);
    if (predatorDistance < 2.8) {
      rival.state = 'rival fleeing predator';
      rival.desired = Math.atan2(rival.z - predator.z, rival.x - predator.x);
      moveRival(rival, dt, 1.34);
      return;
    }
  }
  if (spider.active) {
    const spiderDistance = Math.hypot(rival.x - spider.x, rival.z - spider.z);
    if (spiderDistance < 2.5) {
      rival.state = webSlowAt(rival.x, rival.z) < 0.8 ? 'rival struggling in web' : 'rival fleeing spider';
      rival.desired = Math.atan2(rival.z - spider.z, rival.x - spider.x);
      moveRival(rival, dt, 1.28);
      return;
    }
  }

  const conflictColonyIds = rivalColonyRecord.encounterPolicy?.conflictColonyIds || [];
  const opponent = nearestForeignSurfaceWorker(rival, 1.15, {
    accept: (worker) => conflictColonyIds.includes(worker.colonyId),
  });
  const opponentDistance = opponent ? Math.hypot(opponent.x - rival.x, opponent.z - rival.z) : 1.15;
  if (opponent) {
    const toward = Math.atan2(opponent.z - rival.z, opponent.x - rival.x);
    const shouldFight = rival.role === 'guard' || rival.health > 54;
    rival.desired = shouldFight ? toward : toward + Math.PI;
    rival.state = shouldFight ? 'defending rival territory' : 'retreating from border';
    opponent.state = shouldFight ? 'fighting rival worker' : 'pressing territorial border';
    if (shouldFight) {
      rival.combatContactUntil = simTime + 0.45;
      opponent.combatContactUntil = simTime + 0.45;
    }
    if (shouldFight && opponentDistance < 0.42 && rival.fightCooldown <= 0 && opponent.borderCooldown <= 0) {
      const rivalPower = (rival.role === 'guard' ? 1.18 : 0.92) * rival.genome.aggression;
      const homePower = (opponent.workerCaste === 'major' ? 1.45 : opponent.workerCaste === 'minor' ? 0.82 : 1) * opponent.genome.aggression;
      opponent.health -= rand(4.8, 7.6) * rivalPower;
      rival.health -= rand(8.2, 12.8) * homePower;
      rival.fightCooldown = rand(0.75, 1.2);
      opponent.borderCooldown = rand(0.62, 0.95);
      rivalColony.clashes++;
      createSignal((rival.x + opponent.x) * 0.5, (rival.z + opponent.z) * 0.5, 0xb85d51);
      if (opponent.health <= 0) {
        markRegisteredWorkerDead(opponent, 'rival conflict');
        rivalColony.ourCasualties++;
      }
      if (rival.health <= 0) {
        markRegisteredWorkerDead(rival, 'territorial conflict');
      }
    }
    moveRival(rival, dt, shouldFight ? 1.08 : 1.3);
    return;
  }

  const homeDx = RIVAL_NEST.x - rival.x;
  const homeDz = RIVAL_NEST.y - rival.z;
  const homeDistance = Math.hypot(homeDx, homeDz);
  const navigation = ensureWorkerNavigation(rival, rival.generation === 0);
  expireStaleForagingMemory(rival, rivalForagingNetwork);
  if (rival.role === 'interior') {
    rival.desired = Math.atan2(homeDz, homeDx) + rival.laneBias * 0.24;
    rival.state = 'returning to slate interior reserve';
    if (homeDistance < 0.74) {
      rival.insideNest = true;
      rival.transferTimer = rand(4, 9);
      rival.nestPosition.set(RIVAL_NEST.x, groundHeight(RIVAL_NEST.x, RIVAL_NEST.y) - 0.7, RIVAL_NEST.y);
      return;
    }
    moveRival(rival, dt, 1.04);
    return;
  }
  if (!rival.carrying && navigation.learningWalk < 1 && homeDistance < 2.2 && rival.role !== 'guard') {
    const outward = Math.atan2(rival.z - RIVAL_NEST.y, rival.x - RIVAL_NEST.x);
    rival.desired = outward + Math.PI * 0.5 + Math.sin(rival.phase * 0.14) * 0.28;
    navigation.learningWalk = clamp(navigation.learningWalk + dt * 0.12, 0, 1);
    navigation.guidance = 'learning walk';
    rival.state = 'slate learning walk around the entrance';
    if (navigation.learningWalk >= 1) {
      rivalForagingNetwork.learningWalksCompleted++;
      chooseForagingSector(rival, rivalForagingNetwork, true);
    }
    moveRival(rival, dt, 0.58);
    return;
  }
  if (rival.carrying) {
    rival.state = 'returning food to rival stores';
    rival.desired = Math.atan2(homeDz, homeDx) + Math.sin(rival.phase * 0.18) * 0.05;
    rivalPherDeposit(rival.x, rival.z, 0.027);
    if (homeDistance < 0.72) {
      if (rivalEntranceBiology.cache.length < rivalEntranceBiology.capacity) {
        // This is a rare delivery event rather than a per-worker encounter
        // query. Preserve its sequential, current-position semantics exactly;
        // the hot per-Slate opponent lookup remains spatially indexed.
        const nearby = rivalAnts.filter((worker) => worker !== rival && !worker.insideNest && !worker.carrying
          && Math.hypot(worker.x - RIVAL_NEST.x, worker.z - RIVAL_NEST.y) < 1.35).length;
        recordForagingDelivery(rival);
        rivalEntranceBiology.cache.push({
          kind: rival.carryingKind || 'seed',
          nutrition: rival.carryingNutrition,
          value: 1.35 * rival.carryingNutrition,
          seedSpecies: rival.carryingSeedSpecies || null,
          sourcePlantId: rival.carryingSourcePlantId || null,
        });
        rivalEntranceBiology.foodReturned++;
        rivalEntranceBiology.cacheDeposits++;
        rivalEntranceBiology.contactEvents += nearby;
        rivalEntranceBiology.recentReturns = Math.min(1, rivalEntranceBiology.recentReturns + 0.2);
        rivalEntranceBiology.activation = Math.min(1, rivalEntranceBiology.activation + 0.11 + rival.carryingNutrition * 0.05 + Math.min(0.14, nearby * 0.012));
        clearWorkerFoodCargo(rival);
        rival.tasksCompleted++;
        rival.trips++;
        rival.targetFood = null;
        rival.state = 'depositing food in slate entrance cache';
      } else rival.state = 'waiting for space in slate entrance cache';
    }
    moveRival(rival, dt, 1.08);
    return;
  }

  if (rival.role === 'forager' && homeDistance < 1.7) {
    const departureDrive = 0.16 + rivalEntranceBiology.activation * 0.68 + rivalEntranceBiology.recentReturns * 0.28
      - weather.rain * 0.54 - (environment.season.name === 'winter' ? 0.2 : 0);
    if (departureDrive + rand(-0.08, 0.08) < rival.departureThreshold) {
      rival.state = 'waiting near slate entrance for returner contacts';
      rival.desired = Math.atan2(rival.z - RIVAL_NEST.y, rival.x - RIVAL_NEST.x) + Math.PI * 0.5;
      moveRival(rival, dt, 0.32);
      return;
    }
  }

  const scoutCanCollect = rival.role === 'scout'
    && (rivalColonyRecord.demographics?.reserveRatio || 0) < 1.1;
  const pickup = rival.role === 'forager' || scoutCanCollect ? nearestRivalFood(rival) : null;
  if (pickup) {
    loadWorkerFoodCargo(rival, pickup);
    rival.targetFood = pickup;
    recordFoodDiscovery(rival, pickup);
    removeFoodUnits(pickup, 1, 'ant harvest');
    rival.state = 'rival collecting contested food';
    return;
  }

  if (!rival.targetFood || rival.targetFood.amount <= 0 || rival.turnClock <= 0) {
    if (rival.targetFood && rival.targetFood.amount <= 0) recordForagingFailure(rival);
    const sector = chooseForagingSector(rival, rivalForagingNetwork);
    let bestSource = null;
    let bestScore = -Infinity;
    for (const food of liveFoodsInSector(rivalForagingNetwork, sector)) {
      const distance = Math.hypot(food.x - rival.x, food.z - rival.z);
      const memoryDistance = navigation.rememberedX == null ? 0 : Math.hypot(food.x - navigation.rememberedX, food.z - navigation.rememberedZ);
      const score = food.nutrition * 2.2 * rival.genome.foraging + Math.log1p(food.amount) - distance * 0.24
        - memoryDistance * navigation.confidence * 0.12 + sector.socialPulse * 0.35;
      if (score > bestScore) { bestScore = score; bestSource = food; }
    }
    rival.targetFood = bestSource;
    rival.turnClock = rand(0.8, 1.8);
  }

  if (rival.targetFood) {
    const foodAngle = Math.atan2(rival.targetFood.z - rival.z, rival.targetFood.x - rival.x);
    const scent = rivalPherSample(rival.x + Math.cos(rival.heading) * 0.8, rival.z + Math.sin(rival.heading) * 0.8);
    rival.desired = foodAngle + Math.sin(rival.phase * 0.11) * (scent > 0.03 ? 0.08 : 0.22);
    const sector = rivalForagingNetwork.sectors[navigation.sectorId ?? 0];
    const privateWeight = navigation.confidence * (0.55 + flightLightLevel() * 0.85);
    const socialWeight = sector.socialPulse * 0.58 + scent * 0.45;
    navigation.guidance = privateWeight > socialWeight ? 'private route memory' : socialWeight > 0.12 ? 'social sector activation' : 'sector exploration';
    if (privateWeight > socialWeight) rivalForagingNetwork.memoryGuidedSteps += dt;
    else rivalForagingNetwork.socialGuidedSteps += dt;
    rival.state = rival.role === 'scout' ? 'scouting contested food' : `foraging by ${navigation.guidance}`;
    advanceForagingSearch(rival, rivalForagingNetwork, sector, dt);
  } else {
    const sector = chooseForagingSector(rival, rivalForagingNetwork);
    const target = foragingSearchTarget(rival, rivalForagingNetwork, sector);
    rival.desired = Math.atan2(target.z - rival.z, target.x - rival.x)
      + Math.sin(rival.phase * 0.1 + rival.id) * 0.24;
    navigation.guidance = 'sector exploration';
    rival.state = rival.role === 'scout' ? 'surveying an unconfirmed sector' : 'patrolling a local search fan';
    advanceForagingSearch(rival, rivalForagingNetwork, sector, dt);
  }
  if (rival.role === 'guard' && homeDistance > 6.2) rival.desired = Math.atan2(homeDz, homeDx);
  if (homeDistance > 14) rival.desired = Math.atan2(homeDz, homeDx);
  moveRival(rival, dt);
}

function updateRivalColony(dt) {
  rivalColony.storedFood = acceptColonyStoredFood(RIVAL_COLONY_ID, rivalColony.storedFood);
  rivalColony.storedFood = consumeColonyStoredFood(
    RIVAL_COLONY_ID,
    rivalColony.storedFood,
    dt,
    rivalAnts.length,
    { baseRate: 0.015, workerRate: 0.001 },
  );
  updateAlateCohort(rivalReproduction, dt);
  if (rivalColonyRecord.queen.alive && colonyIsReproductivelyMature(rivalColonyRecord)
    && (environment.season.name === 'spring' || environment.season.name === 'summer') && rivalColony.storedFood > 62) {
    rivalReproduction.reproductiveBudget = clamp(
      rivalReproduction.reproductiveBudget + dt * 0.018 * clamp((rivalColony.storedFood - 62) / 55, 0, 1), 0, 18,
    );
  }
  const rivalCareRatio = rivalBrood.length > 0
    ? clamp(rivalAnts.length / Math.max(1, rivalBrood.length * 3.6), 0.42, 1) : 1;
  let demographics = demographicStateFor(rivalColonyRecord, rivalCareRatio);
  rivalColonyRecord.demographics = demographics;
  rivalEntranceBiology.activation = Math.max(0.08, rivalEntranceBiology.activation - dt * (0.023 + weather.rain * 0.014));
  rivalEntranceBiology.recentReturns = Math.max(0, rivalEntranceBiology.recentReturns - dt * 0.045);
  const activeRivalTransfers = rivalAnts.filter((rival) => rival.insideNest && rival.transferCargo).length;
  const targetRivalTransfers = rivalEntranceBiology.cache.length > 0 ? clamp(Math.ceil(rivalEntranceBiology.cache.length / 6), 1, 7) : 0;
  if (activeRivalTransfers < targetRivalTransfers) {
    const candidates = rivalAnts
      .filter((rival) => rival.alive && !rival.insideNest && !rival.carrying && rival.role !== 'guard'
        && Math.hypot(rival.x - RIVAL_NEST.x, rival.z - RIVAL_NEST.y) < 3.8)
      .sort((a, b) => {
        const aAgeBand = Math.abs(a.ageDays - 24);
        const bAgeBand = Math.abs(b.ageDays - 24);
        return aAgeBand - bAgeBand || b.energy - a.energy;
      });
    const needed = Math.min(targetRivalTransfers - activeRivalTransfers, candidates.length, rivalEntranceBiology.cache.length);
    for (let i = 0; i < needed; i++) {
      const transfer = candidates[i];
      transfer.previousRole = transfer.role;
      transfer.role = transfer.assignedRole = 'transfer';
      transfer.insideNest = true;
      transfer.transferCargo = rivalEntranceBiology.cache.shift();
      transfer.transferDuration = transfer.transferTimer = rand(4.2, 7.4);
      transfer.state = 'collecting food from slate entrance cache';
    }
  }
  rivalEntranceBiology.activeTransfers = rivalAnts.filter((rival) => rival.insideNest && rival.transferCargo).length;
  rivalColony.roleClock -= dt;
  if (rivalColony.roleClock <= 0) {
    const guardTarget = clamp(Math.round(rivalAnts.length * 0.16), 3, 18);
    const scoutTarget = clamp(Math.round(rivalAnts.length * 0.14), 3, 16);
    const guards = rivalAnts.filter((rival) => rival.role === 'guard');
    const scouts = rivalAnts.filter((rival) => rival.role === 'scout');
    const promotable = rivalAnts
      .filter((rival) => rival.role === 'forager')
      .sort((a, b) => b.health - a.health || b.size - a.size);
    for (let i = guards.length; i < guardTarget && promotable.length > 0; i++) {
      const promoted = promotable.shift();
      promoted.role = promoted.assignedRole = 'guard';
    }
    for (let i = scouts.length; i < scoutTarget && promotable.length > 0; i++) {
      const promoted = promotable.shift();
      promoted.role = promoted.assignedRole = 'scout';
    }
    const rivalFoodPressure = clamp((1.28 - demographics.reserveRatio) / 1.08, 0, 1);
    const rivalReserveSurplus = clamp((demographics.reserveRatio - 2.4) / 3.2, 0, 1);
    const rivalSeasonFactor = environment.season.name === 'winter' ? 0.52 : environment.season.name === 'autumn' ? 0.8 : 1;
    const desiredForagers = clamp(Math.round(rivalAnts.length
      * (0.15 - rivalReserveSurplus * 0.075 + rivalFoodPressure * 0.34
        + rivalEntranceBiology.activation * 0.055) * rivalSeasonFactor), 4, Math.round(rivalAnts.length * 0.52));
    const currentForagers = rivalAnts.filter((rival) => rival.role === 'forager');
    if (currentForagers.length > desiredForagers) {
      currentForagers
        .sort((a, b) => Math.hypot(a.x - RIVAL_NEST.x, a.z - RIVAL_NEST.y)
          - Math.hypot(b.x - RIVAL_NEST.x, b.z - RIVAL_NEST.y))
        .slice(0, currentForagers.length - desiredForagers)
        .forEach((rival) => { rival.role = rival.assignedRole = 'interior'; });
    } else if (currentForagers.length < desiredForagers) {
      rivalAnts.filter((rival) => rival.role === 'interior')
        .sort((a, b) => b.energy - a.energy)
        .slice(0, desiredForagers - currentForagers.length)
        .forEach((rival) => {
          rival.role = rival.assignedRole = 'forager';
          rival.transferTimer = Math.min(rival.transferTimer || 0, rand(0.4, 1.4));
        });
    }
    rivalColony.roleClock = 5;
  }
  for (let i = rivalBrood.length - 1; i >= 0; i--) {
    const item = rivalBrood[i];
    let development = item.vigor * (demographics.foodFactor > 0.18 ? 0.9 : 0.3);
    if (item.stage === 'larva') {
      const rationMultiplier = item.destiny === 'gyne' ? 1.9 : item.destiny === 'male' ? 1.15 : 1;
      const requiredRation = dt * 0.0065 * rationMultiplier;
      const ration = Math.min(rivalColony.storedFood, requiredRation);
      rivalColony.storedFood -= ration;
      const rationRatio = ration / Math.max(0.0001, requiredRation);
      if (rationRatio < 0.74) development *= 0.36;
      item.starvation = clamp((item.starvation || 0)
        + dt * Math.max(0, 0.72 - rationRatio) * 0.033
        - dt * Math.max(0, rationRatio - 0.72) * 0.014, 0, 1.2);
      if (item.starvation >= 1) {
        rivalBrood.splice(i, 1);
        rivalColony.broodDeaths++;
        continue;
      }
    }
    item.stageAge += dt * development * (1 - demographics.crowdingPressure * 0.52);
    if (item.stageAge < broodStageDuration(item)) continue;
    if (item.stage === 'egg') { item.stage = 'larva'; item.stageAge = 0; }
    else if (item.stage === 'larva') { item.stage = 'pupa'; item.stageAge = 0; }
    else {
      if (item.destiny === 'worker') {
        const worker = spawnRival(true, { genome: item.genome, generation: item.generation, parentage: item.parentage });
        if (!worker) {
          if (!item.technicalBlockReported) {
            item.technicalBlockReported = true;
            rivalColony.technicalBlockedEclosions++;
          }
          item.stageAge = broodStageDuration(item);
          continue;
        }
        rivalColony.workersEclosed++;
        rivalBrood.splice(i, 1);
      } else {
        rivalBrood.splice(i, 1);
        ecloseAlate(rivalReproduction, item, RIVAL_COLONY_ID, 'slate');
      }
    }
  }
  rivalColony.layClock -= dt;
  demographics = demographicStateFor(rivalColonyRecord, rivalCareRatio);
  rivalColonyRecord.demographics = demographics;
  if (rivalColony.layClock <= 0) {
    const canLay = rivalColonyRecord.queen.alive && demographics.layingDrive > 0.08
      && rivalBrood.length < demographics.broodCapacity && rivalBrood.length < TECHNICAL_BROOD_LIMIT;
    if (canLay) {
      const availableBroodSpace = demographics.broodCapacity - rivalBrood.length;
      const baseClutch = demographics.layingDrive > 0.7 && availableBroodSpace > 1 ? 2 : 1;
      const clutch = Math.min(availableBroodSpace, baseClutch + (demographicScenario === 'abundance' ? 1 : 0));
      for (let i = 0; i < clutch; i++) {
        const sexualSeason = environment.season.name === 'spring' || environment.season.name === 'summer';
        let destiny = 'worker';
        if (sexualSeason && colonyIsReproductivelyMature(rivalColonyRecord)
          && rivalAnts.length >= 55 && rivalColony.storedFood > 74
          && rivalReproduction.reproductiveBudget >= reproductiveCost('male') && random() < 0.38) {
          const candidate = chooseSexualDestiny(rivalReproduction);
          if (rivalReproduction.reproductiveBudget >= reproductiveCost(candidate)) destiny = candidate;
        }
        const cost = reproductiveCost(destiny);
        if (addRivalBrood('egg', 0, null, 1, { destiny })) {
          rivalColony.eggsLaid++;
          rivalColony.storedFood = Math.max(0, rivalColony.storedFood - cost);
          if (destiny === 'worker') rivalReproduction.workerEggsLaid++;
          else {
            rivalReproduction.sexualEggsLaid++;
            rivalReproduction.reproductiveBudget -= cost;
            if (destiny === 'male') rivalReproduction.maleInvestment += cost;
            else rivalReproduction.gyneInvestment += cost;
          }
        }
      }
    }
    rivalColony.layClock = canLay
      ? rand(8.5, 12.5) / clamp((0.6 + demographics.layingDrive * 0.58)
        * (demographicScenario === 'abundance' ? 1.18 : 1), 0.6, 1.4)
      : rand(4.8, 8);
  }

  for (const rival of rivalAnts) {
    if (!rival.alive) continue;
    const seniority = Math.max(0, rival.ageDays - WORKER_SENESCENCE_DAYS);
    rival.health -= dt * seniority * WORKER_SENESCENCE_RATE * (rival.insideNest ? 0.72 : 1.18);
    rival.health -= dt * demographics.starvationPressure * 0.07;
    rival.health -= dt * demographics.crowdingPressure * 0.011;
    if (rival.insideNest && demographics.reserveRatio > 0.6) rival.health = Math.min(100, rival.health + dt * 0.014);
    if (rival.health <= 0) {
      markRegisteredWorkerDead(rival, demographics.starvationPressure > 0.45 ? 'starvation'
        : demographics.crowdingPressure > 0.6 ? 'crowding stress' : 'age');
      continue;
    }
    updateWorker(workerWorld, rivalColonyRecord, rival, dt);
  }
  removeDeadRegisteredWorkers(rivalColonyRecord);
}

function updateColonyBiology(dt) {
  storedFood = acceptColonyStoredFood(HOME_COLONY_ID, storedFood);
  const activeNurses = ants.filter((ant) => ant.insideNest && ant.nestRouteKey === 'nursery' && ant.nestMode === 'working').length;
  const requiredNurses = Math.max(2, Math.ceil(brood.length / 4.2));
  colonyBiology.activeNurses = activeNurses;
  colonyBiology.requiredNurses = requiredNurses;
  colonyBiology.starvedLarvae = 0;

  storedFood = consumeColonyStoredFood(
    HOME_COLONY_ID,
    storedFood,
    dt,
    ants.length,
    { baseRate: 0.018, workerRate: 0.0011 },
  );
  updateAlateCohort(homeReproduction, dt);
  if (homeColonyRecord.queen.alive && colonyIsReproductivelyMature(homeColonyRecord)
    && (environment.season.name === 'spring' || environment.season.name === 'summer') && storedFood > 65) {
    homeReproduction.reproductiveBudget = clamp(
      homeReproduction.reproductiveBudget + dt * 0.02 * clamp((storedFood - 65) / 60, 0, 1), 0, 20,
    );
  }
  const careRatio = clamp(activeNurses / requiredNurses, 0.35, 1.18);
  let demographics = demographicStateFor(homeColonyRecord, careRatio);
  homeColonyRecord.demographics = demographics;
  for (let i = brood.length - 1; i >= 0; i--) {
    const item = brood[i];
    let development = 0.58 + careRatio * 0.48;
    if (item.stage === 'larva') {
      const rationMultiplier = item.destiny === 'gyne' ? 1.9 : item.destiny === 'male' ? 1.15 : 1;
      const requiredRation = dt * 0.0085 * rationMultiplier;
      const ration = Math.min(storedFood, requiredRation);
      storedFood -= ration;
      const rationRatio = ration / Math.max(0.0001, requiredRation);
      if (rationRatio < 0.71) {
        development *= 0.32;
        colonyBiology.starvedLarvae++;
      }
      item.starvation = clamp((item.starvation || 0)
        + dt * Math.max(0, 0.72 - rationRatio) * 0.033
        - dt * Math.max(0, rationRatio - 0.72) * 0.014, 0, 1.2);
      if (item.starvation >= 1) {
        brood.splice(i, 1);
        colonyBiology.broodDeaths++;
        continue;
      }
    }
    item.care = clamp(item.care + dt * (careRatio - 0.72) * 0.008, 0.62, 1.16);
    const crowdingDevelopment = 1 - demographics.crowdingPressure * 0.52;
    item.stageAge += dt * development * item.care * crowdingDevelopment;
    if (item.stageAge < broodStageDuration(item)) continue;
    if (item.stage === 'egg') {
      item.stage = 'larva';
      item.stageAge = 0;
    } else if (item.stage === 'larva') {
      item.stage = 'pupa';
      item.stageAge = 0;
    } else {
      if (item.destiny === 'worker') {
        const worker = spawnAnt(false, {
          newborn: true, ageDays: 0, genome: item.genome,
          generation: item.generation, parentage: item.parentage,
        });
        if (!worker) {
          if (!item.technicalBlockReported) {
            item.technicalBlockReported = true;
            colonyBiology.technicalBlockedEclosions++;
          }
          item.stageAge = broodStageDuration(item);
          continue;
        }
        workersEclosed++;
        brood.splice(i, 1);
      } else {
        brood.splice(i, 1);
        ecloseAlate(homeReproduction, item, HOME_COLONY_ID, 'amber');
      }
    }
  }

  queenLayClock -= dt;
  demographics = demographicStateFor(homeColonyRecord, careRatio);
  homeColonyRecord.demographics = demographics;
  if (queenLayClock <= 0) {
    const safeToLay = environment.pressure === 'stable' || environment.pressure === 'predator alarm';
    const canLay = homeColonyRecord.queen.alive && safeToLay && demographics.layingDrive > 0.08
      && brood.length < demographics.broodCapacity && brood.length < TECHNICAL_BROOD_LIMIT;
    if (canLay) {
      const availableBroodSpace = demographics.broodCapacity - brood.length;
      const baseClutch = demographics.layingDrive > 0.72 && availableBroodSpace > 2
        ? (demographics.reserveRatio > 1.5 ? 3 : 2) : 1;
      const clutch = Math.min(availableBroodSpace, baseClutch + (demographicScenario === 'abundance' ? 1 : 0));
      for (let i = 0; i < clutch; i++) {
        const sexualSeason = environment.season.name === 'spring' || environment.season.name === 'summer';
        let destiny = 'worker';
        if (sexualSeason && colonyIsReproductivelyMature(homeColonyRecord)
          && ants.length >= 110 && storedFood > 82
          && homeReproduction.reproductiveBudget >= reproductiveCost('male') && random() < 0.42) {
          const candidate = chooseSexualDestiny(homeReproduction);
          if (homeReproduction.reproductiveBudget >= reproductiveCost(candidate)) destiny = candidate;
        }
        const cost = reproductiveCost(destiny);
        if (!addBrood('egg', 0, null, 1, { destiny })) continue;
        queenEggsLaid++;
        storedFood = Math.max(0, storedFood - cost);
        if (destiny === 'worker') homeReproduction.workerEggsLaid++;
        else {
          homeReproduction.sexualEggsLaid++;
          homeReproduction.reproductiveBudget -= cost;
          if (destiny === 'male') homeReproduction.maleInvestment += cost;
          else homeReproduction.gyneInvestment += cost;
        }
      }
    }
    queenLayClock = canLay
      ? rand(6, 9) / clamp((0.58 + demographics.layingDrive * 0.62)
        * (demographicScenario === 'abundance' ? 1.18 : 1), 0.58, 1.42)
      : rand(4.5, 7.5);
  }
}

function depositInEntranceCache(ant) {
  if (!ant.pendingDelivery || entranceBiology.cache.length >= entranceBiology.capacity) return false;
  const waiting = ants.filter((worker) => worker.alive && worker.insideNest
    && worker.nestRouteKey === 'vestibule' && worker.nestMode === 'working'
    && worker.assignedRole === 'forager' && worker !== ant).length;
  const nutrition = ant.carryingNutrition || 1;
  recordForagingDelivery(ant);
    entranceBiology.cache.push({
      kind: ant.carryingKind || 'seed',
      nutrition,
      value: 1.35 * nutrition,
      seedSpecies: ant.carryingSeedSpecies || null,
      sourcePlantId: ant.carryingSourcePlantId || null,
    });
  entranceBiology.foodReturned++;
  entranceBiology.cacheDeposits++;
  entranceBiology.recentReturns = Math.min(1, entranceBiology.recentReturns + 0.22);
  entranceBiology.activation = Math.min(1, entranceBiology.activation + 0.1 + nutrition * 0.055 + Math.min(0.16, waiting * 0.018));
  entranceBiology.contactEvents += waiting;
  ant.pendingDelivery = false;
  clearWorkerFoodCargo(ant);
  ant.tasksCompleted++;
  ant.taskExperience.forager += 1;
  ant.nestTimer = Math.max(ant.nestTimer, rand(1.4, 2.8));
  ant.state = waiting > 0 ? `caching food after ${waiting} returner contacts` : 'caching food in entrance vestibule';
  return true;
}

function updateEntranceBiology(dt) {
  entranceBiology.activation = Math.max(0.08, entranceBiology.activation - dt * (0.022 + weather.rain * 0.016));
  entranceBiology.recentReturns = Math.max(0, entranceBiology.recentReturns - dt * 0.045);
  entranceBiology.waitingForagers = ants.filter((ant) => ant.alive && ant.insideNest
    && ant.nestRouteKey === 'vestibule' && ant.nestMode === 'working' && ant.assignedRole === 'forager').length;
  entranceBiology.activeTransfers = ants.filter((ant) => ant.alive && ant.assignedRole === 'transfer'
    && (ant.insideNest || ant.transferCargo)).length;
}

let laborClock = 99;
const colonyLabor = {
  targetForagers: 0, targetNurses: 0, targetTransfers: 0, targetExcavators: 0, targetSanitizers: 0,
  assignedForagers: 0, assignedNurses: 0, assignedTransfers: 0, assignedExcavators: 0, assignedSanitizers: 0,
  assignedInterior: 0,
};
function updateLaborAssignments(dt) {
  laborClock += dt;
  if (laborClock < 2.5) return;
  laborClock = 0;
  const projects = activeConstructionProjects();
  const broodPressure = brood.length / Math.max(1, ants.length);
  const demographics = demographicStateFor(homeColonyRecord, 1);
  const foodPressure = clamp((1.28 - demographics.reserveRatio) / 1.08, 0, 1);
  const reserveSurplus = clamp((demographics.reserveRatio - 2.4) / 3.2, 0, 1);
  const survivalEmergency = environment.pressure === 'food crisis' || environment.pressure === 'disease outbreak' || environment.season.name === 'winter';
  const targetExcavators = projects.length > 0
    ? clamp(Math.round(ants.length * (survivalEmergency ? 0.018 : 0.045 + (storedFood > 45 ? 0.02 : 0))), 2, 14)
    : 0;
  const targetNurses = clamp(Math.ceil(brood.length / 4.2 + broodPressure * 7), 3, Math.round(ants.length * 0.24));
  const targetTransfers = entranceBiology.cache.length > 0
    ? clamp(Math.ceil(entranceBiology.cache.length / 5), 2, 10)
    : 1;
  const targetSanitizers = remains.length > 0 ? clamp(Math.ceil(remains.length / 3), 2, 6) : 0;
  const seasonalSurfaceFactor = environment.season.name === 'winter' ? 0.48 : environment.season.name === 'autumn' ? 0.78 : 1;
  const forageFraction = clamp((0.14 - reserveSurplus * 0.07 + foodPressure * 0.34
    + entranceBiology.activation * 0.06) * seasonalSurfaceFactor, 0.06, 0.56);
  const availableAfterSpecialists = Math.max(0, ants.length - targetNurses - targetTransfers - targetExcavators - targetSanitizers);
  const targetForagers = Math.min(availableAfterSpecialists, clamp(Math.round(ants.length * forageFraction), 7, Math.round(ants.length * 0.56)));
  colonyLabor.targetExcavators = targetExcavators;
  colonyLabor.targetNurses = targetNurses;
  colonyLabor.targetTransfers = targetTransfers;
  colonyLabor.targetSanitizers = targetSanitizers;
  colonyLabor.targetForagers = targetForagers;

  const previousRoles = new Map(ants.map((ant) => [ant, ant.assignedRole]));
  const claimed = new Set();
  for (const ant of ants) {
    const committed = ant.carrying || ant.soilCargo || ant.sanitationCargo || ant.transferCargo
      || ant.nestRouteKey === 'excavation' || ant.nestRouteKey === 'transferStores';
    if (committed) claimed.add(ant);
  }

  const responseScore = (ant, role) => {
    const age = ant.ageDays;
    const maturity = workerMaturity(age);
    const threshold = ant.responseThresholds?.[role] ?? 0.5;
    const stickiness = previousRoles.get(ant) === role ? 0.72 : 0;
    const experience = Math.log1p(ant.taskExperience?.[role] || 0) * 0.34;
    if (role === 'nurse') {
      return broodPressure * 4.2 + (maturity === 'callow' ? 2.5 : maturity === 'young' ? 1.25 : 0)
        + (ant.tendency === 'nurse' ? 0.9 : 0) + (ant.insideNest ? 0.55 : 0) + stickiness + experience - threshold * 2.2;
    }
    if (role === 'transfer') {
      const ageBand = age >= 10 && age <= 38 ? 1.5 : age < 5 ? -1.4 : 0.3;
      return clamp(entranceBiology.cache.length / 16, 0, 2.2) + ageBand + (ant.insideNest ? 0.8 : 0)
        + ant.energy * 0.008 + stickiness + experience - threshold * 2.1;
    }
    if (role === 'excavator') {
      return (projects.length > 0 ? 1.5 : -3) + ant.energy * 0.012 + (ant.tendency === 'excavator' ? 1 : 0)
        + (ant.workerCaste === 'major' ? 0.35 : 0) + stickiness + experience - threshold * 2.2;
    }
    if (role === 'sanitizer') {
      return Math.min(2.5, remains.length * 0.34) + ant.health * 0.01 + (age > 14 ? 0.4 : -1)
        + stickiness + experience - threshold * 2.3;
    }
    return foodPressure * 1.8 + entranceBiology.activation * 1.2 + age * 0.025 + ant.genome.foraging
      + (ant.tendency === 'forager' ? 0.65 : 0) + stickiness + experience - threshold * 2;
  };

  const eligible = ants.filter((ant) => ant.alive && !claimed.has(ant) && !ant.carrying && !ant.soilCargo && !ant.sanitationCargo && !ant.transferCargo);
  const claimRole = (role, target) => {
    const alreadyCommitted = ants.filter((ant) => claimed.has(ant) && ant.assignedRole === role).length;
    const needed = Math.max(0, target - alreadyCommitted);
    const ranked = eligible.filter((ant) => !claimed.has(ant)).sort((a, b) => responseScore(b, role) - responseScore(a, role));
    for (let i = 0; i < Math.min(needed, ranked.length); i++) {
      ranked[i].assignedRole = role;
      claimed.add(ranked[i]);
    }
  };

  claimRole('nurse', targetNurses);
  claimRole('transfer', targetTransfers);
  claimRole('excavator', targetExcavators);
  claimRole('sanitizer', targetSanitizers);
  claimRole('forager', targetForagers);
  for (const ant of ants) if (!claimed.has(ant)) ant.assignedRole = 'interior';

  colonyLabor.assignedForagers = ants.filter((ant) => ant.assignedRole === 'forager').length;
  colonyLabor.assignedNurses = ants.filter((ant) => ant.assignedRole === 'nurse').length;
  colonyLabor.assignedTransfers = ants.filter((ant) => ant.assignedRole === 'transfer' || ant.transferCargo).length;
  colonyLabor.assignedExcavators = ants.filter((ant) => ant.assignedRole === 'excavator').length;
  colonyLabor.assignedSanitizers = ants.filter((ant) => ant.assignedRole === 'sanitizer' || ant.sanitationCargo).length;
  colonyLabor.assignedInterior = ants.filter((ant) => ant.assignedRole === 'interior').length;
}

const obstacles = [
  { x: 6.4, z: -0.7, r: 0.43 },
  { x: 8.0, z: -0.1, r: 0.38 },
];

const surfaceWorkerGrid = new Map();
let indexedSurfaceWorkers = [];
let surfaceWorkerIndices = new WeakMap();
let surfaceWorkerCellKeys = new WeakMap();
let surfaceWorkerOrders = new WeakMap();
const SURFACE_WORKER_COLONY_ORDER_STRIDE = 1_000_000;

function canonicalSurfaceWorkerOrder(worker) {
  const colonyRank = Math.max(0, colonyOrder.indexOf(worker?.colonyId));
  const workerRank = Math.max(0, getColony(worker?.colonyId)?.workers.indexOf(worker) ?? 0);
  return colonyRank * SURFACE_WORKER_COLONY_ORDER_STRIDE + workerRank;
}

function antCellCoords(x, z) {
  return {
    x: Math.floor((x + HALF_W) / ANT_CELL_SIZE),
    z: Math.floor((z + HALF_D) / ANT_CELL_SIZE),
  };
}

function antCellKey(x, z) { return x * ANT_GRID_ROWS + z; }

function rebuildSurfaceWorkerGrid() {
  const profileStartedAt = profiler.begin('spatialIndex');
  profiler.incrementFrame('surfaceIndexBuilds');
  surfaceWorkerGrid.clear();
  indexedSurfaceWorkers = [];
  surfaceWorkerIndices = new WeakMap();
  surfaceWorkerCellKeys = new WeakMap();
  surfaceWorkerOrders = new WeakMap();
  surfaceWorkersNeedingRefresh.clear();
  for (const colony of colonyRegistry.values()) {
    if (colony.status === 'extinct') continue;
    const colonyRank = Math.max(0, colonyOrder.indexOf(colony.id));
    for (let workerRank = 0; workerRank < colony.workers.length; workerRank++) {
      const worker = colony.workers[workerRank];
      surfaceWorkerOrders.set(
        worker,
        colonyRank * SURFACE_WORKER_COLONY_ORDER_STRIDE + workerRank,
      );
      if (worker.alive === false || worker.insideNest) continue;
      surfaceWorkerIndices.set(worker, indexedSurfaceWorkers.length);
      indexedSurfaceWorkers.push(worker);
      const cell = antCellCoords(worker.x, worker.z);
      const key = antCellKey(cell.x, cell.z);
      surfaceWorkerCellKeys.set(worker, key);
      let occupants = surfaceWorkerGrid.get(key);
      if (!occupants) {
        occupants = [];
        surfaceWorkerGrid.set(key, occupants);
      }
      occupants.push(worker);
    }
  }
  profiler.end('spatialIndex', profileStartedAt);
}

function detachSurfaceWorkerFromGrid(worker) {
  const key = surfaceWorkerCellKeys.get(worker);
  if (key == null) return false;
  const occupants = surfaceWorkerGrid.get(key);
  const index = occupants?.indexOf(worker) ?? -1;
  if (index >= 0) occupants.splice(index, 1);
  if (occupants?.length === 0) surfaceWorkerGrid.delete(key);
  surfaceWorkerCellKeys.delete(worker);
  return index >= 0;
}

function refreshSurfaceWorkerGrid(workers) {
  if (!workers?.length) return;
  const profileStartedAt = profiler.begin('spatialRefresh');
  let cellMoves = 0;
  for (const worker of workers) {
    const oldKey = surfaceWorkerCellKeys.get(worker);
    if (worker.alive === false || worker.insideNest) {
      cellMoves += Number(detachSurfaceWorkerFromGrid(worker));
      continue;
    }
    const cell = antCellCoords(worker.x, worker.z);
    const nextKey = antCellKey(cell.x, cell.z);
    if (oldKey === nextKey) continue;
    if (oldKey != null) detachSurfaceWorkerFromGrid(worker);
    let occupants = surfaceWorkerGrid.get(nextKey);
    if (!occupants) {
      occupants = [];
      surfaceWorkerGrid.set(nextKey, occupants);
    }
    occupants.push(worker);
    occupants.sort((a, b) => (surfaceWorkerOrders.get(a) ?? canonicalSurfaceWorkerOrder(a))
      - (surfaceWorkerOrders.get(b) ?? canonicalSurfaceWorkerOrder(b)));
    surfaceWorkerCellKeys.set(worker, nextKey);
    cellMoves++;
  }
  profiler.incrementFrame('surfaceIndexWorkerRefreshes', workers.length);
  profiler.incrementFrame('surfaceIndexCellMoves', cellMoves);
  profiler.end('spatialRefresh', profileStartedAt);
}

function descendantWorkers() {
  const workers = [];
  for (const colony of colonyRegistry.values()) {
    if (colony.id === HOME_COLONY_ID || colony.id === RIVAL_COLONY_ID || colony.status === 'extinct') continue;
    workers.push(...colony.workers);
  }
  return workers;
}

function workersInCombatContact(a, b) {
  return a.colonyId !== b.colonyId
    && (a.combatContactUntil || 0) > simTime
    && (b.combatContactUntil || 0) > simTime;
}

function surfaceWorkersNear(worker, radius = Infinity, {
  foreignOnly = false,
  livingOnly = true,
  cellSpan = null,
  accept = null,
} = {}) {
  if (!worker || worker.insideNest) return [];
  return surfaceWorkersNearPoint(worker.x, worker.z, radius, {
    excludeWorker: worker,
    sourceColonyId: worker.colonyId,
    foreignOnly,
    livingOnly,
    cellSpan,
    accept,
  });
}

function surfaceWorkersNearPoint(x, z, radius = Infinity, {
  excludeWorker = null,
  sourceColonyId = null,
  foreignOnly = false,
  livingOnly = true,
  cellSpan = null,
  accept = null,
} = {}) {
  const cell = antCellCoords(x, z);
  const span = cellSpan ?? (Number.isFinite(radius) ? Math.max(1, Math.ceil(radius / ANT_CELL_SIZE)) : 1);
  const radiusSq = radius * radius;
  const nearby = [];
  for (let ox = -span; ox <= span; ox++) {
    for (let oz = -span; oz <= span; oz++) {
      const occupants = surfaceWorkerGrid.get(antCellKey(cell.x + ox, cell.z + oz));
      if (!occupants) continue;
      for (const other of occupants) {
        if (other === excludeWorker || other.insideNest || (livingOnly && other.alive === false)) continue;
        if (foreignOnly && other.colonyId === sourceColonyId) continue;
        if (accept && !accept(other)) continue;
        if (Number.isFinite(radius)) {
          const dx = x - other.x;
          const dz = z - other.z;
          if (dx * dx + dz * dz > radiusSq) continue;
        }
        nearby.push(other);
      }
    }
  }
  return nearby;
}

function nearestSurfaceWorkerAt(x, z, radius, options = {}) {
  let nearest = null;
  let nearestDistanceSq = radius * radius;
  for (const other of surfaceWorkersNearPoint(x, z, radius, options)) {
    const distanceSq = (x - other.x) ** 2 + (z - other.z) ** 2;
    if (distanceSq < nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest = other;
    }
  }
  return nearest;
}

function nearestForeignSurfaceWorker(worker, radius = 1.15, options = {}) {
  return nearestSurfaceWorkerAt(worker.x, worker.z, radius, {
    excludeWorker: worker,
    sourceColonyId: worker.colonyId,
    foreignOnly: true,
    ...options,
  });
}

function applyNeighborAvoidance(ant) {
  if (ant.insideNest) return;
  let separateX = 0;
  let separateZ = 0;
  let pressure = 0;
  let neighbors = 0;

  for (const other of surfaceWorkersNear(ant, Infinity, { cellSpan: 1, livingOnly: false })) {
        let dx = ant.x - other.x;
        let dz = ant.z - other.z;
        let distanceSq = dx * dx + dz * dz;
        const opposing = Math.cos(ant.heading - other.heading) < -0.25;
        const combatContact = workersInCombatContact(ant, other);
        const crossColony = ant.colonyId !== other.colonyId;
        const baseSpace = combatContact ? 0.44 : crossColony ? 0.9 : opposing ? 0.96 : 0.84;
        const personalSpace = baseSpace * ((ant.size || 0.8) + (other.size || 0.8)) * 0.5;
        if (distanceSq >= personalSpace * personalSpace) continue;
        if (distanceSq < 0.00001) {
          const fallback = (ant.phase || ant.id || 1) * 1.71 - (other.phase || other.id || 1) * 0.63;
          dx = Math.cos(fallback) * 0.01;
          dz = Math.sin(fallback) * 0.01;
          distanceSq = 0.0001;
        }
        const distance = Math.sqrt(distanceSq);
        const strength = (1 - distance / personalSpace) * (combatContact ? 0.16 : 1);
        separateX += (dx / distance) * strength;
        separateZ += (dz / distance) * strength;
        if (opposing && !combatContact) {
          separateX += -Math.sin(ant.heading) * Math.sign(ant.laneBias || 1) * strength * 0.46;
          separateZ += Math.cos(ant.heading) * Math.sign(ant.laneBias || 1) * strength * 0.46;
        }
        pressure += strength;
        neighbors++;
  }

  if (neighbors > 0) {
    const routeWeight = ant.carrying ? 1.18 : 1;
    const desiredX = Math.cos(ant.desired) * routeWeight + separateX * 1.78;
    const desiredZ = Math.sin(ant.desired) * routeWeight + separateZ * 1.78;
    ant.desired = Math.atan2(desiredZ, desiredX);
    if (pressure > 1.45 && !(ant.combatContactUntil > simTime)) ant.state = 'weaving through traffic';
  }
}

function resolveSurfaceWorkerSpacing() {
  for (let i = 0; i < indexedSurfaceWorkers.length; i++) {
    const ant = indexedSurfaceWorkers[i];
    if (ant.insideNest) continue;
    const cell = antCellCoords(ant.x, ant.z);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const occupants = surfaceWorkerGrid.get(antCellKey(cell.x + ox, cell.z + oz));
        if (!occupants) continue;
        for (const other of occupants) {
          const otherIndex = surfaceWorkerIndices.get(other);
          if (otherIndex == null || otherIndex <= i || other.insideNest) continue;
          let dx = ant.x - other.x;
          let dz = ant.z - other.z;
          let distance = Math.hypot(dx, dz);
          const combatContact = workersInCombatContact(ant, other);
          const crossColony = ant.colonyId !== other.colonyId;
          const baseMinimum = combatContact ? 0.38 : crossColony ? 0.86 : 0.78;
          const minimum = baseMinimum * ((ant.size || 0.8) + (other.size || 0.8)) * 0.5;
          if (distance >= minimum) continue;
          if (distance < 0.001) {
            const angle = (i * 2.399 + otherIndex * 0.73) % (Math.PI * 2);
            dx = Math.cos(angle);
            dz = Math.sin(angle);
            distance = 1;
          }
          const push = (minimum - distance) * 0.51;
          const nx = dx / distance;
          const nz = dz / distance;
          ant.x += nx * push;
          ant.z += nz * push;
          other.x -= nx * push;
          other.z -= nz * push;
        }
      }
    }
    ant.x = clamp(ant.x, -HALF_W + 0.35, HALF_W - 0.35);
    ant.z = clamp(ant.z, -HALF_D + 0.35, HALF_D - 0.35);
  }
}

function nearestFood(ant, maxDist = 0.62) {
  return foodSpatialIndex.nearest(
    ant.x,
    ant.z,
    maxDist,
    (food) => food.amount > 0,
  )?.entity || null;
}

function steerTowards(ant, angle, strength) {
  ant.desired = ant.heading + wrapAngle(angle - ant.heading) * strength;
}

function emergeFromNest(ant) {
  const exitAngle = rand(0, Math.PI * 2);
  const exitRadius = rand(0.62, 0.86);
  ant.insideNest = false;
  ant.location = 'surface';
  ant.x = NEST.x + Math.cos(exitAngle) * exitRadius;
  ant.z = NEST.y + Math.sin(exitAngle) * exitRadius;
  ant.heading = exitAngle + rand(-0.24, 0.24);
  ant.desired = ant.heading;
  ant.pause = rand(0.04, 0.18);
  ant.nestMode = null;
  ant.trips++;
  if (ant.soilCargo) {
    const spoilAngle = rand(0, Math.PI * 2);
    const spoilRadius = rand(1.05, 1.85) + Math.min(0.55, excavatedSoil * 0.002);
    ant.spoilTarget = {
      x: NEST.x + Math.cos(spoilAngle) * spoilRadius,
      z: NEST.y + Math.sin(spoilAngle) * spoilRadius * 0.76,
    };
    ant.state = 'hauling soil to spoil heap';
  } else ant.state = 'emerging from nest';
}

function moveSurfaceDirected(ant, dt, speedFactor = 1) {
  applyNeighborAvoidance(ant);
  const turnRate = dt * 4.6;
  ant.heading += clamp(wrapAngle(ant.desired - ant.heading), -turnRate, turnRate);
  const velocity = ant.speed * speedFactor * (1 - weather.rain * 0.18) * webSlowAt(ant.x, ant.z);
  ant.x += Math.cos(ant.heading) * velocity * dt;
  ant.z += Math.sin(ant.heading) * velocity * dt;
  ant.distanceTraveled += velocity * dt;
  ant.energy = Math.max(0, ant.energy - velocity * dt * 0.085);
  ant.x = clamp(ant.x, -HALF_W + 0.35, HALF_W - 0.35);
  ant.z = clamp(ant.z, -HALF_D + 0.35, HALF_D - 0.35);
}

function updateSanitationSurface(ant, dt) {
  if (ant.sanitationCargo) {
    if (!ant.sanitationTarget) {
      const angle = 2.35 + (ant.id % 7) * 0.12;
      ant.sanitationTarget = {
        x: NEST.x + Math.cos(angle) * 2.25,
        z: NEST.y + Math.sin(angle) * 1.7,
      };
    }
    const dx = ant.sanitationTarget.x - ant.x;
    const dz = ant.sanitationTarget.z - ant.z;
    ant.state = 'carrying corpse to refuse midden';
    steerTowards(ant, Math.atan2(dz, dx), 0.92);
    if (Math.hypot(dx, dz) < 0.24) {
      ant.sanitationCargo = false;
      ant.sanitationTarget = null;
      ant.tasksCompleted++;
      ant.taskExperience.sanitizer += 1;
      colonySurvival.sanitized++;
      colonySurvival.outbreakClock += 2.5;
      createSignal(ant.x, ant.z, 0x80745e);
      ant.state = 'corpse isolated at midden';
      return true;
    }
    moveSurfaceDirected(ant, dt, 0.9);
    return true;
  }
  if (ant.assignedRole !== 'sanitizer' || remains.length === 0) return false;
  const nearestRemain = remainsSpatialIndex.nearest(ant.x, ant.z, Math.hypot(WORLD_W, WORLD_D));
  const target = nearestRemain?.entity || null;
  const targetDistance = nearestRemain ? Math.sqrt(nearestRemain.distanceSquared) : Infinity;
  if (!target) return false;
  ant.state = 'locating colony remains';
  steerTowards(ant, Math.atan2(target.z - ant.z, target.x - ant.x), 0.94);
  if (targetDistance < 0.25) {
    const index = remains.indexOf(target);
    if (index >= 0) remains.splice(index, 1);
    remainsSpatialIndex.remove(target);
    surfaceGroup.remove(target.mesh);
    target.mesh.material.dispose();
    ant.sanitationCargo = true;
    ant.sanitationTarget = null;
    ant.state = 'lifting colony remains';
    return true;
  }
  moveSurfaceDirected(ant, dt, 1.02);
  return true;
}

function updateExcavationSurface(ant, dt) {
  if (ant.soilCargo) {
    if (!ant.spoilTarget) {
      const angle = rand(0, Math.PI * 2);
      ant.spoilTarget = { x: NEST.x + Math.cos(angle) * 1.35, z: NEST.y + Math.sin(angle) * 1.05 };
    }
    const dx = ant.spoilTarget.x - ant.x;
    const dz = ant.spoilTarget.z - ant.z;
    const distance = Math.hypot(dx, dz);
    ant.state = 'hauling soil to spoil heap';
    steerTowards(ant, Math.atan2(dz, dx), 0.9);
    if (distance < 0.24) {
      addSpoilClod(ant.spoilTarget.x + rand(-0.08, 0.08), ant.spoilTarget.z + rand(-0.08, 0.08));
      excavatedSoil++;
      ant.soilCargo = false;
      ant.spoilTarget = null;
      ant.nestRoute = null;
      ant.nestRouteKey = null;
      ant.excavationProject = null;
      ant.state = 'soil deposited';
      return true;
    }
    moveSurfaceDirected(ant, dt, 0.9);
    return true;
  }

  if (ant.assignedRole !== 'excavator') return false;
  const projectIndex = chooseExcavationProject();
  if (projectIndex == null) return false;
  const dx = NEST.x - ant.x;
  const dz = NEST.y - ant.z;
  const distance = Math.hypot(dx, dz);
  ant.state = `reporting to ${tunnelSegments[projectIndex].name}`;
  steerTowards(ant, Math.atan2(dz, dx) + ant.laneBias * 0.25, 0.9);
  if (distance < 0.77) {
    if (ant.energy < 20) beginNestJourney(ant, 'rest');
    else beginExcavationJourney(ant, projectIndex);
    return true;
  }
  moveSurfaceDirected(ant, dt, 1.02);
  return true;
}

function updateNestAnt(ant, dt) {
  const route = antNestRoute(ant);
  ant.energy = Math.min(100, ant.energy + dt * (ant.nestMode === 'working' ? 2.4 : 0.52));

  if (ant.nestMode === 'digging') {
    const segment = tunnelSegments[ant.excavationProject];
    if (!segment) { ant.nestMode = 'traveling'; ant.nestDirection = -1; return; }
    segment.activeDiggers++;
    ant.nestLaneAngle += dt * (0.08 + (ant.id % 5) * 0.012);
    const excavationCurve = homeNestCurve(segment);
    placeAntOnNestCurve(ant, excavationCurve, Math.max(0.012, segment.progress));
    ant.nestHeading = Math.atan2(
      excavationCurve.getTangentAt(Math.max(0.012, segment.progress)).z,
      excavationCurve.getTangentAt(Math.max(0.012, segment.progress)).x,
    );
    ant.state = `excavating ${segment.name}`;
    ant.energy = Math.max(0, ant.energy - dt * 0.24);
    ant.digTimer -= dt;
    if (segment.progress < 0.999) {
      const morphology = clamp(ant.size, 0.82, 1.2);
      const experience = Math.min(0.2, (ant.taskExperience.excavator || 0) * 0.018);
      const productivity = (0.7 + ant.energy * 0.004 + (ant.tendency === 'excavator' ? 0.18 : 0) + experience) * morphology;
      const nextWork = Math.min(segment.workRequired, segment.work + dt * productivity);
      updateNestEdgeProgress(homeNestGraph, segment, clamp(nextWork / segment.workRequired, 0.012, 1), { work: nextWork });
    }
    if (ant.digTimer <= 0 || segment.progress >= 0.999 || ant.energy < 18) {
      const finalLeg = route.legs[route.legs.length - 1];
      finalLeg.to = Math.max(0.012, segment.progress);
      finalLeg.length = Math.max(0.1, excavationCurve.getLength() * finalLeg.to);
      ant.nestT = finalLeg.to;
      ant.nestLeg = route.legs.length - 1;
      ant.nestDirection = -1;
      ant.nestMode = 'traveling';
      ant.soilCargo = true;
      ant.tasksCompleted++;
      ant.taskExperience.excavator += 1;
      ant.state = 'carrying excavated soil outward';
    }
    return;
  }

  if (ant.nestMode === 'working') {
    ant.nestTimer -= dt;
    if (ant.nestRouteKey === 'vestibule') {
      if (ant.pendingDelivery) depositInEntranceCache(ant);
      if (ant.assignedRole === 'transfer') {
        ant.state = entranceBiology.cache.length > 0 ? 'sorting cached food in entrance vestibule' : 'monitoring empty entrance cache';
        if (ant.nestTimer <= 0 && entranceBiology.cache.length > 0 && !ant.transferCargo) {
          ant.transferCargo = entranceBiology.cache.shift();
          ant.taskExperience.transfer += 1;
          beginNestJourney(ant, 'transferStores');
          ant.state = 'carrying cached food toward stores';
          return;
        }
        if (ant.nestTimer <= 0) ant.nestTimer = rand(1.4, 3.1);
        return;
      }
      if (ant.assignedRole === 'forager') {
        ant.state = ant.pendingDelivery ? 'waiting for cache space' : 'waiting for successful returner contacts';
        if (ant.nestTimer <= 0 && !ant.pendingDelivery) {
          const reserveRatio = homeColonyRecord.demographics?.reserveRatio || 0;
          const foodPressure = clamp((1.28 - reserveRatio) / 1.08, 0, 1);
          const emergencyExploration = reserveRatio < 0.58;
          const weatherSuppression = weather.rain * 0.72 + (environment.season.name === 'winter' ? 0.28 : 0);
          const stimulus = 0.18 + entranceBiology.activation * 0.72 + entranceBiology.recentReturns * 0.34
            + foodPressure * 0.58 + ant.genome.foraging * 0.1 - weatherSuppression;
          const threshold = ant.responseThresholds?.forager ?? 0.5;
          if (emergencyExploration || stimulus + rand(-0.12, 0.12) >= threshold) {
            entranceBiology.activatedDepartures++;
            ant.state = emergencyExploration
              ? 'reserves critical; beginning independent exploratory forage'
              : 'activated by returning foragers';
            ant.nestMode = 'traveling';
            ant.nestDirection = -1;
            ant.nestLeg = route.legs.length - 1;
            ant.nestT = route.legs[ant.nestLeg].to;
          } else {
            entranceBiology.withheldDepartures++;
            beginNestJourney(ant, 'rest', true);
            ant.nestTimer = rand(3.5, 7.5);
            ant.state = 'return rate too low; waiting deeper in nest';
          }
        }
        return;
      }
      if (ant.nestTimer <= 0) {
        if (ant.assignedRole === 'nurse' && brood.length > 0) beginNestJourney(ant, 'nursery');
        else if (ant.assignedRole === 'interior') {
          beginNestJourney(ant, 'rest', true);
          ant.nestTimer = rand(4.5, 10.5);
          ant.state = 'circulating back into the interior reserve';
        }
        else {
          ant.nestMode = 'traveling';
          ant.nestDirection = -1;
          ant.nestLeg = route.legs.length - 1;
          ant.nestT = route.legs[ant.nestLeg].to;
        }
      }
      return;
    }

    if (ant.nestRouteKey === 'transferStores') {
      ant.state = 'unloading transferred food in stores';
      if (ant.transferCargo) {
        delivered++;
        storedFood = acceptColonyStoredFood(HOME_COLONY_ID, storedFood, ant.transferCargo.value);
        storeSeedCargo(HOME_COLONY_ID, ant.transferCargo);
        entranceBiology.storageTransfers++;
        ant.transferCargo = null;
        ant.tasksCompleted++;
        ant.nestTimer = Math.max(ant.nestTimer, rand(1.2, 2.4));
      }
    } else {
      ant.state = ant.nestRouteKey === 'stores' ? 'unloading in food stores'
        : ant.nestRouteKey === 'nursery' ? 'tending brood' : 'resting in deep chamber';
    }
    if (weather.rain > 0.38 && ant.nestRouteKey === 'rest') ant.nestTimer = Math.max(ant.nestTimer, 1.2);
    if (ant.nestTimer <= 0) {
      if (ant.nestRouteKey === 'nursery' && ant.assignedRole === 'nurse' && brood.length > 0) {
        ant.nestTimer = rand(4.5, 9.5);
        ant.tasksCompleted++;
        ant.taskExperience.nurse += 1;
        ant.state = 'repositioning brood in nursery';
        return;
      }
      if (ant.assignedRole === 'interior') {
        ant.nestTimer = rand(4.2, 9.8);
        ant.state = 'inspecting and resting in the interior galleries';
        ant.nestExplorationTrips = (ant.nestExplorationTrips || 0) + 1;
        return;
      }
      ant.nestMode = 'traveling';
      ant.nestDirection = -1;
      ant.nestLeg = route.legs.length - 1;
      ant.nestT = route.legs[ant.nestLeg].to;
    }
    return;
  }

  const leg = route.legs[ant.nestLeg];
  const curve = homeNestCurve(leg.segmentIndex);
  const before = ant.nestPosition.clone();
  const tSpeed = ant.speed * 0.84 * dt / leg.length;
  if (ant.nestDirection > 0) {
    ant.nestT = Math.min(leg.to, ant.nestT + tSpeed * Math.sign(leg.to - leg.from || 1));
  } else {
    ant.nestT = Math.max(Math.min(leg.from, leg.to), ant.nestT - tSpeed * Math.sign(leg.to - leg.from || 1));
  }
  placeAntOnNestCurve(ant, curve, ant.nestT);
  const tangent = curve.getTangentAt(ant.nestT);
  ant.nestHeading = Math.atan2(tangent.z, tangent.x) + (ant.nestDirection < 0 ? Math.PI : 0);
  ant.distanceTraveled += before.distanceTo(ant.nestPosition);

  const reached = ant.nestDirection > 0
    ? Math.abs(ant.nestT - leg.to) < 0.0001
    : Math.abs(ant.nestT - leg.from) < 0.0001;
  ant.state = ant.nestDirection > 0 ? `descending to ${route.label}` : 'climbing toward daylight';
  if (!reached) return;

  if (ant.nestDirection > 0) {
    ant.nestLeg++;
    if (ant.nestLeg >= route.legs.length) {
      ant.nestLeg = route.legs.length - 1;
      if (ant.nestRouteKey === 'excavation') {
        ant.nestMode = 'digging';
        ant.digTimer = rand(6.2, 11.5);
      } else {
        ant.nestMode = 'working';
        ant.nestTimer = ant.nestRouteKey === 'rest' ? rand(3.5, 8) : rand(2.2, 5.4);
      }
    } else {
      ant.nestT = route.legs[ant.nestLeg].from;
      setNestPosition(ant);
    }
  } else {
    ant.nestLeg--;
    if (ant.nestLeg < 0) {
      if (ant.nestRouteKey === 'transferStores' || ant.assignedRole === 'transfer') {
        beginNestJourney(ant, 'vestibule', true);
        ant.nestTimer = rand(0.7, 1.8);
      } else if (ant.assignedRole === 'forager' && ant.nestRouteKey !== 'vestibule' && weather.rain < 0.62) {
        beginNestJourney(ant, 'vestibule', true);
        ant.nestTimer = rand(1.2, 3.4);
        ant.state = 'entering vestibule before departure';
      } else if (ant.assignedRole === 'interior') {
        beginNestJourney(ant, 'rest', true);
        ant.nestTimer = rand(4.2, 9.8);
      } else emergeFromNest(ant);
    }
    else {
      ant.nestT = route.legs[ant.nestLeg].to;
      setNestPosition(ant);
    }
  }
}

function updateAmberWorkerPolicy(ant, dt) {
  if (!ant.alive) return;
  ant.borderCooldown -= dt;
  ant.turnClock -= dt;
  ant.pause -= dt;

  if (ant.insideNest) {
    updateNestAnt(ant, dt);
    return;
  }

  if (ant.pause <= 0 && random() < dt * 0.07) ant.pause = rand(0.08, 0.34);
  const nestDx = NEST.x - ant.x;
  const nestDz = NEST.y - ant.z;
  const nestDistance = Math.hypot(nestDx, nestDz);
  const navigation = ensureWorkerNavigation(ant, ant.generation === 0);
  let learningWalkActive = false;
  if (!ant.carrying && navigation.learningWalk < 1 && nestDistance < 2.7) {
    const outward = Math.atan2(ant.z - NEST.y, ant.x - NEST.x);
    steerTowards(ant, outward + Math.PI * 0.5 + Math.sin(ant.phase * 0.15) * 0.3, 0.82);
    navigation.learningWalk = clamp(navigation.learningWalk + dt * 0.11, 0, 1);
    navigation.guidance = 'learning walk';
    learningWalkActive = true;
    ant.state = 'learning the nest panorama';
    if (navigation.learningWalk >= 1) {
      homeForagingNetwork.learningWalksCompleted++;
      chooseForagingSector(ant, homeForagingNetwork, true);
    }
  }

  if (predator.active) {
    const predatorDistance = Math.hypot(ant.x - predator.x, ant.z - predator.z);
    if (predatorDistance < 3.1) {
      ant.state = ant.health < 60 ? 'fleeing while injured' : 'fleeing hunting beetle';
      steerTowards(ant, Math.atan2(ant.z - predator.z, ant.x - predator.x) + ant.laneBias, 0.96);
      moveSurfaceDirected(ant, dt, 1.38);
      return;
    }
  }
  if (spider.active) {
    const spiderDistance = Math.hypot(ant.x - spider.x, ant.z - spider.z);
    if (spiderDistance < 2.5) {
      ant.state = webSlowAt(ant.x, ant.z) < 0.8 ? 'struggling in spider web' : 'fleeing web spider';
      steerTowards(ant, Math.atan2(ant.z - spider.z, ant.x - spider.x) + ant.laneBias, 0.96);
      moveSurfaceDirected(ant, dt, 1.3);
      return;
    }
  }

  if (updateSanitationSurface(ant, dt)) return;
  if (updateExcavationSurface(ant, dt)) return;

  if (ant.assignedRole === 'transfer' && !ant.carrying) {
    ant.state = 'returning to work entrance cache';
    steerTowards(ant, Math.atan2(nestDz, nestDx) + ant.laneBias * 0.18, 0.9);
    if (nestDistance < 0.77) {
      beginNestJourney(ant, 'vestibule');
      return;
    }
    moveSurfaceDirected(ant, dt, 1.02);
    return;
  }

  if (ant.assignedRole === 'nurse' && brood.length > 0 && !ant.carrying) {
    ant.state = 'returning to tend brood';
    steerTowards(ant, Math.atan2(nestDz, nestDx) + ant.laneBias * 0.22, 0.88);
    if (nestDistance < 0.77) {
      beginNestJourney(ant, 'nursery');
      return;
    }
    moveSurfaceDirected(ant, dt, 1.03);
    return;
  }

  if (!ant.carrying && (weather.rain > 0.52 || ant.energy < 24) && nestDistance < 0.9) {
    beginNestJourney(ant, 'rest');
    return;
  }

  if (ant.assignedRole === 'interior' && !ant.carrying) {
    ant.state = 'returning to the interior reserve';
    steerTowards(ant, Math.atan2(nestDz, nestDx) + ant.laneBias * 0.28, 0.9);
    if (nestDistance < 0.77) {
      beginNestJourney(ant, 'rest');
      return;
    }
    moveSurfaceDirected(ant, dt, 1.04);
    return;
  }

  if (ant.carrying) {
    ant.state = weather.rain > 0.68 ? 'hurrying home' : 'carrying food';
    const homeAngle = Math.atan2(nestDz, nestDx) + Math.sin(ant.phase * 0.21) * 0.055 + ant.laneBias * 0.34;
    steerTowards(ant, homeAngle, 0.82);
    const trailStrength = 0.016 + clamp(nestDistance / 20, 0, 1) * 0.026;
    pherDeposit(ant.x, ant.z, trailStrength);
    if (nestDistance < 0.77) {
      beginNestJourney(ant, 'vestibule');
      return;
    }
  } else if (!learningWalkActive) {
    const food = nearestFood(ant);
    if (food) {
      loadWorkerFoodCargo(ant, food);
      ant.state = 'collecting';
      recordFoodDiscovery(ant, food);
      removeFoodUnits(food, 1, 'ant harvest');
    } else {
      const look = 0.8;
      const side = 0.56;
      const pL = pherSample(ant.x + Math.cos(ant.heading - side) * look, ant.z + Math.sin(ant.heading - side) * look);
      const pC = pherSample(ant.x + Math.cos(ant.heading) * look, ant.z + Math.sin(ant.heading) * look);
      const pR = pherSample(ant.x + Math.cos(ant.heading + side) * look, ant.z + Math.sin(ant.heading + side) * look);
      const strongest = Math.max(pL, pC, pR);
      expireStaleForagingMemory(ant, homeForagingNetwork);
      const sector = chooseForagingSector(ant, homeForagingNetwork);
      const searchTarget = foragingSearchTarget(ant, homeForagingNetwork, sector);
      const privateWeight = navigation.confidence * (0.55 + flightLightLevel() * 0.85);
      const socialWeight = strongest * 0.42 + sector.socialPulse * 0.32 + entranceBiology.activation * 0.08;
      if (navigation.rememberedX != null && privateWeight > socialWeight && navigation.searchTime < 18) {
        const memoryAngle = Math.atan2(searchTarget.z - ant.z, searchTarget.x - ant.x);
        steerTowards(ant, memoryAngle + ant.laneBias * 0.22, 0.82);
        ant.state = 'following private route memory';
        navigation.guidance = 'private route memory';
        homeForagingNetwork.memoryGuidedSteps += dt;
      } else if (strongest > 0.035 / ant.genome.foraging && random() < clamp(0.72 + ant.genome.foraging * 0.15, 0.78, 0.93)) {
        ant.state = 'following scent';
        navigation.guidance = 'social trail information';
        homeForagingNetwork.socialGuidedSteps += dt;
        let offset = 0;
        if (pL > pC && pL > pR) offset = -side;
        else if (pR > pC) offset = side;
        steerTowards(ant, ant.heading + offset + ant.laneBias * 0.5 + rand(-0.09, 0.09), 0.66);
      } else if (sector.socialPulse > 0.12 && !sector.stale) {
        steerTowards(ant, Math.atan2(searchTarget.z - ant.z, searchTarget.x - ant.x) + ant.laneBias * 0.3, 0.72);
        ant.state = 'following social sector information';
        navigation.guidance = 'social sector activation';
        homeForagingNetwork.socialGuidedSteps += dt;
      } else {
        ant.state = (weather.rain > 0.72 || ant.energy < 30) && nestDistance > 2 ? 'returning to nest' : 'exploring';
        if ((weather.rain > 0.72 || ant.energy < 30) && nestDistance > 2) {
          steerTowards(ant, Math.atan2(nestDz, nestDx), 0.42);
        } else {
          const sectorAngle = Math.atan2(searchTarget.z - ant.z, searchTarget.x - ant.x);
          const targetAngle = sectorAngle + Math.sin(ant.phase * 0.07 + ant.id) * (nestDistance < 2 ? 0.18 : 0.34);
          steerTowards(ant, targetAngle, 0.72);
          navigation.guidance = 'sector exploration';
        }
      }
      advanceForagingSearch(ant, homeForagingNetwork, sector, dt);
    }
  }

  // Obstacle avoidance is deliberately local and imperfect.
  for (const obstacle of obstacles) {
    const dx = obstacle.x - ant.x;
    const dz = obstacle.z - ant.z;
    const d = Math.hypot(dx, dz);
    if (d < obstacle.r + 0.66) {
      const away = Math.atan2(-dz, -dx);
      steerTowards(ant, away + rand(-0.25, 0.25), 0.94);
      ant.state = 'detouring';
    }
  }

  if (Math.abs(ant.x) > HALF_W - 0.9 || Math.abs(ant.z) > HALF_D - 0.9) {
    steerTowards(ant, Math.atan2(-ant.z, -ant.x), 0.92);
  }

  if (!ant.carrying && !learningWalkActive && nestDistance < 1.55 && weather.rain < 0.52 && ant.energy >= 30) {
    const outward = Math.atan2(ant.z - NEST.y, ant.x - NEST.x);
    steerTowards(ant, outward + ant.laneBias * 0.8, 0.76);
    ant.state = 'leaving nest';
  }

  applyNeighborAvoidance(ant);

  const turnRate = dt * (ant.carrying ? 4.7 : 3.8);
  ant.heading += clamp(wrapAngle(ant.desired - ant.heading), -turnRate, turnRate);
  const rainSlow = 1 - weather.rain * 0.24;
  const pauseFactor = ant.pause > 0 ? 0.12 : 1;
  const velocity = ant.speed * rainSlow * pauseFactor * (ant.carrying ? 1.08 : 1) * webSlowAt(ant.x, ant.z);
  ant.x += Math.cos(ant.heading) * velocity * dt;
  ant.z += Math.sin(ant.heading) * velocity * dt;
  ant.distanceTraveled += velocity * dt;
  ant.energy = Math.max(0, ant.energy - velocity * dt * 0.075);
  ant.x = clamp(ant.x, -HALF_W + 0.35, HALF_W - 0.35);
  ant.z = clamp(ant.z, -HALF_D + 0.35, HALF_D - 0.35);
}

function renderAnts() {
  antPresentation.renderHomeWorkers(ants);
}

function renderRivals() {
  antPresentation.renderRivalWorkers(rivalAnts);
}

function antWorldPosition(ant, out = new THREE.Vector3()) {
  if (ant.insideNest) return out.copy(ant.nestPosition);
  return out.set(ant.x, groundHeight(ant.x, ant.z) + 0.13, ant.z);
}

function selectAnt(ant) {
  selectedAnt = ant || null;
  followingSelected = Boolean(ant);
  selectionPresentation.select(ant ? antWorldPosition(ant) : null);
  if (ant) {
    const colony = colonyForWorker(ant);
    if (colony) cameraRig.focusedColonyId = colony.id;
    const below = ant.insideNest;
    cameraRig.desiredPitch = below ? -0.32 : 0.72;
    cameraRig.desiredDistance = below ? 8.8 : Math.min(cameraRig.desiredDistance, 11.5);
    updateAntNote();
  } else simulationUI.renderAntNote(null);
}

function updateAntNote() {
  if (!selectedAnt) return;
  const colony = colonyForWorker(selectedAnt);
  const assignment = selectedAnt.assignedRole || selectedAnt.role || selectedAnt.tendency || 'worker';
  const tendency = selectedAnt.tendency || selectedAnt.role || assignment;
  const infection = selectedAnt.infection || 0;
  const location = selectedAnt.insideNest
    ? selectedAnt.colony === 'incipient' ? 'claustral founding chamber'
      : selectedAnt.colonyId === RIVAL_COLONY_ID ? 'slate transfer gallery' : antNestRoute(selectedAnt)?.label || 'nest passage'
    : 'surface';
  const facts = [
    { label: 'colony', value: colony?.displayName || 'unregistered colony' },
    { label: 'lineage', value: colony?.lineageId || 'unknown' },
    { label: 'assignment', value: assignment },
    { label: 'tendency', value: tendency },
  ];
  if (selectedAnt.responseThresholds) facts.push({
    label: 'response',
    value: `${selectedAnt.responseThresholds[assignment]?.toFixed(2) || 'flexible'} threshold`,
  });
  facts.push(
    { label: 'generation', value: `G${selectedAnt.generation}` },
    { label: 'traits', value: `${selectedAnt.genome.speed.toFixed(2)} speed · ${selectedAnt.genome.diseaseResistance.toFixed(2)} resilience` },
    { label: 'maturity', value: workerMaturity(selectedAnt.ageDays) },
    { label: 'size class', value: `${selectedAnt.workerCaste || 'media'} worker` },
    { label: 'location', value: location },
    { label: 'age', value: `${selectedAnt.ageDays.toFixed(1)} days` },
    { label: 'energy', value: `${Math.round(selectedAnt.energy)}%` },
    { label: 'health', value: `${Math.round(selectedAnt.health)}%` },
    { label: 'condition', value: infection > 0 ? `infected ${Math.round(infection * 100)}%` : selectedAnt.health < 70 ? 'injured' : 'healthy' },
    {
      label: 'cargo',
      value: selectedAnt.transferCargo ? selectedAnt.transferCargo.kind === 'seed'
        ? `${selectedAnt.transferCargo.seedSpecies || 'wild'} seed transfer` : 'cached food transfer'
        : selectedAnt.sanitationCargo ? 'colony remains'
          : selectedAnt.soilCargo ? 'excavated soil'
            : selectedAnt.carrying ? selectedAnt.carryingKind === 'seed'
              ? `${selectedAnt.carryingSeedSpecies || 'wild'} seed` : 'food fragment'
              : 'none',
    },
  );
  if (selectedAnt.navigation) facts.push(
    { label: 'navigation', value: `sector ${selectedAnt.navigation.sectorId ?? '—'} · ${selectedAnt.navigation.guidance}` },
    { label: 'route memory', value: `${Math.round(selectedAnt.navigation.confidence * 100)}% confidence · ${selectedAnt.navigation.successfulTrips} successful returns` },
  );
  if (selectedAnt.excavationProject != null) facts.push({
    label: 'worksite', value: tunnelSegments[selectedAnt.excavationProject].name,
  });
  facts.push(
    { label: 'completed', value: String(selectedAnt.tasksCompleted || 0) },
    { label: 'nest trips', value: String(selectedAnt.trips || 0) },
  );
  simulationUI.renderAntNote({
    title: `Worker ${workerDisplayId(selectedAnt)}`,
    task: selectedAnt.state,
    facts,
  });
}

function updateSelection(dt) {
  selectionPresentation.update({
    ant: selectedAnt,
    position: selectedAnt ? antWorldPosition(selectedAnt) : null,
    dt,
    simTime,
    groundHeight,
  });
  if (selectedAnt) updateAntNote();
}

// ---------- weather, motes and subtle feedback ----------
const weather = { rain: 0, rainTimer: 0, nextRain: 38, postRainHumidity: 0 };
const rainCount = 260;
const rainData = new Float32Array(rainCount * 2 * 3);
for (let i = 0; i < rainCount; i++) {
  const x = rand(-HALF_W, HALF_W), y = rand(1, 18), z = rand(-HALF_D, HALF_D);
  rainData.set([x, y, z, x - 0.08, y - 0.75, z + 0.06], i * 6);
}
const rainGeometry = new THREE.BufferGeometry();
rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainData, 3));
const rainMaterial = new THREE.LineBasicMaterial({ color: 0xdce8e1, transparent: true, opacity: 0 });
const rainLines = new THREE.LineSegments(rainGeometry, rainMaterial);
rainLines.frustumCulled = false;
surfaceGroup.add(rainLines);

const moteCount = 115;
const moteData = new Float32Array(moteCount * 3);
for (let i = 0; i < moteCount; i++) moteData.set([rand(-HALF_W, HALF_W), rand(0.8, 8), rand(-HALF_D, HALF_D)], i * 3);
const moteGeometry = new THREE.BufferGeometry();
moteGeometry.setAttribute('position', new THREE.BufferAttribute(moteData, 3));
const motes = new THREE.Points(moteGeometry, new THREE.PointsMaterial({ color: 0xffe2a1, size: 0.055, transparent: true, opacity: 0.32, depthWrite: false }));
surfaceGroup.add(motes);

const seasonalGroundData = new Float32Array(170 * 3);
for (let i = 0; i < 170; i++) {
  const x = rand(-HALF_W + 0.4, HALF_W - 0.4);
  const z = rand(-HALF_D + 0.4, HALF_D - 0.4);
  seasonalGroundData.set([x, groundHeight(x, z) + 0.065, z], i * 3);
}
const seasonalGroundGeometry = new THREE.BufferGeometry();
seasonalGroundGeometry.setAttribute('position', new THREE.BufferAttribute(seasonalGroundData, 3));
const seasonalGroundMaterial = new THREE.PointsMaterial({
  color: 0xdbe8b4, size: 0.085, transparent: true, opacity: 0.22, depthWrite: false, sizeAttenuation: true,
});
const seasonalGround = new THREE.Points(seasonalGroundGeometry, seasonalGroundMaterial);
surfaceGroup.add(seasonalGround);

function createSignal(x, z, color = 0xf2d47d) {
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.46, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.28, 48), material);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, groundHeight(x, z) + 0.08, z);
  ring.userData.life = 1;
  surfaceGroup.add(ring);
  signals.push(ring);
}

function startRain(seconds = 13) {
  weather.rainTimer = Math.max(weather.rainTimer, seconds);
  weather.nextRain = simTime + rand(48, 78);
  createSignal(NEST.x, NEST.y, 0xa7c6bf);
}

function updateWeather(dt) {
  if (clearWeatherTest) {
    weather.rainTimer = 0;
    weather.rain = 0;
    weather.postRainHumidity = Math.max(0, weather.postRainHumidity - dt * 0.0085);
    rainMaterial.opacity = 0;
    rainLines.visible = false;
    return;
  }
  if (simTime > weather.nextRain && weather.rainTimer <= 0) startRain(rand(9, 15) * environment.season.rain);
  if (weather.rainTimer > 0) weather.rainTimer -= dt;
  const target = weather.rainTimer > 0 ? 1 : 0;
  weather.rain += (target - weather.rain) * dt * (target ? 0.55 : 0.28);
  if (weather.rain > 0.42) weather.postRainHumidity = Math.min(1, weather.postRainHumidity + dt * 0.12);
  else weather.postRainHumidity = Math.max(0, weather.postRainHumidity - dt * 0.0085);
  rainMaterial.opacity = weather.rain * 0.34;
  rainLines.visible = weather.rain > 0.015;
  const rp = rainGeometry.attributes.position.array;
  for (let i = 0; i < rainCount; i++) {
    let y = rp[i * 6 + 1] - dt * (17 + (i % 7));
    if (y < groundHeight(rp[i * 6], rp[i * 6 + 2])) y = rand(12, 20);
    rp[i * 6 + 1] = y;
    rp[i * 6 + 4] = y - 0.75;
  }
  rainGeometry.attributes.position.needsUpdate = true;
}

function updateAtmosphere(dt) {
  const mp = moteGeometry.attributes.position.array;
  for (let i = 0; i < moteCount; i++) {
    mp[i * 3] += Math.sin(simTime * 0.17 + i) * dt * 0.045;
    mp[i * 3 + 1] += dt * (0.025 + (i % 6) * 0.005);
    if (mp[i * 3 + 1] > 8) mp[i * 3 + 1] = 0.7;
  }
  moteGeometry.attributes.position.needsUpdate = true;
  motes.material.opacity = 0.34 * (1 - weather.rain * 0.92);
  const seasonalColor = environment.season.name === 'winter' ? 0xe8f0ef
    : environment.season.name === 'autumn' ? 0xc4773f
      : environment.season.name === 'spring' ? 0xb8d67d : 0xe2ca82;
  seasonalGround.material.color.lerp(new THREE.Color(seasonalColor), Math.min(1, dt * 1.2));
  seasonalGround.material.opacity = environment.season.name === 'winter' ? 0.62
    : environment.season.name === 'autumn' ? 0.5 : environment.season.name === 'spring' ? 0.28 : 0.12;
  seasonalGround.material.size = environment.season.name === 'autumn' ? 0.12 : environment.season.name === 'winter' ? 0.095 : 0.075;
  const grassTint = environment.season.name === 'winter' ? 0x718080
    : environment.season.name === 'autumn' ? 0x7c703c : environment.season.name === 'spring' ? 0x698844 : 0x667640;
  grassMaterial.color.lerp(new THREE.Color(grassTint), Math.min(1, dt * 0.5));
  propMaterials.moss.color.lerp(new THREE.Color(grassTint), Math.min(1, dt * 0.35));
  for (let i = signals.length - 1; i >= 0; i--) {
    const ring = signals[i];
    ring.userData.life -= dt * 0.62;
    ring.scale.setScalar(1 + (1 - ring.userData.life) * 4.2);
    ring.material.opacity = Math.max(0, ring.userData.life * 0.42);
    if (ring.userData.life <= 0) {
      ring.parent?.remove(ring);
      ring.geometry.dispose();
      ring.material.dispose();
      signals.splice(i, 1);
    }
  }
}

// ---------- user-created obstacles ----------
function addObstacle(x, z) {
  const radius = rand(0.42, 0.68);
  const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(radius, 0), rockMaterial.clone());
  mesh.material.color.setHSL(rand(0.08, 0.13), 0.16, rand(0.36, 0.48));
  mesh.scale.y = rand(0.48, 0.74);
  mesh.position.set(x, groundHeight(x, z) + radius * mesh.scale.y * 0.48, z);
  mesh.rotation.set(rand(0, 1), rand(0, Math.PI), rand(0, 1));
  mesh.castShadow = mesh.receiveShadow = true;
  surfaceGroup.add(mesh);
  obstacles.push({ x, z, r: radius * 0.9, mesh });
  createSignal(x, z, 0xa58f6a);
}

function recordEcologicalCheckpoint() {
  if (simTime < ecologicalBalance.nextCheckpointAt) return;
  ecologicalBalance.nextCheckpointAt = simTime + SEASON_SECONDS * 0.5;
  const activeFood = foods.filter((food) => food.amount > 0);
  ecologicalBalance.samples.push({
    time: Number(simTime.toFixed(1)),
    year: Number((simTime / ECOLOGICAL_YEAR_SECONDS).toFixed(2)),
    season: environment.season.name,
    totalWorkers: totalActiveWorkers(),
    livingColonies: livingColonies().length,
    surfaceFoodUnits: Number(activeFood.reduce((sum, food) => sum + food.amount * food.nutrition, 0).toFixed(1)),
    activeFoodSources: activeFood.length,
    livingPlants: vegetationEcology.plants.filter((plant) => plant.alive).length,
    colonies: livingColonies().map((colony) => ({
      id: colony.id,
      status: colony.status,
      workers: colony.workers.filter((worker) => worker.alive !== false).length,
      brood: colony.brood.length,
      storedFood: Number(colony.storedFood.toFixed(1)),
      reserveRatio: Number((colony.demographics?.reserveRatio || 0).toFixed(2)),
      workersEclosed: colony.workersEclosed,
      deaths: colony.deaths,
    })),
  });
  if (ecologicalBalance.samples.length > 40) ecologicalBalance.samples.shift();
}

// ---------- simulation loop ----------
let spawnClock = 0;
let foodClock = 0;
let paused = false;
let simSpeedIndex = 2;
let timeScale = SIM_SPEEDS[simSpeedIndex];
const requestedTimeScale = Number(new URLSearchParams(window.location.search).get('speed'));
if (SIM_SPEEDS.includes(requestedTimeScale)) {
  simSpeedIndex = SIM_SPEEDS.indexOf(requestedTimeScale);
  timeScale = requestedTimeScale;
}
if (new URLSearchParams(window.location.search).get('predator') === '1') startPredatorVisit(true);
if (new URLSearchParams(window.location.search).get('spider') === '1') startSpiderVisit();

function showTimeScale(label = `TIME ×${timeScale}`) {
  simulationUI.showTimeScale(label);
}

function changeTimeScale(direction) {
  simSpeedIndex = clamp(simSpeedIndex + direction, 0, SIM_SPEEDS.length - 1);
  timeScale = SIM_SPEEDS[simSpeedIndex];
  showTimeScale();
}

function update(dt) {
  if (paused) return;
  simTime += dt;
  spawnClock += dt;
  foodClock += dt;
  const seasonalFoodInterval = 27 / environment.season.food / (demographicScenario === 'abundance' ? 1.45 : 1);
  if (demographicScenario !== 'scarcity' && foodClock > seasonalFoodInterval
    && foods.filter((f) => f.amount > 0).length < Math.ceil(2 + environment.season.food * 2
      + (demographicScenario === 'abundance' ? 2 : 0))) {
    foodClock = 0;
    const roll = random();
    const kind = environment.season.name === 'winter' ? (roll < 0.72 ? 'seed' : 'crumb')
      : roll < 0.22 ? 'berry' : roll < 0.38 ? 'beetle' : roll < 0.62 ? 'seed' : 'crumb';
    const seedSpecies = kind === 'seed' ? Object.keys(PLANT_PROFILES)[Math.floor(random() * Object.keys(PLANT_PROFILES).length)] : null;
    addFood(
      rand(-12, 13), rand(-9, 9), kind,
      Math.floor(rand(34, 72) * environment.season.food * RESOURCE_ABUNDANCE_FACTOR), rand(1.2, 1.7),
      kind === 'seed' ? { source: 'regional seed rain', seedSpecies } : { source: 'incidental seasonal food' },
    );
  }
  updateSurvival(dt);
  updateColonyLifeHistories({
    refreshSummary: lowFrequencySchedule.due('life-history-summary', simTime, 0.25),
  });
  // Build before every surface-moving actor, including predators.
  rebuildSurfaceWorkerGrid();
  updatePredator(dt);
  updateSpider(dt);
  refreshSurfaceWorkerGrid([...surfaceWorkersNeedingRefresh]);
  surfaceWorkersNeedingRefresh.clear();
  updateWeather(dt);
  updateVegetationEcology(dt);
  retireDepletedFoodRecords();
  // Phase 9E spatial schedule: one canonical build before movement,
  // bounded colony-local cell refreshes between movement groups, and one
  // canonical build before final overlap/contact resolution.
  updateNuptialFlight(dt);
  refreshSurfaceWorkerGrid(descendantWorkers());
  updatePheromones(dt);
  updateForagingNetworks(dt);
  updateEntranceBiology(dt);
  refreshConstructionProjects();
  updateLaborAssignments(dt);
  updateColonyBiology(dt);
  refreshSurfaceWorkerGrid([...surfaceWorkersNeedingRefresh]);
  surfaceWorkersNeedingRefresh.clear();
  updateRivalColony(dt);
  refreshSurfaceWorkerGrid([...rivalAnts, ...surfaceWorkersNeedingRefresh]);
  surfaceWorkersNeedingRefresh.clear();
  updateColonyArchitectures(dt);
  for (const ant of ants) updateWorker(workerWorld, homeColonyRecord, ant, dt);
  removeDeadRegisteredWorkers(homeColonyRecord);
  rebuildSurfaceWorkerGrid();
  resolveSurfaceWorkerSpacing();
  updateAtmosphere(dt);
  updateUnderground();
  updateSelection(dt);
  recordEcologicalCheckpoint();

  presentation.updateSurfaceLighting({ simTime, weather, environment, terrain, dt });
}

function runFixedStep() {
  const profileStartedAt = profiler.begin('fixedStep');
  update(FIXED_DT);
  profiler.end('fixedStep', profileStartedAt);
  profiler.incrementFrame('fixedSteps');
}

function updateCamera(dt) {
  followingSelected = presentation.updateCamera({
    dt,
    followingSelected,
    selectedAnt,
    antWorldPosition,
    input: simulationInput,
    groundHeight,
    focusedColony,
  });
  simulationUI.update(dt);
}

function render() {
  presentation.renderFrame({
    profiler,
    updateAdaptiveVisualDetail,
    renderAnts,
    renderRivals,
    renderRegionalReproductionVisuals,
    adaptiveVisualState,
  });
}

let last = performance.now();
let accumulator = 0;
let nextDebugRefreshAt = 0;
let droppedBacklogSeconds = 0;
const MAX_FIXED_STEPS_PER_FRAME = 16;
const MAX_DEFERRED_FIXED_STEPS = 4;

function collectDebugState() {
  const fixtureComparison = window.fixtureComparison;
  const activeColonies = livingColonies();
  let simulatedUnderground = 0;
  for (const colony of activeColonies) {
    simulatedUnderground += colony.workers.reduce((count, worker) => count
      + Number(worker.alive !== false && worker.insideNest), 0);
  }
  const fixtureStatus = requestedFixtureId
    ? fixtureComparison?.ok ? `${requestedFixtureId} · PASS`
      : fixtureComparison ? `${requestedFixtureId} · ${fixtureComparison.differenceCount || 0} differences`
        : `${requestedFixtureId} · pending`
    : null;
  return {
    profile: profiler.snapshot(),
    backlogMs: accumulator * 1000,
    backlogGuard: {
      deferredSteps: Math.max(0, Math.floor((accumulator + Number.EPSILON) / FIXED_DT)),
      droppedMs: droppedBacklogSeconds * 1000,
    },
    simulatedSurface: adaptiveVisualState.simulatedSurfaceWorkers,
    renderedSurface: adaptiveVisualState.renderedSurfaceWorkers,
    simulatedUnderground,
    renderedUnderground: adaptiveVisualState.renderedUndergroundWorkers,
    livingColonies: activeColonies.length,
    visualMode: adaptiveVisualState.level,
    renderer: {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    },
    events: regionalLineageHistory.events.length + regionalLifeHistory.events.length,
    transients: {
      signals: signals.length,
      remains: remains.length,
      spoil: spoilClods.length,
      wings: shedWings.length,
    },
    fixtureStatus,
  };
}

function refreshDebugOverlay(now = performance.now()) {
  if (!debugOverlay.enabled || now < nextDebugRefreshAt) return;
  nextDebugRefreshAt = now + 250;
  debugOverlay.update(collectDebugState(), now);
}

function frame(now) {
  profiler.beginFrame();
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  accumulator += dt * timeScale;
  const backlogResult = drainFixedStepBacklog({
    accumulator,
    fixedDt: FIXED_DT,
    maxSteps: MAX_FIXED_STEPS_PER_FRAME,
    maxDeferredSteps: MAX_DEFERRED_FIXED_STEPS,
    step: runFixedStep,
  });
  accumulator = backlogResult.accumulator;
  droppedBacklogSeconds += backlogResult.droppedSeconds;
  if (backlogResult.deferredSteps > 0) {
    profiler.incrementFrame('fixedStepsDeferred', backlogResult.deferredSteps);
  }
  if (backlogResult.droppedSteps > 0) {
    profiler.incrementFrame('fixedStepsDropped', backlogResult.droppedSteps);
  }
  profiler.setGauge('updateBacklogMs', Number((accumulator * 1000).toFixed(3)));
  profiler.setGauge('deferredFixedSteps', backlogResult.deferredSteps);
  profiler.setGauge('droppedBacklogMs', Number((droppedBacklogSeconds * 1000).toFixed(3)));
  updateCamera(dt);
  render();
  profiler.endFrame();
  refreshDebugOverlay(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- direct, low-interface interaction ----------
function groundPoint(clientX, clientY) {
  return selectionPresentation.groundPoint(clientX, clientY);
}

function antAtPointer(clientX, clientY) {
  const architectureWorkerSprites = Array.from(colonyNestPresentations.values())
    .flatMap((nestPresentation) => nestPresentation.released ? [] : nestPresentation.workerPool || []);
  return selectionPresentation.antAtPointer({
    clientX,
    clientY,
    antMeshes,
    rivalMeshes,
    youngWorkerMeshes,
    antInstanceLookup,
    rivalInstanceLookup,
    youngWorkerInstanceLookup,
    undergroundSpritePool,
    rivalTransferPool,
    undergroundWorkerSprites: architectureWorkerSprites,
    resolveWorker: (uid) => workerLookup.resolveRuntimeUid(uid),
  });
}

function handlePointerTap(clientX, clientY, shiftKey) {
  const clickedAnt = antAtPointer(clientX, clientY);
  if (clickedAnt) {
    selectAnt(clickedAnt);
    return;
  }
  if (viewState.undergroundBlend >= 0.42) return;
  const point = groundPoint(clientX, clientY);
  if (!point) return;
  if (shiftKey) addObstacle(point.x, point.z);
  else addFood(point.x, point.z, random() < 0.18 ? 'berry' : 'crumb', Math.floor(rand(35, 62)), rand(1.15, 1.55));
}

function panCamera(dx, dy) {
  const pan = cameraRig.distance * 0.0015;
  cameraRig.target.x += (-Math.cos(cameraRig.yaw) * dx + Math.sin(cameraRig.yaw) * dy) * pan;
  cameraRig.target.z += (Math.sin(cameraRig.yaw) * dx + Math.cos(cameraRig.yaw) * dy) * pan;
  cameraRig.target.x = clamp(cameraRig.target.x, -10, 10);
  cameraRig.target.z = clamp(cameraRig.target.z, -7, 7);
}

function orbitCamera(dx, dy) {
  cameraRig.yaw -= dx * 0.0046;
  cameraRig.desiredPitch = clamp(cameraRig.desiredPitch - dy * 0.0042, -1.12, 1.16);
}

function focusGroundPoint(clientX, clientY) {
  if (viewState.undergroundBlend >= 0.42) return;
  const point = groundPoint(clientX, clientY);
  if (!point) return;
  cameraRig.target.x = point.x;
  cameraRig.target.z = point.z;
  cameraRig.desiredDistance = Math.min(cameraRig.desiredDistance, 12.5);
}

function zoomCamera(deltaY) {
  cameraRig.desiredDistance = clamp(cameraRig.desiredDistance * Math.exp(deltaY * 0.001), 7.5, 32);
  cameraRig.idle = 0;
}

function toggleDepthView() {
  followingSelected = false;
  const goingBelow = cameraRig.desiredPitch > -0.1;
  cameraRig.desiredPitch = goingBelow ? -0.32 : 0.78;
  cameraRig.desiredDistance = goingBelow ? (focusedColony()?.undergroundDistance || 10.8) : 24;
  if (goingBelow) {
    cameraRig.yaw = 1.22;
    focusCameraOnColony(focusedColony(), false);
  }
}

function openIdealFlightWindow() {
  weather.rainTimer = 0;
  weather.rain = 0;
  weather.postRainHumidity = 1;
  openNuptialFlight(true);
}

function resetTimeScale() {
  simSpeedIndex = 2;
  timeScale = 1;
  showTimeScale();
}

function togglePause() {
  paused = !paused;
  showTimeScale(paused ? 'TIME PAUSED' : `TIME ×${timeScale}`);
}

function resize() {
  presentation.resize(simulationUI.readViewport());
}

const simulationInput = createSimulationInput({
  canvas,
  onPointerStart: () => { cameraRig.idle = 0; },
  onPointerEnd: () => { cameraRig.idle = 0; },
  onPointerTap: handlePointerTap,
  onOrbit: orbitCamera,
  onPan: panCamera,
  onDoubleClick: focusGroundPoint,
  onZoom: zoomCamera,
  onRain: () => startRain(14),
  onPredator: () => { if (!predator.active) startPredatorVisit(true); },
  onSpider: () => { if (!spider.active) startSpiderVisit(); },
  onFlightWindow: openIdealFlightWindow,
  onCycleNest: cycleFocusedColony,
  onToggleDepth: toggleDepthView,
  onChangeSpeed: changeTimeScale,
  onResetSpeed: resetTimeScale,
  onReleaseSelection: () => selectAnt(null),
  onTogglePause: togglePause,
  onResize: resize,
});

// Deterministic hooks used by automated observation and interaction tests.
window.advanceTime = (ms) => {
  const steps = Math.max(1, Math.round((ms / 1000) * timeScale / FIXED_DT));
  profiler.beginFrame();
  for (let i = 0; i < steps; i++) runFixedStep();
  updateCamera(ms / 1000);
  render();
  profiler.endFrame();
  refreshDebugOverlay();
};

function findWorkerByIdentity(identity) {
  const raw = String(identity ?? '').trim();
  const normalized = raw.toUpperCase();
  const indexed = workerLookup.resolve(raw);
  if (indexed) return indexed;
  const byColonyUid = /^([A-Z]+)[-:]W?(\d+)$/.exec(normalized);
  if (byColonyUid) {
    const colony = getColony(byColonyUid[1].toLowerCase());
    return colony?.workers.find((worker) => worker.id === Number(byColonyUid[2])) || null;
  }
  return ants.find((worker) => worker.id === Number(raw)) || null;
}

window.selectAntById = (id) => selectAnt(findWorkerByIdentity(id));
window.focusColonyById = (id) => focusCameraOnColony(getColony(String(id)));

function readObservationState() {
  return {
    adaptiveVisualState,
    ants,
    averageGenome,
    antNestRoute,
    architectureBroodCapacity,
    architectureNodeById,
    brood,
    cameraRig,
    chamberDepth,
    colonyBiology,
    colonyForWorker,
    colonyLabor,
    colonyOrder,
    colonySurvival,
    delivered,
    demographicStateFor,
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
    sectorTarget,
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
  };
}


const renderGameStateText = () => JSON.stringify(buildObservationReport(readObservationState()));
window.render_game_to_text = () => profiler.measure('snapshot', () => {
  if (!debugEnabled) return renderGameStateText();
  const report = JSON.parse(renderGameStateText());
  report.diagnostics = collectDebugState();
  return JSON.stringify(report);
});
window.getProfilerSnapshot = () => profiler.snapshot();
window.exportDeterministicFixture = () => profiler.measure('snapshot', () => createDeterministicFixture(
  JSON.parse(renderGameStateText()),
  {
    scenario: requestedFixtureId || 'custom',
    query: canonicalScenarioQuery(urlParams),
    targetSimulationSeconds: Number(urlParams.get('horizon')) || Number(simTime.toFixed(1)),
  },
));
window.compareDeterministicFixture = (expected, options) => compareDeterministicFixtures(
  expected,
  window.exportDeterministicFixture(),
  options,
);

const requestedCalibrationHorizon = clamp(Number(urlParams.get('horizon')) || 0, 0, ECOLOGICAL_YEAR_SECONDS * 4);
if (requestedCalibrationHorizon > 0) {
  const horizonSteps = Math.round(requestedCalibrationHorizon / FIXED_DT);
  for (let step = 0; step < horizonSteps; step++) runFixedStep();
}

if (requestedFixtureId) {
  window.fixtureActual = window.exportDeterministicFixture();
  const fixturePath = FIXTURE_PATHS[requestedFixtureId];
  if (fixturePath && urlParams.get('fixtureCompare') !== '0') {
    compareWithSavedFixture(fixturePath, window.fixtureActual)
      .then((comparison) => { window.fixtureComparison = comparison; })
      .catch((error) => {
        window.fixtureComparison = {
          ok: false,
          differenceCount: 1,
          changedSubsystems: ['fixture'],
          differences: [{ subsystem: 'fixture', path: fixturePath, expected: 'loadable fixture', actual: error.message }],
        };
      });
  }
}

if (fixtureExportEnabled) {
  window.render_game_to_text = () => JSON.stringify({
    fixture: window.fixtureActual || window.exportDeterministicFixture(),
    comparison: window.fixtureComparison || null,
  });
}

renderAnts();
updateCamera(0);
render();
refreshDebugOverlay();
}

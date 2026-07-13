import * as THREE from './vendor/three.module.js';

// ---------- constants and deterministic helpers ----------
const canvas = document.querySelector('#scene');
const antNote = document.querySelector('#ant-note');
const antNoteTitle = document.querySelector('#ant-note-title');
const antNoteTask = document.querySelector('#ant-note-task');
const antNoteFacts = document.querySelector('#ant-note-facts');
const speedIndicator = document.querySelector('#speed-indicator');
const WORLD_W = 34;
const WORLD_D = 26;
const HALF_W = WORLD_W / 2;
const HALF_D = WORLD_D / 2;
const NEST = new THREE.Vector2(-5.4, -1.3);
const RIVAL_NEST = new THREE.Vector2(9.1, -5.7);
const HOME_COLONY_ID = 'amber';
const RIVAL_COLONY_ID = 'slate';
const SPECIES_PROFILE = 'harvester-ant reference population';
const FIXED_DT = 1 / 30;
const MAX_ANTS = 260;
const MAX_RIVALS = 120;
const MAX_ACTIVE_WORKERS = 420;
const PHER_W = 92;
const PHER_H = 70;
let selectedAnt = null;
let followingSelected = false;

// Phase 7A foundation: every present and future nest is registered through the
// same population interface. Legacy colony-specific mechanics are exposed by
// getters while later subphases migrate them behind the shared record.
const colonyRegistry = new Map();
const colonyOrder = [];

function registerColony(record) {
  if (!record?.id || colonyRegistry.has(record.id)) throw new Error(`Invalid or duplicate colony id: ${record?.id}`);
  colonyRegistry.set(record.id, record);
  colonyOrder.push(record.id);
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

function totalActiveWorkers() {
  let total = 0;
  for (const colony of colonyRegistry.values()) total += colony.workers.length;
  return total;
}

function workerDisplayId(worker) {
  const colony = colonyForWorker(worker);
  return `${colony?.workerPrefix || 'W'}${String(worker?.id ?? 0).padStart(3, '0')}`;
}

function mulberry32(seed) {
  return () => {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0xA17C010);
const rand = (min = 0, max = 1) => min + (max - min) * random();
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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc6b584);
scene.fog = new THREE.FogExp2(0xc6b584, 0.018);
const surfaceGroup = new THREE.Group();
surfaceGroup.name = 'surface-world';
scene.add(surfaceGroup);
const undergroundGroup = new THREE.Group();
undergroundGroup.name = 'living-nest-scan';
undergroundGroup.visible = false;
scene.add(undergroundGroup);
const viewState = {
  undergroundBlend: 0,
  surfaceBackground: new THREE.Color(0xc6b584),
  undergroundBackground: new THREE.Color(0x080b13),
  surfaceSun: 4,
  surfaceHemi: 2.25,
};

const camera = new THREE.PerspectiveCamera(39, window.innerWidth / window.innerHeight, 0.1, 90);
const cameraRig = {
  target: new THREE.Vector3(-0.5, 0, 0.5),
  yaw: 0.54,
  pitch: 0.78,
  desiredPitch: 0.78,
  distance: 24,
  desiredDistance: 24,
  focusY: 0,
  idle: 0,
  focusedColonyId: HOME_COLONY_ID,
};
const heldKeys = new Set();

const hemi = new THREE.HemisphereLight(0xfff1c4, 0x475033, 2.25);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffd58e, 4.0);
sun.position.set(-9, 18, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -20;
sun.shadow.camera.right = 20;
sun.shadow.camera.top = 17;
sun.shadow.camera.bottom = -17;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 45;
sun.shadow.bias = -0.0003;
scene.add(sun);

// ---------- procedural soil and terrain ----------
function makeSoilTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const texRand = mulberry32(0x5011);
  for (let i = 0; i < size * size; i++) {
    const grain = texRand();
    const pebble = texRand() > 0.986 ? texRand() * 42 : 0;
    const base = 112 + grain * 30 + pebble;
    data[i * 4] = base * 1.10;
    data[i * 4 + 1] = base * 0.91;
    data[i * 4 + 2] = base * 0.61;
    data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const gradient = ctx.createRadialGradient(270, 230, 15, 270, 230, 310);
  gradient.addColorStop(0, 'rgba(255,238,180,.11)');
  gradient.addColorStop(1, 'rgba(50,38,19,.12)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(c);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5.5, 4.2);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

const terrainGeometry = new THREE.PlaneGeometry(WORLD_W, WORLD_D, 112, 86);
const terrainPositions = terrainGeometry.attributes.position;
const terrainColors = [];
for (let i = 0; i < terrainPositions.count; i++) {
  const x = terrainPositions.getX(i);
  // PlaneGeometry's local +Y becomes world -Z after the -90° X rotation below.
  // Generate heights in world coordinates so agents and the rendered surface
  // sample the exact same mound, hollows, and ripples.
  const z = -terrainPositions.getY(i);
  const h = groundHeight(x, z);
  terrainPositions.setZ(i, h);
  const mossiness = clamp((Math.sin(x * 0.32 - z * 0.23) + 0.5) * 0.11, 0, 0.18);
  const disturbedSoil = Math.exp(-((x - NEST.x) ** 2 + (z - NEST.y) ** 2) / 4.5);
  terrainColors.push(
    0.67 - mossiness * 0.7 - disturbedSoil * 0.045,
    0.54 + mossiness * 0.23 - disturbedSoil * 0.095,
    0.34 - mossiness * 0.25 - disturbedSoil * 0.065,
  );
}
terrainGeometry.setAttribute('color', new THREE.Float32BufferAttribute(terrainColors, 3));
terrainGeometry.computeVertexNormals();
terrainGeometry.rotateX(-Math.PI / 2);

const terrain = new THREE.Mesh(terrainGeometry, new THREE.MeshStandardMaterial({
  map: makeSoilTexture(),
  vertexColors: true,
  roughness: 0.96,
  metalness: 0,
}));
terrain.receiveShadow = true;
surfaceGroup.add(terrain);

// ---------- generated sprite atlases ----------
const textureLoader = new THREE.TextureLoader();
const antAtlas = textureLoader.load('./assets/sprites/ant-atlas.png');
antAtlas.colorSpace = THREE.SRGBColorSpace;
antAtlas.anisotropy = renderer.capabilities.getMaxAnisotropy();
const propAtlas = textureLoader.load('./assets/sprites/props-atlas.png');
propAtlas.colorSpace = THREE.SRGBColorSpace;
propAtlas.anisotropy = renderer.capabilities.getMaxAnisotropy();

function atlasTexture(source, col, row, cols, rows) {
  const texture = source.clone();
  texture.repeat.set(1 / cols, 1 / rows);
  texture.offset.set(col / cols, 1 - (row + 1) / rows);
  texture.needsUpdate = true;
  return texture;
}

const antMaterials = Array.from({ length: 4 }, (_, frame) => new THREE.MeshStandardMaterial({
  map: atlasTexture(antAtlas, frame % 2, Math.floor(frame / 2), 2, 2),
  transparent: true,
  alphaTest: 0.075,
  depthWrite: true,
  roughness: 0.82,
  metalness: 0,
  side: THREE.DoubleSide,
}));

const PROP_CELLS = {
  seed: [0, 0], crumb: [1, 0], berry: [2, 0], leaf: [0, 1], beetle: [1, 1], moss: [2, 1],
};
const propMaterials = {};
for (const [name, [col, row]] of Object.entries(PROP_CELLS)) {
  propMaterials[name] = new THREE.MeshStandardMaterial({
    map: atlasTexture(propAtlas, col, row, 3, 2),
    transparent: true,
    alphaTest: 0.06,
    depthWrite: true,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
}

const flatPlaneCache = new Map();
function flatPlane(size = 1) {
  if (!flatPlaneCache.has(size)) {
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    flatPlaneCache.set(size, geo);
  }
  return flatPlaneCache.get(size);
}

function makeProp(kind, x, z, size, rotation = 0) {
  const mesh = new THREE.Mesh(flatPlane(size), propMaterials[kind]);
  alignToGround(mesh, x, z, rotation, 0.072);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.userData.kind = kind;
  surfaceGroup.add(mesh);
  return mesh;
}

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
}

const foods = [];
const signals = [];
let delivered = 0;
let storedFood = 118;
const FOOD_NUTRITION = { crumb: 0.72, seed: 1.0, berry: 1.28, beetle: 1.55 };
const SEASONS = [
  { name: 'spring', food: 1.18, rain: 1.35, tint: 0xdce8bd },
  { name: 'summer', food: 1.0, rain: 0.72, tint: 0xfff5dc },
  { name: 'autumn', food: 0.72, rain: 0.92, tint: 0xd9b77d },
  { name: 'winter', food: 0.36, rain: 1.12, tint: 0xbccad0 },
];
const environment = { seasonIndex: 0, seasonProgress: 0, season: SEASONS[0], pressure: 'stable' };
const urlParams = new URLSearchParams(window.location.search);
const requestedSeasonOffset = clamp(Number(urlParams.get('season')) || 0, 0, SEASONS.length - 1);
const predatorsDisabled = urlParams.get('predator') === '0';
const manualFlightOnly = urlParams.get('flight') === 'manual';
const forceFlightWhenReady = urlParams.get('flight') === 'force';
const foundingStressTest = urlParams.get('founding') === 'stress';
const youngColonyStressTest = urlParams.get('young') === 'collapse';
const clearWeatherTest = urlParams.get('weather') === 'clear';
const requestedNestFocus = urlParams.get('nest');
cameraRig.focusedColonyId = requestedNestFocus === 'rival' || requestedNestFocus === RIVAL_COLONY_ID
  ? RIVAL_COLONY_ID
  : HOME_COLONY_ID;

function addFood(x, z, kind = 'crumb', amount = 52, size = 1.5) {
  x = clamp(x, -HALF_W + 0.8, HALF_W - 0.8);
  z = clamp(z, -HALF_D + 0.8, HALF_D - 0.8);
  const mesh = makeProp(kind, x, z, size, rand(0, Math.PI * 2));
  const food = { x, z, kind, amount, initial: amount, size, mesh, nutrition: FOOD_NUTRITION[kind] || 0.8 };
  foods.push(food);
  createSignal(x, z, kind === 'beetle' ? 0xb77c4c : 0xf4d278);
  return food;
}

addFood(7.4, -4.8, 'seed', 62, 1.55);
addFood(4.7, 5.4, 'crumb', 78, 1.75);
addFood(-1.2, 7.6, 'beetle', 115, 2.05);
addFood(11.7, 5.4, 'berry', 90, 1.8);

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
const antGeometry = new THREE.PlaneGeometry(0.94, 0.94);
antGeometry.rotateX(-Math.PI / 2);
const antMeshes = antMaterials.map((material) => {
  const mesh = new THREE.InstancedMesh(antGeometry, material, MAX_ANTS);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  surfaceGroup.add(mesh);
  return mesh;
});

const rivalMaterials = antMaterials.map((material) => {
  const rivalMaterial = material.clone();
  rivalMaterial.color.setHex(0x748fa6);
  return rivalMaterial;
});
const rivalMeshes = rivalMaterials.map((material) => {
  const mesh = new THREE.InstancedMesh(antGeometry, material, MAX_RIVALS);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  surfaceGroup.add(mesh);
  return mesh;
});

const shadowGeometry = new THREE.CircleGeometry(0.25, 16);
shadowGeometry.rotateX(-Math.PI / 2);
const antShadows = new THREE.InstancedMesh(
  shadowGeometry,
  new THREE.MeshBasicMaterial({ color: 0x1c160e, transparent: true, opacity: 0.19, depthWrite: false }),
  MAX_ANTS,
);
antShadows.frustumCulled = false;
surfaceGroup.add(antShadows);

const carryGeometry = new THREE.IcosahedronGeometry(0.105, 0);
const carryMesh = new THREE.InstancedMesh(
  carryGeometry,
  new THREE.MeshStandardMaterial({ color: 0xe3bd66, roughness: 0.9 }),
  MAX_ANTS,
);
carryMesh.frustumCulled = false;
carryMesh.castShadow = true;
surfaceGroup.add(carryMesh);

const rivalCarryMesh = new THREE.InstancedMesh(
  carryGeometry,
  new THREE.MeshStandardMaterial({ color: 0xb3c985, roughness: 0.9 }),
  MAX_RIVALS,
);
rivalCarryMesh.frustumCulled = false;
rivalCarryMesh.castShadow = true;
surfaceGroup.add(rivalCarryMesh);

const soilCarryMesh = new THREE.InstancedMesh(
  new THREE.DodecahedronGeometry(0.155, 0),
  new THREE.MeshStandardMaterial({ color: 0x9a5a32, roughness: 1, flatShading: true }),
  MAX_ANTS,
);
soilCarryMesh.frustumCulled = false;
soilCarryMesh.castShadow = true;
surfaceGroup.add(soilCarryMesh);

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

const antInstanceLookup = [[], [], [], []];
const rivalInstanceLookup = [[], [], [], []];
const selectedSurfaceRing = new THREE.Mesh(
  new THREE.RingGeometry(0.36, 0.43, 36),
  new THREE.MeshBasicMaterial({ color: 0xffd483, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
);
selectedSurfaceRing.rotation.x = -Math.PI / 2;
selectedSurfaceRing.visible = false;
selectedSurfaceRing.renderOrder = 12;
surfaceGroup.add(selectedSurfaceRing);

const selectedNestHalo = new THREE.Mesh(
  new THREE.SphereGeometry(0.43, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0xffd483, wireframe: true, transparent: true, opacity: 0.68, depthTest: false, fog: false }),
);
selectedNestHalo.visible = false;
selectedNestHalo.renderOrder = 12;
undergroundGroup.add(selectedNestHalo);

const selectedPathGeometry = new THREE.BufferGeometry();
const selectedPath = new THREE.Line(
  selectedPathGeometry,
  new THREE.LineBasicMaterial({ color: 0xf2c777, transparent: true, opacity: 0.48, depthTest: false, fog: false }),
);
selectedPath.visible = false;
selectedPath.renderOrder = 11;
scene.add(selectedPath);
let selectedPathPoints = [];
let selectedPathClock = 0;

// ---------- living underground nest scan ----------
const homeNestScanGroup = new THREE.Group();
homeNestScanGroup.name = 'amber-nest-scan';
undergroundGroup.add(homeNestScanGroup);
const tunnelSegments = [];
const tunnelFillMaterial = new THREE.MeshBasicMaterial({
  color: 0x8f512f,
  transparent: true,
  opacity: 0.07,
  side: THREE.DoubleSide,
  depthWrite: false,
  fog: false,
});
const tunnelWireMaterial = new THREE.MeshBasicMaterial({
  color: 0xd38b45,
  wireframe: true,
  transparent: true,
  opacity: 0.24,
  side: THREE.DoubleSide,
  depthWrite: false,
  fog: false,
});
const chamberFillMaterial = new THREE.MeshBasicMaterial({
  color: 0x75402a,
  transparent: true,
  opacity: 0.08,
  side: THREE.DoubleSide,
  depthWrite: false,
  fog: false,
});
const chamberWireMaterial = new THREE.MeshBasicMaterial({
  color: 0xe0a45f,
  wireframe: true,
  transparent: true,
  opacity: 0.3,
  side: THREE.DoubleSide,
  depthWrite: false,
  fog: false,
});

function addTunnelSegment(name, points, radius, start, duration, chamberScale) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.38);
  const geometry = new THREE.TubeGeometry(curve, 78, radius, 10, false);
  geometry.setDrawRange(0, 0);
  const tunnel = new THREE.Group();
  tunnel.name = name;
  const fill = new THREE.Mesh(geometry, tunnelFillMaterial);
  const wire = new THREE.Mesh(geometry, tunnelWireMaterial);
  fill.renderOrder = 2;
  wire.renderOrder = 3;
  tunnel.add(fill, wire);
  homeNestScanGroup.add(tunnel);

  const chamber = new THREE.Group();
  const chamberGeometry = new THREE.SphereGeometry(1, 22, 14);
  chamber.add(
    new THREE.Mesh(chamberGeometry, chamberFillMaterial),
    new THREE.Mesh(chamberGeometry, chamberWireMaterial),
  );
  chamber.position.copy(points[points.length - 1]);
  chamber.scale.setScalar(0.001);
  chamber.visible = false;
  homeNestScanGroup.add(chamber);

  const tip = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius * 0.72, 1),
    new THREE.MeshBasicMaterial({ color: 0x9b5e36, transparent: true, opacity: 0.58, fog: false }),
  );
  tip.visible = false;
  homeNestScanGroup.add(tip);

  const face = new THREE.Group();
  const faceDisk = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.94, 15),
    new THREE.MeshBasicMaterial({ color: 0x351c15, transparent: true, opacity: 0.92, side: THREE.DoubleSide, fog: false }),
  );
  const faceRim = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.84, radius * 1.12, 15),
    new THREE.MeshBasicMaterial({ color: 0xb66d3b, transparent: true, opacity: 0.7, side: THREE.DoubleSide, fog: false }),
  );
  face.add(faceDisk, faceRim);
  face.visible = false;
  face.renderOrder = 5;
  homeNestScanGroup.add(face);

  const segment = {
    name, curve, geometry, tunnel, chamber, tip, face, radius, start, duration,
    chamberScale: new THREE.Vector3(...chamberScale),
    progress: 0,
    work: 0,
    workRequired: Math.max(30, curve.getLength() * 20),
    activeDiggers: 0,
    available: false,
  };
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
], 0.29, -50, 30, [1.8, 0.55, 1.12]);
addTunnelSegment('eastern stores', [
  V(-5.18, -2.5, -1.62), V(-3.45, -3.0, -0.35), V(-1.15, -3.75, 1.55), V(0.45, -4.25, 0.65),
], 0.31, -50, 32, [1.65, 0.52, 1.18]);
addTunnelSegment('descending gallery', [
  V(-5.55, -4.12, -0.8), V(-4.85, -5.2, -0.05), V(-5.2, -6.45, 1.3), V(-4.4, -7.5, 0.7),
], 0.34, -45, 34, [1.42, 0.58, 1.25]);
addTunnelSegment('western deep chamber', [
  V(-5.15, -6.4, 1.25), V(-7.0, -6.85, 2.45), V(-8.8, -7.35, 4.25), V(-10.4, -7.75, 3.5),
], 0.28, 12, 48, [1.72, 0.56, 1.08]);
addTunnelSegment('southeast gallery', [
  V(-4.42, -7.48, 0.7), V(-2.05, -7.9, -1.25), V(0.65, -8.15, -3.85), V(2.45, -8.5, -3.25),
], 0.3, 28, 54, [1.7, 0.5, 1.2]);
addTunnelSegment('lower shaft', [
  V(-4.42, -7.48, 0.7), V(-4.9, -8.75, 0.15), V(-3.8, -10.15, 1.2), V(-4.35, -11.6, 0.35),
], 0.33, 48, 48, [1.48, 0.6, 1.16]);
addTunnelSegment('lower western fork', [
  V(-4.32, -11.55, 0.35), V(-6.25, -11.05, -1.55), V(-8.1, -11.4, -3.5), V(-9.5, -11.75, -4.15),
], 0.27, 76, 52, [1.6, 0.52, 1.08]);
addTunnelSegment('lower eastern fork', [
  V(-4.32, -11.55, 0.35), V(-2.5, -11.1, 2.0), V(-0.6, -11.45, 4.15), V(1.25, -11.85, 5.0),
], 0.27, 96, 58, [1.55, 0.5, 1.2]);

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
  return { segmentIndex, from, to, length: Math.max(0.1, segment.curve.getLength() * Math.abs(to - from)) };
}

const nurseryJoin = closestCurveT(tunnelSegments[0].curve, tunnelSegments[1].curve.getPointAt(0));
const storesJoin = closestCurveT(tunnelSegments[0].curve, tunnelSegments[2].curve.getPointAt(0));
const VESTIBULE_T = Math.min(0.22, storesJoin * 0.58);
const NEST_ROUTES = {
  vestibule: { label: 'entrance vestibule', legs: [nestLeg(0, 0, VESTIBULE_T)] },
  transferStores: { label: 'vestibule-to-stores transfer route', legs: [nestLeg(0, VESTIBULE_T, storesJoin), nestLeg(2)] },
  nursery: { label: 'nursery chamber', legs: [nestLeg(0, 0, nurseryJoin), nestLeg(1)] },
  stores: { label: 'food stores', legs: [nestLeg(0, 0, storesJoin), nestLeg(2)] },
  rest: { label: 'deep resting chamber', legs: [nestLeg(0), nestLeg(3)] },
};

const vestibuleCenter = tunnelSegments[0].curve.getPointAt(VESTIBULE_T).clone();
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

const descendingJoinWestern = closestCurveT(tunnelSegments[3].curve, tunnelSegments[4].curve.getPointAt(0));
const CONSTRUCTION_DEPENDENCIES = {
  4: [],
  5: [],
  6: [4, 5],
  7: [6],
  8: [6],
};
for (let i = 0; i < tunnelSegments.length; i++) {
  const established = i <= 3;
  tunnelSegments[i].progress = established ? 1 : (i === 4 ? 0.045 : i === 5 ? 0.025 : 0);
  tunnelSegments[i].work = tunnelSegments[i].progress * tunnelSegments[i].workRequired;
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

function createWingTexture() {
  const wingCanvas = document.createElement('canvas');
  wingCanvas.width = 128;
  wingCanvas.height = 64;
  const ctx = wingCanvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 64);
  ctx.fillStyle = 'rgba(235,245,239,0.72)';
  ctx.strokeStyle = 'rgba(115,142,139,0.72)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(8, 34);
  ctx.bezierCurveTo(28, 3, 102, 3, 121, 25);
  ctx.bezierCurveTo(103, 50, 34, 58, 8, 34);
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 1.2;
  for (const y of [22, 31, 40]) {
    ctx.beginPath();
    ctx.moveTo(14, 34);
    ctx.quadraticCurveTo(65, y, 112, 25);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(wingCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
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
const youngWorkerVisualPool = Array.from({ length: 96 }, (_, index) => {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: antMaterials[index % antMaterials.length].map,
    color: 0xb86c55,
    transparent: true,
    alphaTest: 0.045,
    depthWrite: false,
    depthTest: false,
    fog: true,
  }));
  sprite.visible = false;
  sprite.renderOrder = 9;
  surfaceGroup.add(sprite);
  return sprite;
});
const youngCargoVisualPool = Array.from({ length: 48 }, () => {
  const cargo = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.085, 0),
    new THREE.MeshStandardMaterial({ color: 0xd9b666, roughness: 0.9 }),
  );
  cargo.visible = false;
  cargo.renderOrder = 9;
  surfaceGroup.add(cargo);
  return cargo;
});
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

function updateRegionalReproductionVisuals(dt) {
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
    visual.queen.visible = foundation.alive && !inactiveSite;
    visual.queen.material.color.setHex(foundation.natalColonyId === RIVAL_COLONY_ID ? 0x6c8da2 : 0x974838);
    visual.queen.material.rotation = foundation.heading - Math.PI * 0.5;
    for (let j = 0; j < visual.soil.length; j++) visual.soil[j].visible = j < Math.floor(progress * visual.soil.length);
    for (let j = 0; j < visual.brood.length; j++) {
      const item = foundation.foundingBrood?.[j];
      const mesh = visual.brood[j];
      mesh.visible = Boolean(item);
      if (!item) continue;
      const scale = item.stage === 'egg' ? 0.72 : item.stage === 'larva' ? 1 : 1.12;
      mesh.scale.set(scale * (item.stage === 'egg' ? 0.72 : 1), scale, scale * 0.82);
      mesh.material.color.setHex(item.stage === 'egg' ? 0xf3e3c3 : item.stage === 'larva' ? 0xe1c28d : 0xb89166);
    }
    const chamberWorkers = foundation.nanitics?.filter((worker) => worker.insideNest && worker.alive) || [];
    for (let j = 0; j < visual.nanitics.length; j++) {
      const worker = chamberWorkers[j];
      const sprite = visual.nanitics[j];
      sprite.visible = Boolean(worker);
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
  const visibleYoungWorkers = Math.min(surfaceYoungWorkers.length, youngWorkerVisualPool.length);
  let visibleYoungCargo = 0;
  for (let i = 0; i < visibleYoungWorkers; i++) {
    const worker = surfaceYoungWorkers[i];
    const sprite = youngWorkerVisualPool[i];
    const colony = getColony(worker.colonyId);
    sprite.position.set(worker.x, groundHeight(worker.x, worker.z) + 0.14 + Math.sin(worker.phase) * 0.012, worker.z);
    const scale = worker.workerCaste === 'nanitic' ? 0.54 : 0.64;
    sprite.scale.set(scale, scale, 1);
    sprite.material.rotation = worker.heading - Math.PI * 0.5;
    sprite.material.color.setHex(colony?.foundedBy === RIVAL_COLONY_ID ? 0x7897a9 : 0xb9664f);
    sprite.visible = true;
    if (worker.carrying && visibleYoungCargo < youngCargoVisualPool.length) {
      const cargo = youngCargoVisualPool[visibleYoungCargo++];
      cargo.position.set(
        worker.x + Math.cos(worker.heading) * 0.18,
        groundHeight(worker.x, worker.z) + 0.18,
        worker.z + Math.sin(worker.heading) * 0.18,
      );
      cargo.material.color.setHex(worker.carryingKind === 'berry' ? 0xa86453 : worker.carryingKind === 'beetle' ? 0x826346 : 0xd9b666);
      cargo.visible = true;
    }
  }
  for (let i = visibleYoungWorkers; i < youngWorkerVisualPool.length; i++) youngWorkerVisualPool[i].visible = false;
  for (let i = visibleYoungCargo; i < youngCargoVisualPool.length; i++) youngCargoVisualPool[i].visible = false;

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

const rivalNestScanGroup = new THREE.Group();
rivalNestScanGroup.name = 'rival-nest-scan';
undergroundGroup.add(rivalNestScanGroup);
const rivalTunnelMaterial = new THREE.MeshBasicMaterial({ color: 0x55738c, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false, fog: false });
const rivalWireMaterial = new THREE.MeshBasicMaterial({ color: 0x82a9bd, wireframe: true, transparent: true, opacity: 0.36, side: THREE.DoubleSide, depthWrite: false, fog: false });
const rivalNestCurves = [];

function addRivalNestTunnel(points, radius, chamberScale) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.4);
  rivalNestCurves.push(curve);
  const geometry = new THREE.TubeGeometry(curve, 64, radius, 9, false);
  rivalNestScanGroup.add(new THREE.Mesh(geometry, rivalTunnelMaterial), new THREE.Mesh(geometry, rivalWireMaterial));
  const chamberGeometry = new THREE.SphereGeometry(1, 18, 12);
  const chamber = new THREE.Group();
  chamber.add(new THREE.Mesh(chamberGeometry, rivalTunnelMaterial), new THREE.Mesh(chamberGeometry, rivalWireMaterial));
  chamber.position.copy(points[points.length - 1]);
  chamber.scale.set(...chamberScale);
  rivalNestScanGroup.add(chamber);
  return curve;
}

const rivalEntranceY = groundHeight(RIVAL_NEST.x, RIVAL_NEST.y) + 0.04;
addRivalNestTunnel([
  V(RIVAL_NEST.x, rivalEntranceY, RIVAL_NEST.y), V(9.0, -1.2, -5.5), V(8.6, -2.6, -5.1), V(8.4, -3.6, -4.9),
], 0.34, [1.42, 0.56, 1.05]);
const rivalNurseryCurve = addRivalNestTunnel([
  V(8.4, -3.6, -4.9), V(9.4, -4.0, -5.8), V(10.4, -4.5, -6.6), V(11.25, -4.85, -7.15),
], 0.29, [1.62, 0.52, 1.12]);
addRivalNestTunnel([
  V(8.4, -3.6, -4.9), V(7.5, -3.9, -4.5), V(6.6, -4.15, -4.0), V(5.7, -4.4, -3.75),
], 0.27, [1.48, 0.48, 1.04]);
addRivalNestTunnel([
  V(8.4, -3.6, -4.9), V(8.1, -5.0, -3.8), V(8.65, -6.2, -2.5), V(9.0, -7.15, -1.45),
], 0.31, [1.5, 0.55, 1.1]);

const rivalNurseryCenter = rivalNurseryCurve.getPointAt(1).clone();
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
  sprite.userData.workerId = null;
  rivalNestScanGroup.add(sprite);
  return sprite;
});
const rivalAlateVisualPool = createAlateVisualPool(rivalNestScanGroup, 0x718fa6);
const rivalNestLight = new THREE.PointLight(0x6f9eb8, 16, 11, 2);
rivalNestLight.position.set(8.5, -4.1, -5.0);
rivalNestScanGroup.add(rivalNestLight);

function updateRivalUndergroundVisuals() {
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
    sprite.userData.workerId = rival.id;
    sprite.visible = true;
  }
  for (let i = visibleTransfers; i < rivalTransferPool.length; i++) rivalTransferPool[i].visible = false;
  updateAlateVisualPool(rivalAlateVisualPool, rivalReproduction.alates, rivalNurseryCenter, { gyne: 0x698ca7, male: 0x899ba3 });
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

const undergroundSpritePool = Array.from({ length: MAX_ANTS }, (_, i) => {
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

const nurseryCenter = tunnelSegments[1].curve.getPointAt(1).clone();
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

function updateUnderground() {
  homeNestScanGroup.visible = cameraRig.focusedColonyId === HOME_COLONY_ID;
  rivalNestScanGroup.visible = cameraRig.focusedColonyId === RIVAL_COLONY_ID;
  const tipPosition = new THREE.Vector3();
  const active = [];
  for (let segmentIndex = 0; segmentIndex < tunnelSegments.length; segmentIndex++) {
    const segment = tunnelSegments[segmentIndex];
    const progress = segment.progress;
    const indexCount = segment.geometry.index.count;
    const revealed = Math.floor((indexCount * progress) / 6) * 6;
    segment.geometry.setDrawRange(0, revealed);

    const chamberProgress = clamp((progress - 0.78) / 0.22, 0, 1);
    const eased = chamberProgress * chamberProgress * (3 - chamberProgress * 2);
    segment.chamber.visible = chamberProgress > 0.001;
    segment.chamber.scale.copy(segment.chamberScale).multiplyScalar(Math.max(0.001, eased));

    segment.tip.visible = segmentIndex >= 4 && segment.available && progress < 0.995;
    segment.face.visible = segment.tip.visible;
    if (segment.tip.visible) {
      const frontT = Math.max(0.012, progress);
      segment.curve.getPointAt(frontT, segment.tip.position);
      segment.face.position.copy(segment.tip.position);
      const frontTangent = segment.curve.getTangentAt(frontT).normalize();
      segment.face.quaternion.setFromUnitVectors(Z_AXIS, frontTangent);
      segment.face.rotateZ(segmentIndex * 0.73);
      const pulse = segment.activeDiggers > 0
        ? 0.78 + Math.sin(simTime * 5.2 + segment.start) * 0.22
        : 0.62 + Math.sin(simTime * 1.4 + segment.start) * 0.06;
      segment.tip.scale.setScalar(pulse * 0.34);
      segment.tip.position.addScaledVector(frontTangent, 0.018);
      if (segment.activeDiggers > 0) active.push(segment);
    }
  }

  digMotes.visible = active.length > 0;
  if (active.length > 0) {
    const positions = digMoteGeometry.attributes.position.array;
    for (let i = 0; i < digMoteCount; i++) {
      const segment = active[i % active.length];
      segment.curve.getPointAt(segment.progress, tipPosition);
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
  for (const ant of ants) {
    if (!ant.insideNest || !ant.nestPosition || visibleNestAnts >= undergroundSpritePool.length) continue;
    const sprite = undergroundSpritePool[visibleNestAnts++];
    sprite.position.copy(ant.nestPosition);
    sprite.position.y += Math.sin(ant.phase * 0.5) * 0.025;
    const size = ant.size * (ant === selectedAnt ? 0.48 : 0.32);
    sprite.scale.set(size, size, 1);
    sprite.material.rotation = -ant.nestHeading + Math.PI * 0.5;
    sprite.material.color.setHex(ant === selectedAnt ? 0xffc66e : 0x6f2d24);
    sprite.userData.antId = ant.id;
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
  updateBiologicalVisuals();
  updateEntranceVisuals();
  updateRivalUndergroundVisuals();
}

const ants = [];
let nextAntId = 1;
const brood = [];
let nextBroodId = 1;
let queenLayClock = 5;
let queenEggsLaid = 0;
let workersEclosed = 0;
const BROOD_STAGE_SECONDS = { egg: 34, larva: 52, pupa: 44 };
const colonyBiology = { activeNurses: 0, requiredNurses: 0, starvedLarvae: 0 };
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
for (let i = 0; i < 5; i++) entranceBiology.cache.push({ kind: 'seed', nutrition: 1, value: 2.5 });
const GENE_KEYS = ['speed', 'size', 'diseaseResistance', 'aggression', 'foraging'];
const homeQueenGenome = { speed: 1.02, size: 0.98, diseaseResistance: 1.1, aggression: 0.9, foraging: 1.0 };
const rivalQueenGenome = { speed: 0.96, size: 1.05, diseaseResistance: 0.9, aggression: 1.18, foraging: 1.12 };

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

const homeReproduction = createQueenReproduction('amber', homeQueenGenome, 4);
const rivalReproduction = createQueenReproduction('slate', rivalQueenGenome, 5);

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

function reproductiveCost(destiny) {
  return destiny === 'gyne' ? 5.4 : destiny === 'male' ? 2.1 : 0.7;
}

function broodStageDuration(item) {
  const casteMultiplier = item.destiny === 'gyne' ? 1.42 : item.destiny === 'male' ? 1.08 : 1;
  return BROOD_STAGE_SECONDS[item.stage] * casteMultiplier;
}

function updateAlateCohort(reproduction, dt) {
  for (const alate of reproduction.alates) {
    alate.ageDays += dt / 720;
    alate.state = environment.season.name === 'winter'
      ? 'overwintering in the alate chamber'
      : environment.season.name === 'summer' && weather.rain < 0.22
        ? 'waiting for a humid flight window'
        : 'waiting in the alate chamber';
  }
}

function averageGenome(population) {
  const result = Object.fromEntries(GENE_KEYS.map((key) => [key, 0]));
  if (population.length === 0) return result;
  for (const individual of population) for (const key of GENE_KEYS) result[key] += individual.genome?.[key] || 1;
  for (const key of GENE_KEYS) result[key] = Number((result[key] / population.length).toFixed(3));
  return result;
}

function workerMaturity(ageDays) {
  if (ageDays < 5) return 'callow';
  if (ageDays < 16) return 'young';
  if (ageDays < 32) return 'mature';
  return 'veteran';
}

function addBrood(stage = 'egg', stageAge = 0, genome = null, generation = 1, options = {}) {
  if (brood.length >= broodPool.length || ants.length + brood.length >= MAX_ANTS + 40) return null;
  const destiny = options.destiny || 'worker';
  const inherited = genome ? {
    sex: destiny === 'male' ? 'male' : 'female',
    destiny,
    genome,
    parentage: options.parentage || { damId: 'founding-population', sireId: null, sireLineageId: null, ploidy: destiny === 'male' ? 'haploid' : 'diploid' },
  } : createOffspringInheritance('queen-amber-001', homeQueenGenome, homeReproduction, destiny);
  const item = {
    id: nextBroodId++, stage, stageAge, care: rand(0.82, 1.08), generation,
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

function flightLightLevel() {
  return (Math.sin(simTime * 0.027) + 1) * 0.5;
}

function nuptialFlightSuitability() {
  const seasonal = environment.season.name === 'spring' || environment.season.name === 'summer';
  if (!seasonal) return 0;
  const calm = 1 - clamp(weather.rain * 3.4, 0, 1);
  const humidity = clamp(weather.postRainHumidity || 0, 0, 1);
  const light = clamp((flightLightLevel() - 0.22) / 0.58, 0, 1);
  return calm * humidity * light;
}

function matureFlightAlates(reproduction, destiny) {
  return reproduction.alates.filter((alate) => alate.destiny === destiny && alate.ageDays >= 0.015);
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
    if (alate.ageDays < 0.015) continue;
    reproduction.alates.splice(i, 1);
    regionalMating.flyingAlates.push(createFlyingAlate(alate, nest, reproduction));
    if (alate.destiny === 'male') { reproduction.malesLaunched++; launchedMales++; }
    else { reproduction.gynesLaunched++; launchedGynes++; }
  }
  return { colonyId, males: launchedMales, gynes: launchedGynes };
}

function availableMatureGynes() {
  return matureFlightAlates(homeReproduction, 'gyne').length + matureFlightAlates(rivalReproduction, 'gyne').length;
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
  regionalMating.swarmCenter.set(
    (NEST.x + RIVAL_NEST.x) * 0.5 + rand(-1.2, 1.2),
    rand(3.1, 4.1),
    (NEST.y + RIVAL_NEST.y) * 0.5 + rand(-1, 1),
  );
  const amberLaunch = releaseColonyAlates(HOME_COLONY_ID, NEST, homeReproduction);
  const slateLaunch = releaseColonyAlates(RIVAL_COLONY_ID, RIVAL_NEST, rivalReproduction);
  const totalGynes = amberLaunch.gynes + slateLaunch.gynes;
  spawnRegionalMales(clamp(totalGynes * 4 + 4, 7, 22));
  createSignal(regionalMating.swarmCenter.x, regionalMating.swarmCenter.z, 0xe7e0b0);
  return true;
}

function chooseFoundingSite(natalColonyId) {
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 28; i++) {
    const x = rand(-HALF_W + 5.5, HALF_W - 5.5);
    const z = rand(-HALF_D + 5.5, HALF_D - 5.5);
    const nestClearance = Math.min(Math.hypot(x - NEST.x, z - NEST.y), Math.hypot(x - RIVAL_NEST.x, z - RIVAL_NEST.y));
    const queenClearance = regionalMating.matedQueens.reduce((min, queen) => Math.min(min, Math.hypot(x - queen.x, z - queen.z)), 20);
    const obstacleClearance = obstacles.reduce((min, obstacle) => Math.min(min, Math.hypot(x - obstacle.x, z - obstacle.z) - obstacle.r), 8);
    const natalNest = natalColonyId === RIVAL_COLONY_ID ? RIVAL_NEST : NEST;
    const dispersal = Math.hypot(x - natalNest.x, z - natalNest.y);
    const score = Math.min(nestClearance, 8) * 1.3 + Math.min(queenClearance, 6)
      + Math.min(obstacleClearance, 4) + Math.min(dispersal, 10) * 0.35;
    if (score > bestScore) { bestScore = score; best = { x, z }; }
  }
  return best || { x: rand(-12, 12), z: rand(-8, 8) };
}

function evaluateFoundingSite(x, z) {
  const normal = groundNormal(x, z);
  const slopeQuality = clamp((normal.y - 0.9) / 0.095, 0, 1);
  const nestClearance = Math.min(Math.hypot(x - NEST.x, z - NEST.y), Math.hypot(x - RIVAL_NEST.x, z - RIVAL_NEST.y));
  const nestQuality = clamp((nestClearance - 3.2) / 5.8, 0, 1);
  const obstacleClearance = obstacles.reduce((min, obstacle) => Math.min(min, Math.hypot(x - obstacle.x, z - obstacle.z) - obstacle.r), 6);
  const obstacleQuality = clamp((obstacleClearance - 0.5) / 2.8, 0, 1);
  const moisture = clamp(0.52 + weather.postRainHumidity * 0.28 - weather.rain * 0.18, 0.25, 0.86);
  return clamp(slopeQuality * 0.28 + nestQuality * 0.28 + obstacleQuality * 0.24 + moisture * 0.2, 0.18, 0.96);
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
    nextBroodId: 1,
    nextNaniticId: 1,
    layClock: rand(2.2, 3.4),
    registeredColonyId: null,
    acceptedAt: null,
    state: 'dealated and assessing a founding refuge',
  };
  queen.reproduction = createFoundressReproduction(queen);
  regionalMating.matedQueens.push(queen);
  recordLineageEvent('queen-dealated', queen, { mateCount: queen.mateCount, x: Number(queen.x.toFixed(1)), z: Number(queen.z.toFixed(1)) });
  if (gyne.reproduction) gyne.reproduction.matedGynes++;
  leaveShedWings(queen.x, queen.z);
  createSignal(queen.x, queen.z, queen.natalColonyId === RIVAL_COLONY_ID ? 0x8ab1c4 : 0xe0a06d);
}

const FOUNDING_BROOD_SECONDS = { egg: 14, larva: 22, pupa: 18 };

function failFoundation(queen, cause) {
  if (!queen.alive || queen.registeredColonyId) return;
  queen.alive = false;
  queen.foundingStage = 'failed';
  queen.foundingDeaths++;
  queen.failureCause = cause;
  queen.state = `founding failed · ${cause}`;
  queen.foundingBrood.length = 0;
  regionalMating.gynesFailed++;
  recordLineageEvent('foundation-failed', queen, { cause, stage: queen.foundingStage });
}

function addFoundingEgg(queen, resource = 'reserves') {
  const available = resource === 'colonyFood' ? queen.colonyFood : queen.reserves;
  if (queen.foundingBrood.length >= 12 || available < (resource === 'colonyFood' ? 2.4 : 18)) return null;
  const inherited = createOffspringInheritance(queen.id, queen.genome, queen.reproduction, 'worker');
  const item = {
    id: `${queen.id}-brood-${queen.nextBroodId++}`,
    stage: 'egg',
    stageAge: 0,
    sex: inherited.sex,
    destiny: 'worker',
    genome: inherited.genome,
    parentage: inherited.parentage,
    generation: queen.generation + 1,
    care: clamp(0.86 + queen.genome.size * 0.08 + rand(-0.04, 0.04), 0.86, 1.06),
  };
  queen.foundingBrood.push(item);
  queen.eggsLaid++;
  queen.reproduction.workerEggsLaid++;
  if (resource === 'colonyFood') queen.colonyFood = Math.max(0, queen.colonyFood - 1.2);
  else queen.reserves = Math.max(0, queen.reserves - 1.55);
  if (queen.eggsLaid === 1) recordLineageEvent('first-egg-laid', queen, { generation: item.generation });
  return item;
}

function createNanitic(queen, broodItem) {
  const colonyId = queen.registeredColonyId || `incipient-${queen.id}`;
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
  queen.nanitics.push(worker);
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
  const record = registerColony({
    id: colonyId,
    lineageId: queen.lineageId,
    displayName: `Foundress ${queen.id.slice(-3)} colony`,
    workerPrefix: `F${queen.id.slice(-3)}-`,
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
    maxWorkers: 60,
    workers: queen.nanitics,
    brood: queen.foundingBrood,
    reproduction: queen.reproduction,
    entrance,
    pheromoneField,
    queen,
    get storedFood() { return queen.colonyFood; },
    get foodDelivered() { return queen.foodDelivered; },
    get eggsLaid() { return queen.eggsLaid; },
    get workersEclosed() { return queen.workersEclosed; },
    get deaths() { return queen.foundingDeaths; },
  });
  queen.foundingStage = 'incipient';
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
      const ration = Math.min(available, dt * 0.032);
      if (usesExternalFood) queen.colonyFood -= ration;
      else queen.reserves -= ration;
      if (ration < dt * 0.022) development *= 0.38;
    }
    item.stageAge += dt * development;
    if (item.stageAge < FOUNDING_BROOD_SECONDS[item.stage]) continue;
    if (item.stage === 'egg') { item.stage = 'larva'; item.stageAge = 0; }
    else if (item.stage === 'larva') { item.stage = 'pupa'; item.stageAge = 0; }
    else {
      queen.foundingBrood.splice(i, 1);
      createNanitic(queen, item);
      if (!queen.registeredColonyId) registerFoundingColony(queen);
    }
  }
}

function chooseYoungColonyFood(worker) {
  let best = null;
  let bestScore = -Infinity;
  for (const food of foods) {
    if (food.amount <= 0) continue;
    const distance = Math.hypot(food.x - worker.x, food.z - worker.z);
    const score = food.nutrition * 3.2 * worker.genome.foraging + Math.log1p(food.amount) - distance * 0.2;
    if (score > bestScore) { bestScore = score; best = food; }
  }
  return best;
}

function updateYoungWorker(queen, worker, dt) {
  worker.phase += dt * 7.8;
  worker.ageDays += dt / 720;
  if (worker.insideNest) {
    worker.nestTimer -= dt;
    worker.energy = Math.min(100, worker.energy + dt * (queen.colonyFood > 0 ? 0.72 : 0.18));
    worker.state = queen.foundingBrood.length > 0 ? 'tending young-colony brood' : 'waiting in the opened founding chamber';
    const activeOutside = queen.nanitics.filter((other) => other.alive && !other.insideNest).length;
    const seasonalForaging = environment.season.name === 'winter' ? 0.38 : environment.season.name === 'autumn' ? 0.78 : 1;
    const targetOutside = clamp(Math.floor(queen.nanitics.length * 0.68 * seasonalForaging), 1, Math.max(1, queen.nanitics.length - 1));
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
  if (worker.carrying || worker.energy < 18 || weather.rain > 0.7) {
    worker.desired = Math.atan2(nestDz, nestDx);
    worker.state = worker.carrying ? 'carrying food to the incipient colony' : 'returning to the founding chamber';
    if (worker.carrying) colonyPherDeposit(worker.colonyId, worker.x, worker.z, 0.018);
    if (nestDistance < 0.5) {
      if (worker.carrying) {
        queen.colonyFood += 2.15 * worker.carryingNutrition;
        queen.foodDelivered++;
        if (!queen.firstDeliveryRecorded) {
          queen.firstDeliveryRecorded = true;
          recordLineageEvent('first-food-delivery', queen, { workerId: worker.id, kind: worker.carryingKind });
        }
        worker.carrying = false;
        worker.carryingKind = null;
        worker.carryingNutrition = 1;
        worker.trips++;
        worker.tasksCompleted++;
      }
      worker.insideNest = true;
      worker.nestTimer = rand(3.5, 7.5);
      worker.nestPosition.set(queen.x, groundHeight(queen.x, queen.z) - 0.28, queen.z);
      return;
    }
  } else {
    if (!worker.targetFood || worker.targetFood.amount <= 0 || worker.turnClock <= 0) {
      worker.targetFood = youngColonyStressTest ? null : chooseYoungColonyFood(worker);
      worker.turnClock = rand(1.2, 2.6);
    }
    if (worker.targetFood) {
      const dx = worker.targetFood.x - worker.x;
      const dz = worker.targetFood.z - worker.z;
      const distance = Math.hypot(dx, dz);
      worker.desired = Math.atan2(dz, dx) + Math.sin(worker.phase * 0.13) * 0.09;
      worker.state = 'foraging independently for the young colony';
      if (distance < 0.42 && worker.targetFood.amount > 0) {
        worker.carrying = true;
        worker.carryingKind = worker.targetFood.kind;
        worker.carryingNutrition = worker.targetFood.nutrition;
        worker.targetFood.amount -= 1;
        worker.targetFood.mesh.scale.setScalar(Math.max(0.24, Math.sqrt(worker.targetFood.amount / worker.targetFood.initial)));
        if (worker.targetFood.amount <= 0) worker.targetFood.mesh.visible = false;
      }
    } else {
      if (worker.turnClock <= 0) worker.desired += rand(-0.9, 0.9);
      if (nestDistance > 7.5) worker.desired = Math.atan2(nestDz, nestDx);
      worker.state = 'searching the local sector for food';
    }
  }

  worker.heading += clamp(wrapAngle(worker.desired - worker.heading), -dt * 3.6, dt * 3.6);
  const velocity = worker.speed * (1 - weather.rain * 0.24) * (worker.carrying ? 1.04 : 1);
  worker.x = clamp(worker.x + Math.cos(worker.heading) * velocity * dt, -HALF_W + 0.35, HALF_W - 0.35);
  worker.z = clamp(worker.z + Math.sin(worker.heading) * velocity * dt, -HALF_D + 0.35, HALF_D - 0.35);
  worker.distanceTraveled += velocity * dt;

  if (youngColonyStressTest) worker.health -= dt * 1.35;
  else if (worker.energy <= 0 && queen.colonyFood <= 0) worker.health -= dt * 0.07;
}

function markYoungWorkerDead(queen, worker, cause) {
  if (!worker.alive) return;
  worker.alive = false;
  queen.workerDeaths++;
  recordLineageEvent('young-worker-died', queen, { workerId: worker.id, cause, caste: worker.workerCaste });
}

function collapseYoungColony(queen, cause) {
  if (queen.foundingStage === 'collapsed') return;
  queen.alive = false;
  queen.queenHealth = 0;
  queen.collapseCause = cause;
  queen.foundingStage = 'collapsed';
  queen.state = `young colony collapsed · ${cause}`;
  queen.foundingBrood.length = 0;
  for (const worker of queen.nanitics) markYoungWorkerDead(queen, worker, 'colony collapse');
  queen.nanitics.length = 0;
  const colony = getColony(queen.registeredColonyId);
  if (colony) colony.status = 'extinct';
  recordLineageEvent('colony-collapsed', queen, { cause, workersEclosed: queen.workersEclosed, foodDelivered: queen.foodDelivered });
}

function updateYoungColony(queen, dt) {
  const colony = getColony(queen.registeredColonyId);
  queen.colonyFood = Math.max(0, queen.colonyFood - dt * (0.004 + queen.nanitics.length * 0.0014));
  for (const worker of queen.nanitics) updateYoungWorker(queen, worker, dt);
  for (let i = queen.nanitics.length - 1; i >= 0; i--) {
    const worker = queen.nanitics[i];
    if (worker.health > 0) continue;
    markYoungWorkerDead(queen, worker, youngColonyStressTest ? 'controlled resource collapse' : 'starvation');
    queen.nanitics.splice(i, 1);
  }

  queen.layClock -= dt;
  if (queen.layClock <= 0 && environment.season.name !== 'winter'
    && queen.colonyFood > 7 && queen.foundingBrood.length < 10 && queen.nanitics.length < 24) {
    addFoundingEgg(queen, 'colonyFood');
    queen.layClock = rand(5.2, 7.4);
    queen.state = 'laying a food-supported worker cohort';
  }
  updateFoundingBrood(queen, dt);

  if (youngColonyStressTest) queen.queenHealth -= dt * 1.7;
  else if (queen.nanitics.length === 0 && queen.colonyFood <= 0) queen.queenHealth -= dt * 0.12;
  else if (queen.colonyFood > 4) queen.queenHealth = Math.min(100, queen.queenHealth + dt * 0.02);

  if (queen.queenHealth <= 0 || (queen.nanitics.length === 0 && simTime - queen.openedAt > 24)) {
    collapseYoungColony(queen, queen.queenHealth <= 0 ? 'queen starvation' : 'loss of the nanitic workforce');
    return;
  }
  if (queen.nanitics.length >= 18 && queen.colonyFood > 18 && colony?.status !== 'established') {
    if (colony) colony.status = 'established';
    queen.foundingStage = 'established';
    queen.state = 'established young colony with sustained foraging';
    recordLineageEvent('colony-established', queen, { workers: queen.nanitics.length, storedFood: Number(queen.colonyFood.toFixed(1)) });
  } else if (queen.foundingStage === 'young') {
    queen.state = queen.colonyFood < 3 ? 'young colony under food pressure' : 'young colony sustaining queen and brood';
  } else if (queen.foundingStage === 'established') {
    queen.state = environment.season.name === 'winter'
      ? 'established colony in winter conservation'
      : 'established colony sustaining foraging and brood';
  }
}

function updateFoundingQueen(queen, dt) {
  if (!queen.alive) return;
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
    for (const worker of queen.nanitics) worker.ageDays += dt / 720;
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
  const enoughAlates = availableMatureGynes() > 0
    && (matureFlightAlates(homeReproduction, 'male').length + matureFlightAlates(rivalReproduction, 'male').length > 0);
  if (forceFlightWhenReady && regionalMating.windowsOpened === 0 && availableMatureGynes() > 0) openNuptialFlight(true);
  else if (!manualFlightOnly && !forceFlightWhenReady && !regionalMating.flightWindow.active && enoughAlates && simTime - regionalMating.lastFlightAt > 60
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
  updateRegionalReproductionVisuals(dt);
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
  placeAntOnNestCurve(ant, tunnelSegments[leg.segmentIndex].curve, ant.nestT);
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
  if (ants.length >= MAX_ANTS || (colonyRegistry.size > 0 && totalActiveWorkers() >= MAX_ACTIVE_WORKERS)) return null;
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
  ant.assignedRole = ant.tendency;
  ants.push(ant);
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
  remains.push({ mesh, life: 48, x: ant.x, z: ant.z, colonyId: ant.colonyId || HOME_COLONY_ID });
}

function markWorkerDead(ant, cause) {
  if (!ant.alive) return;
  ant.alive = false;
  ant.deathCause = cause;
  colonySurvival.deaths++;
  if (cause === 'predation') colonySurvival.predatorDeaths++;
  else if (cause === 'disease') colonySurvival.diseaseDeaths++;
  else if (cause === 'starvation') colonySurvival.starvationDeaths++;
  else if (cause === 'rival conflict') colonySurvival.conflictDeaths++;
  leaveWorkerRemains(ant);
  if (selectedAnt === ant) selectAnt(null);
}

function removeDeadWorkers() {
  for (let i = ants.length - 1; i >= 0; i--) if (!ants[i].alive) ants.splice(i, 1);
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
        source.amount -= stolen;
        predator.foodStolen += stolen;
        source.mesh.scale.setScalar(Math.max(0.24, Math.sqrt(source.amount / source.initial)));
        if (source.amount <= 0) {
          source.mesh.visible = false;
          createSignal(source.x, source.z, 0x88483d);
        }
      }
    }
    alignToGround(predatorMesh, predator.x, predator.z, -predator.heading - Math.PI / 2, 0.12);
    return;
  }
  let target = ants.find((ant) => ant.id === predator.targetId && ant.alive && !ant.insideNest);
  if (!target) {
    let best = Infinity;
    for (const ant of ants) {
      if (ant.insideNest || !ant.alive) continue;
      const distance = (ant.x - predator.x) ** 2 + (ant.z - predator.z) ** 2;
      if (distance < best) { best = distance; target = ant; }
    }
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
        markWorkerDead(target, 'predation');
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
        source.amount -= stolen;
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
  let target = null;
  let bestDistance = Infinity;
  for (const ant of ants) {
    if (!ant.alive || ant.insideNest) continue;
    if (Math.hypot(ant.x - spider.webX, ant.z - spider.webZ) > 3.25) continue;
    const distance = Math.hypot(ant.x - spider.x, ant.z - spider.z);
    if (distance < bestDistance) { bestDistance = distance; target = ant; }
  }
  for (const rival of rivalAnts) {
    if (!rival.alive || rival.insideNest) continue;
    if (Math.hypot(rival.x - spider.webX, rival.z - spider.webZ) > 3.25) continue;
    const distance = Math.hypot(rival.x - spider.x, rival.z - spider.z);
    if (distance < bestDistance) { bestDistance = distance; target = rival; }
  }
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
          markRivalDead(target, 'spider');
          spider.rivalKills++;
        } else {
          markWorkerDead(target, 'predation');
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
  environment.seasonIndex = (Math.floor(simTime / 92) + requestedSeasonOffset) % SEASONS.length;
  environment.seasonProgress = (simTime % 92) / 92;
  environment.season = SEASONS[environment.seasonIndex];
  const infected = ants.filter((ant) => ant.infection > 0);
  const prevalence = infected.length / Math.max(1, ants.length);
  environment.pressure = storedFood < 22 ? 'food crisis'
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
    const seniority = Math.max(0, ant.ageDays - 44);
    ant.health -= dt * seniority * 0.0018;
    if (storedFood < 4) ant.health -= dt * 0.045;
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
    if (ant.health <= 0) markWorkerDead(ant, storedFood < 4 ? 'starvation' : ant.infection > 0 ? 'disease' : 'age');
  }

  for (let i = remains.length - 1; i >= 0; i--) {
    const remain = remains[i];
    remain.life -= dt;
    remain.mesh.material.opacity = clamp(remain.life / 12, 0, 0.72);
    if (remain.life <= 0) {
      surfaceGroup.remove(remain.mesh);
      remain.mesh.material.dispose();
      remains.splice(i, 1);
    }
  }
}

const rivalAnts = [];
const rivalBrood = [];
let nextRivalId = 1;
const rivalColony = {
  storedFood: 82,
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
for (let i = 0; i < 4; i++) rivalEntranceBiology.cache.push({ kind: 'seed', nutrition: 1, value: 2.4 });

function markRivalDead(rival, cause = 'territorial conflict') {
  if (!rival.alive) return;
  rival.alive = false;
  rival.deathCause = cause;
  rivalColony.deaths++;
  if (cause === 'territorial conflict') rivalColony.rivalCasualties++;
  leaveWorkerRemains(rival);
}

function spawnRival(newborn = false, options = {}) {
  if (rivalAnts.length >= MAX_RIVALS || (colonyRegistry.size > 0 && totalActiveWorkers() >= MAX_ACTIVE_WORKERS)) return null;
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
  rivalAnts.push(rival);
  return rival;
}

function addRivalBrood(stage = 'egg', stageAge = 0, genome = null, generation = 1, options = {}) {
  if (rivalBrood.length >= 54) return null;
  const destiny = options.destiny || 'worker';
  const inherited = genome ? {
    sex: destiny === 'male' ? 'male' : 'female',
    destiny,
    genome,
    parentage: options.parentage || { damId: 'founding-population', sireId: null, sireLineageId: null, ploidy: destiny === 'male' ? 'haploid' : 'diploid' },
  } : createOffspringInheritance('queen-slate-001', rivalQueenGenome, rivalReproduction, destiny);
  const item = {
    stage, stageAge, vigor: rand(0.88, 1.1), generation,
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
  speciesProfile: SPECIES_PROFILE,
  status: 'mature',
  ageAtStartYears: 7,
  foundedBy: null,
  nest: NEST,
  focusOffset: new THREE.Vector2(0.8, 0.25),
  undergroundFocusY: -3.75,
  undergroundDistance: 11.8,
  color: 0xa84f36,
  maxWorkers: MAX_ANTS,
  workers: ants,
  brood,
  reproduction: homeReproduction,
  entrance: entranceBiology,
  pheromoneField: homePheromoneField,
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
  speciesProfile: SPECIES_PROFILE,
  status: 'mature',
  ageAtStartYears: 6,
  foundedBy: null,
  nest: RIVAL_NEST,
  focusOffset: new THREE.Vector2(-0.4, 0.25),
  undergroundFocusY: -4.55,
  undergroundDistance: 10.8,
  color: 0x748fa6,
  maxWorkers: MAX_RIVALS,
  workers: rivalAnts,
  brood: rivalBrood,
  reproduction: rivalReproduction,
  entrance: rivalEntranceBiology,
  pheromoneField: rivalPheromoneField,
  queen: { id: 'queen-slate-001', alive: true, genome: rivalQueenGenome },
  get storedFood() { return rivalColony.storedFood; },
  get foodDelivered() { return rivalColony.delivered; },
  get eggsLaid() { return rivalColony.eggsLaid; },
  get workersEclosed() { return rivalColony.workersEclosed; },
  get deaths() { return rivalColony.deaths; },
});

function focusedColony() {
  return getColony(cameraRig.focusedColonyId) || homeColonyRecord;
}

function focusCameraOnColony(colony, underground = true) {
  if (!colony) return;
  cameraRig.focusedColonyId = colony.id;
  cameraRig.target.x = colony.nest.x + colony.focusOffset.x;
  cameraRig.target.z = colony.nest.y + colony.focusOffset.y;
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
  const turnRate = dt * 4.2;
  rival.heading += clamp(wrapAngle(rival.desired - rival.heading), -turnRate, turnRate);
  const speed = rival.speed * speedFactor * (1 - weather.rain * 0.22) * webSlowAt(rival.x, rival.z);
  rival.x = clamp(rival.x + Math.cos(rival.heading) * speed * dt, -HALF_W + 0.35, HALF_W - 0.35);
  rival.z = clamp(rival.z + Math.sin(rival.heading) * speed * dt, -HALF_D + 0.35, HALF_D - 0.35);
  rival.distanceTraveled += speed * dt;
  rival.energy = Math.max(0, rival.energy - speed * dt * 0.07);
}

function nearestRivalFood(rival, pickupDistance = 0.58) {
  let found = null;
  let best = pickupDistance * pickupDistance;
  for (const food of foods) {
    if (food.amount <= 0) continue;
    const distance = (food.x - rival.x) ** 2 + (food.z - rival.z) ** 2;
    if (distance < best) { best = distance; found = food; }
  }
  return found;
}

function updateRivalAnt(rival, dt) {
  if (!rival.alive) return;
  rival.phase += dt * rival.speed * 8.1;
  rival.ageDays += dt / 720;
  rival.turnClock -= dt;
  rival.fightCooldown -= dt;

  if (rival.insideNest) {
    rival.transferTimer -= dt;
    rival.energy = Math.min(100, rival.energy + dt * 0.7);
    rival.state = 'moving cached food through slate nest';
    if (rival.transferTimer <= 0 && rival.transferCargo) {
      rivalColony.storedFood = Math.min(150, rivalColony.storedFood + rival.transferCargo.value);
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

  let opponent = null;
  let opponentDistance = 1.15;
  for (const ant of ants) {
    if (!ant.alive || ant.insideNest) continue;
    const distance = Math.hypot(ant.x - rival.x, ant.z - rival.z);
    if (distance < opponentDistance) { opponentDistance = distance; opponent = ant; }
  }
  if (opponent) {
    const toward = Math.atan2(opponent.z - rival.z, opponent.x - rival.x);
    const shouldFight = rival.role === 'guard' || rival.health > 54;
    rival.desired = shouldFight ? toward : toward + Math.PI;
    rival.state = shouldFight ? 'defending rival territory' : 'retreating from border';
    opponent.state = shouldFight ? 'fighting rival worker' : 'pressing territorial border';
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
        markWorkerDead(opponent, 'rival conflict');
        rivalColony.ourCasualties++;
      }
      if (rival.health <= 0) {
        markRivalDead(rival, 'territorial conflict');
      }
    }
    moveRival(rival, dt, shouldFight ? 1.08 : 1.3);
    return;
  }

  const homeDx = RIVAL_NEST.x - rival.x;
  const homeDz = RIVAL_NEST.y - rival.z;
  const homeDistance = Math.hypot(homeDx, homeDz);
  if (rival.carrying) {
    rival.state = 'returning food to rival stores';
    rival.desired = Math.atan2(homeDz, homeDx) + Math.sin(rival.phase * 0.18) * 0.05;
    rivalPherDeposit(rival.x, rival.z, 0.027);
    if (homeDistance < 0.72) {
      if (rivalEntranceBiology.cache.length < rivalEntranceBiology.capacity) {
        const nearby = rivalAnts.filter((worker) => worker !== rival && !worker.insideNest && !worker.carrying
          && Math.hypot(worker.x - RIVAL_NEST.x, worker.z - RIVAL_NEST.y) < 1.35).length;
        rivalEntranceBiology.cache.push({
          kind: rival.carryingKind || 'seed',
          nutrition: rival.carryingNutrition,
          value: 2.4 * rival.carryingNutrition,
        });
        rivalEntranceBiology.foodReturned++;
        rivalEntranceBiology.cacheDeposits++;
        rivalEntranceBiology.contactEvents += nearby;
        rivalEntranceBiology.recentReturns = Math.min(1, rivalEntranceBiology.recentReturns + 0.2);
        rivalEntranceBiology.activation = Math.min(1, rivalEntranceBiology.activation + 0.11 + rival.carryingNutrition * 0.05 + Math.min(0.14, nearby * 0.012));
        rival.carrying = false;
        rival.carryingKind = null;
        rival.carryingNutrition = 1;
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

  const pickup = nearestRivalFood(rival);
  if (pickup) {
    rival.carrying = true;
    rival.carryingNutrition = pickup.nutrition;
    rival.carryingKind = pickup.kind;
    rival.targetFood = pickup;
    pickup.amount -= 1;
    pickup.mesh.scale.setScalar(Math.max(0.24, Math.sqrt(pickup.amount / pickup.initial)));
    rival.state = 'rival collecting contested food';
    if (pickup.amount <= 0) pickup.mesh.visible = false;
    return;
  }

  if (!rival.targetFood || rival.targetFood.amount <= 0 || rival.turnClock <= 0) {
    let bestSource = null;
    let bestScore = -Infinity;
    for (const food of foods) {
      if (food.amount <= 0) continue;
      const distance = Math.hypot(food.x - rival.x, food.z - rival.z);
      const score = food.nutrition * 2.2 * rival.genome.foraging + Math.log1p(food.amount) - distance * 0.24;
      if (score > bestScore) { bestScore = score; bestSource = food; }
    }
    rival.targetFood = bestSource;
    rival.turnClock = rand(0.8, 1.8);
  }

  if (rival.targetFood) {
    const foodAngle = Math.atan2(rival.targetFood.z - rival.z, rival.targetFood.x - rival.x);
    const scent = rivalPherSample(rival.x + Math.cos(rival.heading) * 0.8, rival.z + Math.sin(rival.heading) * 0.8);
    rival.desired = foodAngle + Math.sin(rival.phase * 0.11) * (scent > 0.03 ? 0.08 : 0.22);
    rival.state = rival.role === 'scout' ? 'scouting contested food' : 'following rival trail';
  } else {
    rival.desired += rand(-0.5, 0.5);
    rival.state = 'patrolling rival territory';
  }
  if (rival.role === 'guard' && homeDistance > 6.2) rival.desired = Math.atan2(homeDz, homeDx);
  if (homeDistance > 14) rival.desired = Math.atan2(homeDz, homeDx);
  moveRival(rival, dt);
}

function updateRivalColony(dt) {
  rivalColony.storedFood = Math.max(0, rivalColony.storedFood - dt * (0.01 + rivalAnts.length * 0.0002));
  updateAlateCohort(rivalReproduction, dt);
  if ((environment.season.name === 'spring' || environment.season.name === 'summer') && rivalColony.storedFood > 62) {
    rivalReproduction.reproductiveBudget = clamp(
      rivalReproduction.reproductiveBudget + dt * 0.018 * clamp((rivalColony.storedFood - 62) / 55, 0, 1), 0, 18,
    );
  }
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
    const guardTarget = clamp(Math.round(rivalAnts.length * 0.16), 7, 18);
    const scoutTarget = clamp(Math.round(rivalAnts.length * 0.14), 6, 16);
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
    rivalColony.roleClock = 5;
  }
  for (let i = rivalBrood.length - 1; i >= 0; i--) {
    const item = rivalBrood[i];
    let development = item.vigor * (rivalColony.storedFood > 8 ? 0.9 : 0.3);
    if (item.stage === 'larva') {
      const rationMultiplier = item.destiny === 'gyne' ? 1.9 : item.destiny === 'male' ? 1.15 : 1;
      const ration = Math.min(rivalColony.storedFood, dt * 0.0065 * rationMultiplier);
      rivalColony.storedFood -= ration;
      if (ration < dt * 0.0048 * rationMultiplier) development *= 0.36;
    }
    item.stageAge += dt * development;
    if (item.stageAge < broodStageDuration(item)) continue;
    if (item.stage === 'egg') { item.stage = 'larva'; item.stageAge = 0; }
    else if (item.stage === 'larva') { item.stage = 'pupa'; item.stageAge = 0; }
    else {
      rivalBrood.splice(i, 1);
      if (item.destiny === 'worker') {
        if (spawnRival(true, { genome: item.genome, generation: item.generation, parentage: item.parentage })) rivalColony.workersEclosed++;
      } else ecloseAlate(rivalReproduction, item, RIVAL_COLONY_ID, 'slate');
    }
  }
  rivalColony.layClock -= dt;
  if (rivalColony.layClock <= 0) {
    if (rivalColony.storedFood > 24 && rivalBrood.length < 48 && environment.season.name !== 'winter') {
      const sexualSeason = environment.season.name === 'spring' || environment.season.name === 'summer';
      let destiny = 'worker';
      if (sexualSeason && rivalAnts.length >= 55 && rivalColony.storedFood > 74
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
    rivalColony.layClock = rand(14, 21);
  }

  for (const rival of rivalAnts) updateRivalAnt(rival, dt);
  for (let i = rivalAnts.length - 1; i >= 0; i--) if (!rivalAnts[i].alive) rivalAnts.splice(i, 1);
  for (let i = 0; i < rivalAnts.length; i++) {
    const rival = rivalAnts[i];
    if (rival.insideNest) continue;
    for (let j = i + 1; j < rivalAnts.length; j++) {
      const other = rivalAnts[j];
      if (other.insideNest) continue;
      let dx = rival.x - other.x;
      let dz = rival.z - other.z;
      let distance = Math.hypot(dx, dz);
      const minimum = 0.53 * (rival.size + other.size) * 0.5;
      if (distance >= minimum) continue;
      if (distance < 0.001) { dx = Math.cos(i * 2.3); dz = Math.sin(i * 2.3); distance = 1; }
      const push = (minimum - distance) * 0.48;
      rival.x += (dx / distance) * push;
      rival.z += (dz / distance) * push;
      other.x -= (dx / distance) * push;
      other.z -= (dz / distance) * push;
    }
  }
}

function updateColonyBiology(dt) {
  const activeNurses = ants.filter((ant) => ant.insideNest && ant.nestRouteKey === 'nursery' && ant.nestMode === 'working').length;
  const requiredNurses = Math.max(2, Math.ceil(brood.length / 4.2));
  colonyBiology.activeNurses = activeNurses;
  colonyBiology.requiredNurses = requiredNurses;
  colonyBiology.starvedLarvae = 0;

  const seasonalMetabolism = environment.season.name === 'winter' ? 1.3 : environment.season.name === 'summer' ? 1.08 : 1;
  storedFood = Math.max(0, storedFood - dt * (0.012 + ants.length * 0.00022) * seasonalMetabolism);
  updateAlateCohort(homeReproduction, dt);
  if ((environment.season.name === 'spring' || environment.season.name === 'summer') && storedFood > 65) {
    homeReproduction.reproductiveBudget = clamp(
      homeReproduction.reproductiveBudget + dt * 0.02 * clamp((storedFood - 65) / 60, 0, 1), 0, 20,
    );
  }
  const careRatio = clamp(activeNurses / requiredNurses, 0.35, 1.18);
  for (let i = brood.length - 1; i >= 0; i--) {
    const item = brood[i];
    let development = 0.58 + careRatio * 0.48;
    if (item.stage === 'larva') {
      const rationMultiplier = item.destiny === 'gyne' ? 1.9 : item.destiny === 'male' ? 1.15 : 1;
      const ration = Math.min(storedFood, dt * 0.0085 * rationMultiplier);
      storedFood -= ration;
      if (ration < dt * 0.006 * rationMultiplier) {
        development *= 0.32;
        colonyBiology.starvedLarvae++;
      }
    }
    item.care = clamp(item.care + dt * (careRatio - 0.72) * 0.008, 0.62, 1.16);
    item.stageAge += dt * development * item.care;
    if (item.stageAge < broodStageDuration(item)) continue;
    if (item.stage === 'egg') {
      item.stage = 'larva';
      item.stageAge = 0;
    } else if (item.stage === 'larva') {
      item.stage = 'pupa';
      item.stageAge = 0;
    } else {
      brood.splice(i, 1);
      if (item.destiny === 'worker' && ants.length < MAX_ANTS) {
        if (spawnAnt(false, { newborn: true, ageDays: 0, genome: item.genome, generation: item.generation, parentage: item.parentage })) workersEclosed++;
      } else if (item.destiny !== 'worker') ecloseAlate(homeReproduction, item, HOME_COLONY_ID, 'amber');
    }
  }

  queenLayClock -= dt;
  const nurseryCapacity = 18 + Math.round(tunnelSegments[1].progress * 42);
  if (queenLayClock <= 0) {
    const safeToLay = environment.pressure === 'stable' || environment.pressure === 'predator alarm';
    const canLay = storedFood > 22 && safeToLay && environment.season.name !== 'winter'
      && brood.length < nurseryCapacity && ants.length + brood.length < MAX_ANTS + 18;
    if (canLay) {
      const clutch = storedFood > 78 && activeNurses >= requiredNurses * 0.7 ? 2 : 1;
      for (let i = 0; i < clutch; i++) {
        const sexualSeason = environment.season.name === 'spring' || environment.season.name === 'summer';
        let destiny = 'worker';
        if (sexualSeason && ants.length >= 110 && storedFood > 82
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
    queenLayClock = rand(13, 20) * (storedFood < 45 ? 1.35 : 1);
  }
}

function depositInEntranceCache(ant) {
  if (!ant.pendingDelivery || entranceBiology.cache.length >= entranceBiology.capacity) return false;
  const waiting = ants.filter((worker) => worker.alive && worker.insideNest
    && worker.nestRouteKey === 'vestibule' && worker.nestMode === 'working'
    && worker.assignedRole === 'forager' && worker !== ant).length;
  const nutrition = ant.carryingNutrition || 1;
  entranceBiology.cache.push({
    kind: ant.carryingKind || 'seed',
    nutrition,
    value: 2.5 * nutrition,
  });
  entranceBiology.foodReturned++;
  entranceBiology.cacheDeposits++;
  entranceBiology.recentReturns = Math.min(1, entranceBiology.recentReturns + 0.22);
  entranceBiology.activation = Math.min(1, entranceBiology.activation + 0.1 + nutrition * 0.055 + Math.min(0.16, waiting * 0.018));
  entranceBiology.contactEvents += waiting;
  ant.pendingDelivery = false;
  ant.carrying = false;
  ant.carryingKind = null;
  ant.carryingNutrition = 1;
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
};
function updateLaborAssignments(dt) {
  laborClock += dt;
  if (laborClock < 2.5) return;
  laborClock = 0;
  const projects = activeConstructionProjects();
  const broodPressure = brood.length / Math.max(1, ants.length);
  const foodPressure = clamp((62 - storedFood) / 62, 0, 1);
  const survivalEmergency = environment.pressure === 'food crisis' || environment.pressure === 'disease outbreak' || environment.season.name === 'winter';
  const targetExcavators = projects.length > 0
    ? clamp(Math.round(ants.length * (survivalEmergency ? 0.018 : 0.045 + (storedFood > 45 ? 0.02 : 0))), 2, 14)
    : 0;
  const targetNurses = clamp(Math.ceil(brood.length / 4.2 + broodPressure * 7), 3, Math.round(ants.length * 0.24));
  const targetTransfers = entranceBiology.cache.length > 0
    ? clamp(Math.ceil(entranceBiology.cache.length / 5), 2, 10)
    : 1;
  const targetSanitizers = remains.length > 0 ? clamp(Math.ceil(remains.length / 3), 2, 6) : 0;
  const targetForagers = Math.max(0, ants.length - targetNurses - targetTransfers - targetExcavators - targetSanitizers);
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
  for (const ant of ants) if (!claimed.has(ant)) ant.assignedRole = 'forager';

  colonyLabor.assignedForagers = ants.filter((ant) => ant.assignedRole === 'forager').length;
  colonyLabor.assignedNurses = ants.filter((ant) => ant.assignedRole === 'nurse').length;
  colonyLabor.assignedTransfers = ants.filter((ant) => ant.assignedRole === 'transfer' || ant.transferCargo).length;
  colonyLabor.assignedExcavators = ants.filter((ant) => ant.assignedRole === 'excavator').length;
  colonyLabor.assignedSanitizers = ants.filter((ant) => ant.assignedRole === 'sanitizer' || ant.sanitationCargo).length;
}

const obstacles = [
  { x: 6.4, z: -0.7, r: 0.43 },
  { x: 8.0, z: -0.1, r: 0.38 },
];

const ANT_CELL_SIZE = 0.72;
const ANT_GRID_ROWS = Math.ceil(WORLD_D / ANT_CELL_SIZE) + 4;
const antSpatialGrid = new Map();

function antCellCoords(x, z) {
  return {
    x: Math.floor((x + HALF_W) / ANT_CELL_SIZE),
    z: Math.floor((z + HALF_D) / ANT_CELL_SIZE),
  };
}

function antCellKey(x, z) { return x * ANT_GRID_ROWS + z; }

function rebuildAntSpatialGrid() {
  antSpatialGrid.clear();
  for (let i = 0; i < ants.length; i++) {
    if (ants[i].insideNest) continue;
    const cell = antCellCoords(ants[i].x, ants[i].z);
    const key = antCellKey(cell.x, cell.z);
    let occupants = antSpatialGrid.get(key);
    if (!occupants) {
      occupants = [];
      antSpatialGrid.set(key, occupants);
    }
    occupants.push(i);
  }
}

function applyNeighborAvoidance(ant) {
  const cell = antCellCoords(ant.x, ant.z);
  let separateX = 0;
  let separateZ = 0;
  let pressure = 0;
  let neighbors = 0;

  for (let ox = -1; ox <= 1; ox++) {
    for (let oz = -1; oz <= 1; oz++) {
      const occupants = antSpatialGrid.get(antCellKey(cell.x + ox, cell.z + oz));
      if (!occupants) continue;
      for (const index of occupants) {
        const other = ants[index];
        if (other === ant) continue;
        let dx = ant.x - other.x;
        let dz = ant.z - other.z;
        let distanceSq = dx * dx + dz * dz;
        const opposing = Math.cos(ant.heading - other.heading) < -0.25;
        const personalSpace = (opposing ? 0.92 : 0.78) * (ant.size + other.size) * 0.5;
        if (distanceSq >= personalSpace * personalSpace) continue;
        if (distanceSq < 0.00001) {
          const fallback = ant.phase * 1.71 - other.phase * 0.63;
          dx = Math.cos(fallback) * 0.01;
          dz = Math.sin(fallback) * 0.01;
          distanceSq = 0.0001;
        }
        const distance = Math.sqrt(distanceSq);
        const strength = 1 - distance / personalSpace;
        separateX += (dx / distance) * strength;
        separateZ += (dz / distance) * strength;
        if (opposing) {
          separateX += -Math.sin(ant.heading) * Math.sign(ant.laneBias || 1) * strength * 0.42;
          separateZ += Math.cos(ant.heading) * Math.sign(ant.laneBias || 1) * strength * 0.42;
        }
        pressure += strength;
        neighbors++;
      }
    }
  }

  if (neighbors > 0) {
    const routeWeight = ant.carrying ? 1.15 : 1;
    const desiredX = Math.cos(ant.desired) * routeWeight + separateX * 1.65;
    const desiredZ = Math.sin(ant.desired) * routeWeight + separateZ * 1.65;
    ant.desired = Math.atan2(desiredZ, desiredX);
    if (pressure > 1.35) ant.state = 'weaving through traffic';
  }
}

function resolveAntSpacing() {
  rebuildAntSpatialGrid();
  for (let i = 0; i < ants.length; i++) {
    const ant = ants[i];
    if (ant.insideNest) continue;
    const cell = antCellCoords(ant.x, ant.z);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const occupants = antSpatialGrid.get(antCellKey(cell.x + ox, cell.z + oz));
        if (!occupants) continue;
        for (const otherIndex of occupants) {
          if (otherIndex <= i) continue;
          const other = ants[otherIndex];
          if (other.insideNest) continue;
          let dx = ant.x - other.x;
          let dz = ant.z - other.z;
          let distance = Math.hypot(dx, dz);
          const minimum = 0.68 * (ant.size + other.size) * 0.5;
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
  let found = null;
  let best2 = maxDist * maxDist;
  for (const food of foods) {
    if (food.amount <= 0) continue;
    const d2 = (food.x - ant.x) ** 2 + (food.z - ant.z) ** 2;
    if (d2 < best2) { best2 = d2; found = food; }
  }
  return found;
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
  let target = null;
  let targetDistance = Infinity;
  for (const remain of remains) {
    const distance = Math.hypot(remain.x - ant.x, remain.z - ant.z);
    if (distance < targetDistance) { targetDistance = distance; target = remain; }
  }
  if (!target) return false;
  ant.state = 'locating colony remains';
  steerTowards(ant, Math.atan2(target.z - ant.z, target.x - ant.x), 0.94);
  if (targetDistance < 0.25) {
    const index = remains.indexOf(target);
    if (index >= 0) remains.splice(index, 1);
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
    placeAntOnNestCurve(ant, segment.curve, Math.max(0.012, segment.progress));
    ant.nestHeading = Math.atan2(segment.curve.getTangentAt(Math.max(0.012, segment.progress)).z, segment.curve.getTangentAt(Math.max(0.012, segment.progress)).x);
    ant.state = `excavating ${segment.name}`;
    ant.energy = Math.max(0, ant.energy - dt * 0.24);
    ant.digTimer -= dt;
    if (segment.progress < 0.999) {
      const morphology = clamp(ant.size, 0.82, 1.2);
      const experience = Math.min(0.2, (ant.taskExperience.excavator || 0) * 0.018);
      const productivity = (0.7 + ant.energy * 0.004 + (ant.tendency === 'excavator' ? 0.18 : 0) + experience) * morphology;
      segment.work = Math.min(segment.workRequired, segment.work + dt * productivity);
      segment.progress = clamp(segment.work / segment.workRequired, 0.012, 1);
    }
    if (ant.digTimer <= 0 || segment.progress >= 0.999 || ant.energy < 18) {
      const finalLeg = route.legs[route.legs.length - 1];
      finalLeg.to = Math.max(0.012, segment.progress);
      finalLeg.length = Math.max(0.1, segment.curve.getLength() * finalLeg.to);
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
          const foodPressure = clamp((62 - storedFood) / 62, 0, 1);
          const weatherSuppression = weather.rain * 0.72 + (environment.season.name === 'winter' ? 0.28 : 0);
          const stimulus = 0.18 + entranceBiology.activation * 0.72 + entranceBiology.recentReturns * 0.34
            + foodPressure * 0.2 + ant.genome.foraging * 0.1 - weatherSuppression;
          const threshold = ant.responseThresholds?.forager ?? 0.5;
          if (stimulus + rand(-0.12, 0.12) >= threshold) {
            entranceBiology.activatedDepartures++;
            ant.state = 'activated by returning foragers';
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
        storedFood = Math.min(180, storedFood + ant.transferCargo.value);
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
      ant.nestMode = 'traveling';
      ant.nestDirection = -1;
      ant.nestLeg = route.legs.length - 1;
      ant.nestT = route.legs[ant.nestLeg].to;
    }
    return;
  }

  const leg = route.legs[ant.nestLeg];
  const curve = tunnelSegments[leg.segmentIndex].curve;
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
      } else emergeFromNest(ant);
    }
    else {
      ant.nestT = route.legs[ant.nestLeg].to;
      setNestPosition(ant);
    }
  }
}

function updateAnt(ant, dt) {
  if (!ant.alive) return;
  ant.phase += dt * (8.4 * ant.speed);
  ant.borderCooldown -= dt;
  ant.turnClock -= dt;
  ant.pause -= dt;
  ant.ageDays += dt / 720;

  if (ant.insideNest) {
    updateNestAnt(ant, dt);
    return;
  }

  if (ant.pause <= 0 && random() < dt * 0.07) ant.pause = rand(0.08, 0.34);
  const nestDx = NEST.x - ant.x;
  const nestDz = NEST.y - ant.z;
  const nestDistance = Math.hypot(nestDx, nestDz);

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
  } else {
    const food = nearestFood(ant);
    if (food) {
      ant.carrying = true;
      ant.carryingNutrition = food.nutrition;
      ant.carryingKind = food.kind;
      ant.state = 'collecting';
      food.amount -= 1;
      food.mesh.scale.setScalar(Math.max(0.24, Math.sqrt(food.amount / food.initial)));
      if (food.amount <= 0) {
        food.mesh.visible = false;
        createSignal(food.x, food.z, 0x6f7551);
      }
    } else {
      const look = 0.8;
      const side = 0.56;
      const pL = pherSample(ant.x + Math.cos(ant.heading - side) * look, ant.z + Math.sin(ant.heading - side) * look);
      const pC = pherSample(ant.x + Math.cos(ant.heading) * look, ant.z + Math.sin(ant.heading) * look);
      const pR = pherSample(ant.x + Math.cos(ant.heading + side) * look, ant.z + Math.sin(ant.heading + side) * look);
      const strongest = Math.max(pL, pC, pR);
      if (strongest > 0.035 / ant.genome.foraging && random() < clamp(0.72 + ant.genome.foraging * 0.15, 0.78, 0.93)) {
        ant.state = 'following scent';
        let offset = 0;
        if (pL > pC && pL > pR) offset = -side;
        else if (pR > pC) offset = side;
        steerTowards(ant, ant.heading + offset + ant.laneBias * 0.5 + rand(-0.09, 0.09), 0.66);
      } else {
        ant.state = (weather.rain > 0.72 || ant.energy < 30) && nestDistance > 2 ? 'returning to nest' : 'exploring';
        if ((weather.rain > 0.72 || ant.energy < 30) && nestDistance > 2) {
          steerTowards(ant, Math.atan2(nestDz, nestDx), 0.42);
        } else if (ant.turnClock <= 0) {
          const outward = Math.atan2(ant.z - NEST.y, ant.x - NEST.x);
          const exploratory = ant.heading + rand(-0.75, 0.75);
          const target = nestDistance < 2.0 ? outward + rand(-0.55, 0.55) : exploratory;
          steerTowards(ant, target, 0.72);
          ant.turnClock = rand(0.3, 1.7);
        }
      }
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

  if (!ant.carrying && nestDistance < 1.55 && weather.rain < 0.52 && ant.energy >= 30) {
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
  const frameCounts = [0, 0, 0, 0];
  antInstanceLookup.forEach((lookup) => { lookup.length = 0; });
  let carryingCount = 0;
  let soilCarryingCount = 0;
  let visibleCount = 0;
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const groundTilt = new THREE.Quaternion();
  const headingSpin = new THREE.Quaternion();
  const normal = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (let i = 0; i < ants.length; i++) {
    const ant = ants[i];
    if (ant.insideNest) continue;
    const frame = Math.floor(ant.phase) % 4;
    const index = frameCounts[frame]++;
    antInstanceLookup[frame][index] = ant;
    const bob = Math.sin(ant.phase * Math.PI * 0.5) * 0.012;
    pos.set(ant.x, groundHeight(ant.x, ant.z) + 0.105 + bob, ant.z);
    groundTilt.setFromUnitVectors(Y_AXIS, groundNormal(ant.x, ant.z, normal));
    headingSpin.setFromAxisAngle(Y_AXIS, -ant.heading - Math.PI / 2);
    q.copy(groundTilt).multiply(headingSpin);
    const pulse = 1 + Math.sin(ant.phase * Math.PI) * 0.018;
    s.setScalar(ant.size * pulse);
    matrix.compose(pos, q, s);
    antMeshes[frame].setMatrixAt(index, matrix);
    const conditionColor = ant.infection > 0
      ? new THREE.Color(0x8a7460).lerp(new THREE.Color(0x72516f), ant.infection)
      : new THREE.Color(0xffffff).lerp(new THREE.Color(0x9b6a58), clamp((65 - ant.health) / 50, 0, 0.7));
    antMeshes[frame].setColorAt(index, conditionColor);

    matrix.compose(
      new THREE.Vector3(ant.x, groundHeight(ant.x, ant.z) + 0.038, ant.z),
      groundTilt,
      new THREE.Vector3(ant.size * 1.05, ant.size * 1.05, ant.size * 1.05),
    );
    antShadows.setMatrixAt(visibleCount, matrix);

    if (ant.carrying) {
      const fx = ant.x + Math.cos(ant.heading) * 0.29;
      const fz = ant.z + Math.sin(ant.heading) * 0.29;
      matrix.compose(
        new THREE.Vector3(fx, groundHeight(fx, fz) + 0.17, fz),
        q,
        new THREE.Vector3(1, 0.65, 1),
      );
      carryMesh.setMatrixAt(carryingCount++, matrix);
    }
    if (ant.soilCargo || ant.sanitationCargo) {
      const sx = ant.x + Math.cos(ant.heading) * 0.3;
      const sz = ant.z + Math.sin(ant.heading) * 0.3;
      matrix.compose(
        new THREE.Vector3(sx, groundHeight(sx, sz) + 0.18, sz),
        q,
        new THREE.Vector3(1.15, 0.82, 1),
      );
      soilCarryMesh.setMatrixAt(soilCarryingCount++, matrix);
    }
    visibleCount++;
  }
  antMeshes.forEach((mesh, frame) => {
    mesh.count = frameCounts[frame];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  antShadows.count = visibleCount;
  antShadows.instanceMatrix.needsUpdate = true;
  carryMesh.count = carryingCount;
  carryMesh.instanceMatrix.needsUpdate = true;
  soilCarryMesh.count = soilCarryingCount;
  soilCarryMesh.instanceMatrix.needsUpdate = true;
}

function renderRivals() {
  const frameCounts = [0, 0, 0, 0];
  rivalInstanceLookup.forEach((lookup) => { lookup.length = 0; });
  let carryingCount = 0;
  const pos = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const groundTilt = new THREE.Quaternion();
  const headingSpin = new THREE.Quaternion();
  const normal = new THREE.Vector3();
  for (const rival of rivalAnts) {
    if (!rival.alive || rival.insideNest) continue;
    const frame = Math.floor(rival.phase) % 4;
    const index = frameCounts[frame]++;
    rivalInstanceLookup[frame][index] = rival;
    pos.set(rival.x, groundHeight(rival.x, rival.z) + 0.11 + Math.sin(rival.phase) * 0.009, rival.z);
    groundTilt.setFromUnitVectors(Y_AXIS, groundNormal(rival.x, rival.z, normal));
    headingSpin.setFromAxisAngle(Y_AXIS, -rival.heading - Math.PI / 2);
    orientation.copy(groundTilt).multiply(headingSpin);
    matrix.compose(pos, orientation, new THREE.Vector3(rival.size, rival.size, rival.size));
    rivalMeshes[frame].setMatrixAt(index, matrix);
    rivalMeshes[frame].setColorAt(index, new THREE.Color(0xffffff).lerp(new THREE.Color(0xc2736b), clamp((62 - rival.health) / 48, 0, 0.72)));
    if (rival.carrying) {
      const fx = rival.x + Math.cos(rival.heading) * 0.29;
      const fz = rival.z + Math.sin(rival.heading) * 0.29;
      matrix.compose(
        new THREE.Vector3(fx, groundHeight(fx, fz) + 0.17, fz),
        orientation,
        new THREE.Vector3(1, 0.65, 1),
      );
      rivalCarryMesh.setMatrixAt(carryingCount++, matrix);
    }
  }
  rivalMeshes.forEach((mesh, frame) => {
    mesh.count = frameCounts[frame];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  rivalCarryMesh.count = carryingCount;
  rivalCarryMesh.instanceMatrix.needsUpdate = true;
}

function antWorldPosition(ant, out = new THREE.Vector3()) {
  if (ant.insideNest) return out.copy(ant.nestPosition);
  return out.set(ant.x, groundHeight(ant.x, ant.z) + 0.13, ant.z);
}

function selectAnt(ant) {
  selectedAnt = ant || null;
  followingSelected = Boolean(ant);
  selectedPathPoints = ant ? [antWorldPosition(ant)] : [];
  selectedPathClock = 0;
  selectedPath.visible = Boolean(ant);
  antNote.hidden = !ant;
  if (ant) {
    const colony = colonyForWorker(ant);
    if (colony) cameraRig.focusedColonyId = colony.id;
    const below = ant.insideNest;
    cameraRig.desiredPitch = below ? -0.32 : 0.72;
    cameraRig.desiredDistance = below ? 8.8 : Math.min(cameraRig.desiredDistance, 11.5);
    updateAntNote();
  }
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
  antNoteTitle.textContent = `Worker ${workerDisplayId(selectedAnt)}`;
  antNoteTask.textContent = selectedAnt.state;
  antNoteFacts.innerHTML = `
    <dt>colony</dt><dd>${colony?.displayName || 'unregistered colony'}</dd>
    <dt>lineage</dt><dd>${colony?.lineageId || 'unknown'}</dd>
    <dt>assignment</dt><dd>${assignment}</dd>
    <dt>tendency</dt><dd>${tendency}</dd>
    ${selectedAnt.responseThresholds ? `<dt>response</dt><dd>${selectedAnt.responseThresholds[assignment]?.toFixed(2) || 'flexible'} threshold</dd>` : ''}
    <dt>generation</dt><dd>G${selectedAnt.generation}</dd>
    <dt>traits</dt><dd>${selectedAnt.genome.speed.toFixed(2)} speed · ${selectedAnt.genome.diseaseResistance.toFixed(2)} resilience</dd>
    <dt>maturity</dt><dd>${workerMaturity(selectedAnt.ageDays)}</dd>
    <dt>size class</dt><dd>${selectedAnt.workerCaste || 'media'} worker</dd>
    <dt>location</dt><dd>${location}</dd>
    <dt>age</dt><dd>${selectedAnt.ageDays.toFixed(1)} days</dd>
    <dt>energy</dt><dd>${Math.round(selectedAnt.energy)}%</dd>
    <dt>health</dt><dd>${Math.round(selectedAnt.health)}%</dd>
    <dt>condition</dt><dd>${infection > 0 ? `infected ${Math.round(infection * 100)}%` : selectedAnt.health < 70 ? 'injured' : 'healthy'}</dd>
    <dt>cargo</dt><dd>${selectedAnt.transferCargo ? 'cached food transfer' : selectedAnt.sanitationCargo ? 'colony remains' : selectedAnt.soilCargo ? 'excavated soil' : selectedAnt.carrying ? 'food fragment' : 'none'}</dd>
    ${selectedAnt.excavationProject != null ? `<dt>worksite</dt><dd>${tunnelSegments[selectedAnt.excavationProject].name}</dd>` : ''}
    <dt>completed</dt><dd>${selectedAnt.tasksCompleted || 0}</dd>
    <dt>nest trips</dt><dd>${selectedAnt.trips || 0}</dd>`;
}

function updateSelection(dt) {
  selectedSurfaceRing.visible = Boolean(selectedAnt && !selectedAnt.insideNest);
  selectedNestHalo.visible = Boolean(selectedAnt && selectedAnt.insideNest);
  if (!selectedAnt) return;
  const position = antWorldPosition(selectedAnt);
  if (selectedAnt.insideNest) {
    selectedNestHalo.position.copy(position);
    selectedNestHalo.rotation.y += dt * 0.7;
  } else {
    selectedSurfaceRing.position.set(selectedAnt.x, groundHeight(selectedAnt.x, selectedAnt.z) + 0.09, selectedAnt.z);
    selectedSurfaceRing.scale.setScalar(0.92 + Math.sin(simTime * 4.2) * 0.08);
  }
  selectedPathClock += dt;
  if (selectedPathClock >= 0.16) {
    selectedPathClock = 0;
    selectedPathPoints.push(position.clone());
    if (selectedPathPoints.length > 90) selectedPathPoints.shift();
    selectedPathGeometry.setFromPoints(selectedPathPoints);
  }
  updateAntNote();
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

// ---------- simulation loop ----------
let simTime = 0;
let spawnClock = 0;
let foodClock = 0;
let paused = false;
const SIM_SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
let simSpeedIndex = 2;
let timeScale = SIM_SPEEDS[simSpeedIndex];
const requestedTimeScale = Number(new URLSearchParams(window.location.search).get('speed'));
if (SIM_SPEEDS.includes(requestedTimeScale)) {
  simSpeedIndex = SIM_SPEEDS.indexOf(requestedTimeScale);
  timeScale = requestedTimeScale;
}
if (new URLSearchParams(window.location.search).get('predator') === '1') startPredatorVisit(true);
if (new URLSearchParams(window.location.search).get('spider') === '1') startSpiderVisit();
let speedIndicatorTimer = 0;

function showTimeScale(label = `TIME ×${timeScale}`) {
  speedIndicator.textContent = label;
  speedIndicator.classList.add('visible');
  speedIndicatorTimer = 1.7;
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
  const seasonalFoodInterval = 27 / environment.season.food;
  if (foodClock > seasonalFoodInterval && foods.filter((f) => f.amount > 0).length < Math.ceil(2 + environment.season.food * 2)) {
    foodClock = 0;
    const roll = random();
    const kind = environment.season.name === 'winter' ? (roll < 0.72 ? 'seed' : 'crumb')
      : roll < 0.22 ? 'berry' : roll < 0.38 ? 'beetle' : roll < 0.62 ? 'seed' : 'crumb';
    addFood(rand(-12, 13), rand(-9, 9), kind, Math.floor(rand(34, 72) * environment.season.food), rand(1.2, 1.7));
  }
  updateSurvival(dt);
  updatePredator(dt);
  updateSpider(dt);
  updateWeather(dt);
  updateNuptialFlight(dt);
  updatePheromones(dt);
  updateEntranceBiology(dt);
  refreshConstructionProjects();
  updateLaborAssignments(dt);
  updateColonyBiology(dt);
  updateRivalColony(dt);
  rebuildAntSpatialGrid();
  for (const ant of ants) updateAnt(ant, dt);
  removeDeadWorkers();
  resolveAntSpacing();
  updateAtmosphere(dt);
  updateUnderground();
  updateSelection(dt);

  const day = (Math.sin(simTime * 0.027) + 1) * 0.5;
  viewState.surfaceSun = 2.15 + day * 2.15 - weather.rain * 1.0;
  viewState.surfaceHemi = 1.25 + day * 1.15;
  sun.color.setHSL(0.09 + day * 0.025, 0.78, 0.67 + day * 0.13);
  const bgDay = new THREE.Color(0xc9bb8c);
  const bgDusk = new THREE.Color(0x6e765d);
  bgDay.lerp(new THREE.Color(environment.season.tint), 0.34);
  terrain.material.color.lerp(new THREE.Color(environment.season.tint), Math.min(1, dt * 0.22));
  viewState.surfaceBackground.copy(bgDusk).lerp(bgDay, day * (1 - weather.rain * 0.46));
}

function updateCamera(dt) {
  cameraRig.idle += dt;
  if (followingSelected && selectedAnt) {
    const follow = antWorldPosition(selectedAnt);
    const followAmount = Math.min(1, dt * 4.8);
    cameraRig.target.x += (follow.x - cameraRig.target.x) * followAmount;
    cameraRig.target.z += (follow.z - cameraRig.target.z) * followAmount;
    cameraRig.desiredPitch = selectedAnt.insideNest ? -0.32 : 0.72;
    cameraRig.desiredDistance = selectedAnt.insideNest ? 8.8 : 10.5;
  }
  cameraRig.pitch += (cameraRig.desiredPitch - cameraRig.pitch) * Math.min(1, dt * 4.2);
  cameraRig.distance += (cameraRig.desiredDistance - cameraRig.distance) * Math.min(1, dt * 4);
  if (cameraRig.idle > 6) cameraRig.yaw += dt * 0.012;

  const moveSpeed = dt * (heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight') ? 9 : 4.6) * clamp(cameraRig.distance / 20, 0.62, 1.35);
  const forwardX = -Math.sin(cameraRig.yaw);
  const forwardZ = -Math.cos(cameraRig.yaw);
  const rightX = -Math.cos(cameraRig.yaw);
  const rightZ = Math.sin(cameraRig.yaw);
  let moveX = 0;
  let moveZ = 0;
  if (heldKeys.has('KeyW') || heldKeys.has('ArrowUp')) { moveX += forwardX; moveZ += forwardZ; }
  if (heldKeys.has('KeyS') || heldKeys.has('ArrowDown')) { moveX -= forwardX; moveZ -= forwardZ; }
  if (heldKeys.has('KeyD') || heldKeys.has('ArrowRight')) { moveX += rightX; moveZ += rightZ; }
  if (heldKeys.has('KeyA') || heldKeys.has('ArrowLeft')) { moveX -= rightX; moveZ -= rightZ; }
  if (moveX || moveZ || heldKeys.has('KeyQ') || heldKeys.has('KeyE')) followingSelected = false;
  const moveLength = Math.hypot(moveX, moveZ) || 1;
  cameraRig.target.x += (moveX / moveLength) * moveSpeed;
  cameraRig.target.z += (moveZ / moveLength) * moveSpeed;
  if (heldKeys.has('KeyQ')) cameraRig.desiredPitch -= dt * 0.72;
  if (heldKeys.has('KeyE')) cameraRig.desiredPitch += dt * 0.72;
  cameraRig.desiredPitch = clamp(cameraRig.desiredPitch, -1.12, 1.16);
  cameraRig.target.x = clamp(cameraRig.target.x, -12.5, 11.5);
  cameraRig.target.z = clamp(cameraRig.target.z, -9.5, 9.5);

  viewState.undergroundBlend = THREE.MathUtils.smoothstep(clamp((-cameraRig.pitch + 0.08) / 0.4, 0, 1), 0, 1);
  const targetFocusY = THREE.MathUtils.lerp(
    groundHeight(cameraRig.target.x, cameraRig.target.z) * 0.25,
    followingSelected && selectedAnt?.insideNest ? selectedAnt.nestPosition.y : (focusedColony()?.undergroundFocusY ?? -5.35),
    viewState.undergroundBlend,
  );
  cameraRig.focusY += (targetFocusY - cameraRig.focusY) * Math.min(1, dt * 5.5);
  const focusY = cameraRig.focusY;
  const horizontal = Math.cos(cameraRig.pitch) * cameraRig.distance;
  camera.position.set(
    cameraRig.target.x + Math.sin(cameraRig.yaw) * horizontal,
    focusY + Math.sin(cameraRig.pitch) * cameraRig.distance,
    cameraRig.target.z + Math.cos(cameraRig.yaw) * horizontal,
  );
  camera.lookAt(cameraRig.target.x, focusY, cameraRig.target.z);

  surfaceGroup.visible = viewState.undergroundBlend < 0.58;
  undergroundGroup.visible = viewState.undergroundBlend > 0.035;
  scene.background.copy(viewState.surfaceBackground).lerp(viewState.undergroundBackground, viewState.undergroundBlend);
  scene.fog.color.copy(scene.background);
  scene.fog.density = THREE.MathUtils.lerp(0.018, 0.008, viewState.undergroundBlend);
  sun.intensity = viewState.surfaceSun * (1 - viewState.undergroundBlend);
  hemi.intensity = viewState.surfaceHemi * (1 - viewState.undergroundBlend) + 0.12 * viewState.undergroundBlend;
  renderer.toneMappingExposure = THREE.MathUtils.lerp(1.08, 1.14, viewState.undergroundBlend);
  if (speedIndicatorTimer > 0) {
    speedIndicatorTimer -= dt;
    if (speedIndicatorTimer <= 0) speedIndicator.classList.remove('visible');
  }
}

function render() {
  renderAnts();
  renderRivals();
  renderer.render(scene, camera);
}

let last = performance.now();
let accumulator = 0;
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  accumulator += dt * timeScale;
  while (accumulator >= FIXED_DT) { update(FIXED_DT); accumulator -= FIXED_DT; }
  updateCamera(dt);
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- direct, low-interface interaction ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const pointerState = { down: false, x: 0, y: 0, lastX: 0, lastY: 0, moved: 0, button: 0, shift: false };

function setPointer(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
}

function groundPoint(clientX, clientY) {
  setPointer(clientX, clientY);
  const hit = raycaster.intersectObject(terrain, false)[0];
  return hit?.point || null;
}

function antAtPointer(clientX, clientY) {
  setPointer(clientX, clientY);
  if (viewState.undergroundBlend < 0.5) {
    const hits = raycaster.intersectObjects([...antMeshes, ...rivalMeshes], false);
    for (const hit of hits) {
      const homeFrame = antMeshes.indexOf(hit.object);
      if (homeFrame >= 0) {
        const ant = antInstanceLookup[homeFrame]?.[hit.instanceId];
        if (ant) return ant;
      }
      const rivalFrame = rivalMeshes.indexOf(hit.object);
      if (rivalFrame >= 0) {
        const rival = rivalInstanceLookup[rivalFrame]?.[hit.instanceId];
        if (rival) return rival;
      }
    }
  } else {
    const hit = raycaster.intersectObjects([...undergroundSpritePool, ...rivalTransferPool], false).find((candidate) => candidate.object.visible);
    if (hit?.object.userData.antId != null) return ants.find((ant) => ant.id === hit.object.userData.antId) || null;
    if (hit?.object.userData.workerId != null) return rivalAnts.find((rival) => rival.id === hit.object.userData.workerId) || null;
  }
  return null;
}

canvas.addEventListener('pointerdown', (event) => {
  pointerState.down = true;
  pointerState.x = pointerState.lastX = event.clientX;
  pointerState.y = pointerState.lastY = event.clientY;
  pointerState.moved = 0;
  pointerState.button = event.button;
  pointerState.shift = event.shiftKey;
  cameraRig.idle = 0;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (!pointerState.down) return;
  const dx = event.clientX - pointerState.lastX;
  const dy = event.clientY - pointerState.lastY;
  pointerState.moved += Math.hypot(dx, dy);
  pointerState.lastX = event.clientX;
  pointerState.lastY = event.clientY;
  if (pointerState.button === 2) {
    const pan = cameraRig.distance * 0.0015;
    cameraRig.target.x += (-Math.cos(cameraRig.yaw) * dx + Math.sin(cameraRig.yaw) * dy) * pan;
    cameraRig.target.z += (Math.sin(cameraRig.yaw) * dx + Math.cos(cameraRig.yaw) * dy) * pan;
    cameraRig.target.x = clamp(cameraRig.target.x, -10, 10);
    cameraRig.target.z = clamp(cameraRig.target.z, -7, 7);
  } else if (pointerState.moved > 3) {
    cameraRig.yaw -= dx * 0.0046;
    cameraRig.desiredPitch = clamp(cameraRig.desiredPitch - dy * 0.0042, -1.12, 1.16);
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (pointerState.down && pointerState.moved < 6 && pointerState.button === 0) {
    const clickedAnt = antAtPointer(event.clientX, event.clientY);
    if (clickedAnt) selectAnt(clickedAnt);
    else if (viewState.undergroundBlend < 0.42) {
      const p = groundPoint(event.clientX, event.clientY);
      if (p) {
        if (pointerState.shift || event.shiftKey) addObstacle(p.x, p.z);
        else addFood(p.x, p.z, random() < 0.18 ? 'berry' : 'crumb', Math.floor(rand(35, 62)), rand(1.15, 1.55));
      }
    }
  }
  pointerState.down = false;
  cameraRig.idle = 0;
});

canvas.addEventListener('dblclick', (event) => {
  if (viewState.undergroundBlend >= 0.42) return;
  const p = groundPoint(event.clientX, event.clientY);
  if (p) {
    cameraRig.target.x = p.x;
    cameraRig.target.z = p.z;
    cameraRig.desiredDistance = Math.min(cameraRig.desiredDistance, 12.5);
  }
});

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  cameraRig.desiredDistance = clamp(cameraRig.desiredDistance * Math.exp(event.deltaY * 0.001), 7.5, 32);
  cameraRig.idle = 0;
}, { passive: false });
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

window.addEventListener('keydown', async (event) => {
  heldKeys.add(event.code);
  if (event.key.toLowerCase() === 'r') startRain(14);
  if (event.key.toLowerCase() === 'p' && !event.repeat && !predator.active) startPredatorVisit(true);
  if (event.key.toLowerCase() === 'o' && !event.repeat && !spider.active) startSpiderVisit();
  if (event.key.toLowerCase() === 'l' && !event.repeat) {
    weather.rainTimer = 0;
    weather.rain = 0;
    weather.postRainHumidity = 1;
    openNuptialFlight(true);
  }
  if (event.key.toLowerCase() === 'n' && !event.repeat) cycleFocusedColony();
  if (event.key.toLowerCase() === 'b' && !event.repeat) {
    followingSelected = false;
    const goingBelow = cameraRig.desiredPitch > -0.1;
    cameraRig.desiredPitch = goingBelow ? -0.32 : 0.78;
    cameraRig.desiredDistance = goingBelow ? (focusedColony()?.undergroundDistance || 10.8) : 24;
    if (goingBelow) {
      cameraRig.yaw = 1.22;
      focusCameraOnColony(focusedColony(), false);
    }
  }
  if (event.key.toLowerCase() === 'f') {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    else await document.exitFullscreen?.();
  }
  if ((event.key === ']' || event.key === '=' || event.key === '+') && !event.repeat) {
    event.preventDefault();
    changeTimeScale(1);
  }
  if ((event.key === '[' || event.key === '-' || event.key === '_') && !event.repeat) {
    event.preventDefault();
    changeTimeScale(-1);
  }
  if (event.key === '0' && !event.repeat) {
    simSpeedIndex = 2;
    timeScale = 1;
    showTimeScale();
  }
  if (event.key === 'Escape') selectAnt(null);
  if (event.key === ' ') {
    event.preventDefault();
    if (!event.repeat) {
      paused = !paused;
      showTimeScale(paused ? 'TIME PAUSED' : `TIME ×${timeScale}`);
    }
  }
});
window.addEventListener('keyup', (event) => heldKeys.delete(event.code));

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
}
window.addEventListener('resize', resize);
document.addEventListener('fullscreenchange', resize);

// Deterministic hooks used by automated observation and interaction tests.
window.advanceTime = (ms) => {
  const steps = Math.max(1, Math.round((ms / 1000) * timeScale / FIXED_DT));
  for (let i = 0; i < steps; i++) update(FIXED_DT);
  updateCamera(ms / 1000);
  render();
};

function findWorkerByIdentity(identity) {
  const raw = String(identity ?? '').trim();
  const normalized = raw.toUpperCase();
  if (normalized.startsWith('S')) return rivalAnts.find((worker) => worker.id === Number(normalized.slice(1))) || null;
  if (normalized.startsWith('A')) return ants.find((worker) => worker.id === Number(normalized.slice(1))) || null;
  const byColonyUid = /^([A-Z]+)[-:]W?(\d+)$/.exec(normalized);
  if (byColonyUid) {
    const colony = getColony(byColonyUid[1].toLowerCase());
    return colony?.workers.find((worker) => worker.id === Number(byColonyUid[2])) || null;
  }
  return ants.find((worker) => worker.id === Number(raw)) || null;
}

window.selectAntById = (id) => selectAnt(findWorkerByIdentity(id));
window.focusColonyById = (id) => focusCameraOnColony(getColony(String(id)));

function registeredColonySummary(colony) {
  const livingWorkers = colony.workers.filter((worker) => worker.alive !== false);
  const reproduction = colony.reproduction;
  return {
    id: colony.id,
    lineageId: colony.lineageId,
    name: colony.displayName,
    speciesProfile: colony.speciesProfile,
    status: colony.status,
    foundedBy: colony.foundedBy,
    ageYears: Number((colony.ageAtStartYears + Math.max(0, simTime - (colony.foundedAt || 0)) / (92 * SEASONS.length)).toFixed(2)),
    nest: { x: colony.nest.x, z: colony.nest.y },
    queen: { id: colony.queen.id, alive: colony.queen.alive, genome: colony.queen.genome },
    workers: livingWorkers.length,
    capacity: colony.maxWorkers,
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
      sexualEggsLaid: reproduction.sexualEggsLaid,
      adultMales: reproduction.alates.filter((alate) => alate.destiny === 'male').length,
      adultGynes: reproduction.alates.filter((alate) => alate.destiny === 'gyne').length,
      malesLaunched: reproduction.malesLaunched,
      gynesLaunched: reproduction.gynesLaunched,
      matedGynes: reproduction.matedGynes,
      livingFoundresses: colony.queen?.foundingStage && colony.queen.alive ? 1
        : regionalMating.matedQueens.filter((queen) => queen.natalColonyId === colony.id && queen.alive).length,
    } : null,
    youngColony: colony.queen?.foundingStage ? {
      stage: colony.queen.foundingStage,
      queenHealth: Number((colony.queen.queenHealth || 0).toFixed(1)),
      chamberOpen: Number((colony.queen.entranceOpenProgress || 0).toFixed(2)),
      surfaceWorkers: colony.workers.filter((worker) => worker.alive && !worker.insideNest).length,
      foodDelivered: colony.queen.foodDelivered || 0,
      workerDeaths: colony.queen.workerDeaths || 0,
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
    workersEclosed: colony.workersEclosed,
    deaths: colony.deaths,
    genetics: {
      livingAverage: averageGenome(livingWorkers),
      generations: livingWorkers.reduce((counts, worker) => {
        counts[`G${worker.generation}`] = (counts[`G${worker.generation}`] || 0) + 1;
        return counts;
      }, {}),
    },
  };
}

window.render_game_to_text = () => {
  const carrying = ants.filter((ant) => ant.carrying).length;
  const insideNest = ants.filter((ant) => ant.insideNest).length;
  const states = {};
  for (const ant of ants) states[ant.state] = (states[ant.state] || 0) + 1;
  return JSON.stringify({
    mode: paused ? 'paused' : 'observing',
    timeScale,
    coordinateSystem: 'origin at scene center; +x right/east, +z toward camera/south, negative y descends into the nest',
    timeSeconds: Number(simTime.toFixed(1)),
    weather: weather.rain > 0.6 ? 'rain' : weather.rain > 0.08 ? 'drizzle' : 'clear',
    rainIntensity: Number(weather.rain.toFixed(2)),
    postRainHumidity: Number(weather.postRainHumidity.toFixed(2)),
    population: {
      speciesProfile: SPECIES_PROFILE,
      focusedColonyId: cameraRig.focusedColonyId,
      activeColonies: livingColonies().length,
      totalWorkers: totalActiveWorkers(),
      globalWorkerCapacity: MAX_ACTIVE_WORKERS,
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
        state: environment.season.name === 'winter' ? 'winter pause'
          : environment.pressure === 'disease outbreak' ? 'outbreak pause'
            : storedFood > 22 ? 'laying' : 'food-limited',
        eggsLaid: queenEggsLaid,
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
    })),
    environment: {
      season: environment.season.name,
      seasonProgress: Number(environment.seasonProgress.toFixed(2)),
      pressure: environment.pressure,
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
      queen: { state: environment.season.name === 'winter' ? 'winter pause' : rivalColony.storedFood > 24 ? 'laying' : 'food-limited', eggsLaid: rivalColony.eggsLaid },
      workers: rivalAnts.length,
      roles: {
        foragers: rivalAnts.filter((rival) => rival.role === 'forager').length,
        scouts: rivalAnts.filter((rival) => rival.role === 'scout').length,
        guards: rivalAnts.filter((rival) => rival.role === 'guard').length,
        transfers: rivalAnts.filter((rival) => rival.role === 'transfer').length,
      },
      brood: {
        total: rivalBrood.length,
        eggs: rivalBrood.filter((item) => item.stage === 'egg').length,
        larvae: rivalBrood.filter((item) => item.stage === 'larva').length,
        pupae: rivalBrood.filter((item) => item.stage === 'pupa').length,
        workers: rivalBrood.filter((item) => item.destiny === 'worker').length,
        males: rivalBrood.filter((item) => item.destiny === 'male').length,
        gynes: rivalBrood.filter((item) => item.destiny === 'gyne').length,
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
          },
          nanitics: queen.nanitics?.length || 0,
          surfaceWorkers: queen.nanitics?.filter((worker) => worker.alive && !worker.insideNest).length || 0,
          workerDeaths: queen.workerDeaths || 0,
          registeredColonyId: queen.registeredColonyId,
          failureCause: queen.failureCause || null,
          collapseCause: queen.collapseCause || null,
        },
        state: queen.state,
      })),
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
      cargo: selectedAnt.transferCargo ? 'cached food transfer' : selectedAnt.sanitationCargo ? 'colony remains' : selectedAnt.soilCargo ? 'soil' : selectedAnt.carrying ? 'food' : 'none',
      trips: selectedAnt.trips || 0,
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
      activelyDigging: ants.filter((ant) => ant.nestMode === 'digging').length,
      haulingSoil: ants.filter((ant) => ant.soilCargo).length,
      spoilDeposits: excavatedSoil,
    },
    underground: {
      focus: focusedColony()?.displayName || 'unregistered colony',
      focusedColonyId: cameraRig.focusedColonyId,
      rivalArchitecture: { tunnels: rivalNestCurves.length, broodVisible: rivalBrood.length, alatesVisible: rivalReproduction.alates.length, queenVisible: true },
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
  });
};

renderAnts();
updateCamera(0);
render();

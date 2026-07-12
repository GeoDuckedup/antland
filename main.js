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
const FIXED_DT = 1 / 30;
const MAX_ANTS = 260;
const MAX_RIVALS = 120;
const PHER_W = 92;
const PHER_H = 70;
let selectedAnt = null;
let followingSelected = false;

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
  rivalNestFocus: false,
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
const pheromone = new Float32Array(PHER_W * PHER_H);
const pheromoneNext = new Float32Array(PHER_W * PHER_H);
const rivalPheromone = new Float32Array(PHER_W * PHER_H);
const rivalPheromoneNext = new Float32Array(PHER_W * PHER_H);

function pherIndex(x, z) {
  const gx = clamp(Math.floor(((x + HALF_W) / WORLD_W) * PHER_W), 0, PHER_W - 1);
  const gz = clamp(Math.floor(((z + HALF_D) / WORLD_D) * PHER_H), 0, PHER_H - 1);
  return gz * PHER_W + gx;
}

function pherSample(x, z) { return pheromone[pherIndex(x, z)]; }
function pherDeposit(x, z, amount) {
  const index = pherIndex(x, z);
  pheromone[index] = Math.min(1.8, pheromone[index] + amount);
  const gx = index % PHER_W;
  const gz = Math.floor(index / PHER_W);
  const spread = amount * 0.18;
  if (gx > 0) pheromone[index - 1] = Math.min(1.8, pheromone[index - 1] + spread);
  if (gx < PHER_W - 1) pheromone[index + 1] = Math.min(1.8, pheromone[index + 1] + spread);
  if (gz > 0) pheromone[index - PHER_W] = Math.min(1.8, pheromone[index - PHER_W] + spread);
  if (gz < PHER_H - 1) pheromone[index + PHER_W] = Math.min(1.8, pheromone[index + PHER_W] + spread);
}

function rivalPherSample(x, z) { return rivalPheromone[pherIndex(x, z)]; }
function rivalPherDeposit(x, z, amount) {
  const index = pherIndex(x, z);
  rivalPheromone[index] = Math.min(1.8, rivalPheromone[index] + amount);
  const gx = index % PHER_W;
  const gz = Math.floor(index / PHER_W);
  const spread = amount * 0.16;
  if (gx > 0) rivalPheromone[index - 1] = Math.min(1.8, rivalPheromone[index - 1] + spread);
  if (gx < PHER_W - 1) rivalPheromone[index + 1] = Math.min(1.8, rivalPheromone[index + 1] + spread);
  if (gz > 0) rivalPheromone[index - PHER_W] = Math.min(1.8, rivalPheromone[index - PHER_W] + spread);
  if (gz < PHER_H - 1) rivalPheromone[index + PHER_W] = Math.min(1.8, rivalPheromone[index + PHER_W] + spread);
}

function updatePheromones(dt) {
  const rainWash = 1 + weather.rain * 5.4;
  const decay = Math.max(0, 1 - dt * 0.053 * rainWash);
  for (let y = 1; y < PHER_H - 1; y++) {
    for (let x = 1; x < PHER_W - 1; x++) {
      const i = y * PHER_W + x;
      const neighbors = (pheromone[i - 1] + pheromone[i + 1] + pheromone[i - PHER_W] + pheromone[i + PHER_W]) * 0.25;
      pheromoneNext[i] = (pheromone[i] * 0.965 + neighbors * 0.035) * decay;
    }
  }
  pheromone.set(pheromoneNext);
  for (let y = 1; y < PHER_H - 1; y++) {
    for (let x = 1; x < PHER_W - 1; x++) {
      const i = y * PHER_W + x;
      const neighbors = (rivalPheromone[i - 1] + rivalPheromone[i + 1] + rivalPheromone[i - PHER_W] + rivalPheromone[i + PHER_W]) * 0.25;
      rivalPheromoneNext[i] = (rivalPheromone[i] * 0.965 + neighbors * 0.035) * decay;
    }
  }
  rivalPheromone.set(rivalPheromoneNext);
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
const requestedSeasonOffset = clamp(Number(new URLSearchParams(window.location.search).get('season')) || 0, 0, SEASONS.length - 1);
const predatorsDisabled = new URLSearchParams(window.location.search).get('predator') === '0';
const requestedRivalNestFocus = new URLSearchParams(window.location.search).get('nest') === 'rival';
cameraRig.rivalNestFocus = requestedRivalNestFocus;

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
  undergroundGroup.add(tunnel);

  const chamber = new THREE.Group();
  const chamberGeometry = new THREE.SphereGeometry(1, 22, 14);
  chamber.add(
    new THREE.Mesh(chamberGeometry, chamberFillMaterial),
    new THREE.Mesh(chamberGeometry, chamberWireMaterial),
  );
  chamber.position.copy(points[points.length - 1]);
  chamber.scale.setScalar(0.001);
  chamber.visible = false;
  undergroundGroup.add(chamber);

  const tip = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius * 0.72, 1),
    new THREE.MeshBasicMaterial({ color: 0x9b5e36, transparent: true, opacity: 0.58, fog: false }),
  );
  tip.visible = false;
  undergroundGroup.add(tip);

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
  undergroundGroup.add(face);

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
const NEST_ROUTES = {
  nursery: { label: 'nursery chamber', legs: [nestLeg(0, 0, nurseryJoin), nestLeg(1)] },
  stores: { label: 'food stores', legs: [nestLeg(0, 0, storesJoin), nestLeg(2)] },
  rest: { label: 'deep resting chamber', legs: [nestLeg(0), nestLeg(3)] },
};

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
    const scale = item.stage === 'egg' ? 0.08 : item.stage === 'larva' ? 0.115 : 0.14;
    mesh.scale.set(scale, scale * (item.stage === 'egg' ? 1.35 : 0.72), scale * 0.8);
    mesh.material.color.setHex(item.stage === 'egg' ? 0xe7ece2 : item.stage === 'larva' ? 0xcdd9cb : 0x9dafaa);
    mesh.visible = true;
  }
  for (let i = visible; i < rivalBroodPool.length; i++) rivalBroodPool[i].visible = false;
}

undergroundGroup.add(new THREE.AmbientLight(0x9a735a, 1.2));
const nestGlowA = new THREE.PointLight(0xe09a58, 22, 13, 2);
nestGlowA.position.set(-5.2, -3.8, -0.8);
undergroundGroup.add(nestGlowA);
const nestGlowB = new THREE.PointLight(0x7b8fc2, 15, 15, 2);
nestGlowB.position.set(-3.5, -9.2, 0.4);
undergroundGroup.add(nestGlowB);

const digMoteCount = 96;
const digMoteData = new Float32Array(digMoteCount * 3);
const digMoteGeometry = new THREE.BufferGeometry();
digMoteGeometry.setAttribute('position', new THREE.BufferAttribute(digMoteData, 3));
const digMotes = new THREE.Points(digMoteGeometry, new THREE.PointsMaterial({
  color: 0xffcc7b, size: 0.075, transparent: true, opacity: 0.66, depthWrite: false, fog: false,
}));
digMotes.visible = false;
undergroundGroup.add(digMotes);

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
  undergroundGroup.add(sprite);
  return sprite;
});

const undergroundSoilPool = Array.from({ length: 64 }, () => {
  const pellet = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.095, 0),
    new THREE.MeshBasicMaterial({ color: 0xb47748, fog: false, depthTest: false }),
  );
  pellet.visible = false;
  pellet.renderOrder = 9;
  undergroundGroup.add(pellet);
  return pellet;
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
undergroundGroup.add(queenSprite);

const queenHalo = new THREE.Mesh(
  new THREE.RingGeometry(0.58, 0.67, 30),
  new THREE.MeshBasicMaterial({ color: 0xe9b66d, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthTest: false, fog: false }),
);
queenHalo.position.copy(nurseryCenter).add(new THREE.Vector3(-0.22, -0.12, 0));
queenHalo.rotation.x = Math.PI / 2;
queenHalo.renderOrder = 9;
undergroundGroup.add(queenHalo);

const broodPool = Array.from({ length: 96 }, () => {
  const brood = new THREE.Mesh(
    new THREE.SphereGeometry(1, 10, 7),
    new THREE.MeshBasicMaterial({ color: 0xf1dfb6, fog: false, depthTest: false }),
  );
  brood.visible = false;
  brood.renderOrder = 9;
  undergroundGroup.add(brood);
  return brood;
});

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
    mesh.scale.copy(stageScale).multiplyScalar(0.94 + Math.sin(simTime * 1.5 + item.id) * 0.035);
    mesh.material.color.setHex(item.stage === 'egg' ? 0xf4e7c6 : item.stage === 'larva' ? 0xe9cf9f : 0xc9a879);
    mesh.visible = true;
  }
  for (let i = visibleBrood; i < broodPool.length; i++) broodPool[i].visible = false;
}

function updateUnderground() {
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
  }
  for (let i = visibleNestAnts; i < undergroundSpritePool.length; i++) undergroundSpritePool[i].visible = false;
  for (let i = visibleSoilLoads; i < undergroundSoilPool.length; i++) undergroundSoilPool[i].visible = false;
  updateBiologicalVisuals();
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
const GENE_KEYS = ['speed', 'size', 'diseaseResistance', 'aggression', 'foraging'];
const homeQueenGenome = { speed: 1.02, size: 0.98, diseaseResistance: 1.1, aggression: 0.9, foraging: 1.0 };
const rivalQueenGenome = { speed: 0.96, size: 1.05, diseaseResistance: 0.9, aggression: 1.18, foraging: 1.12 };

function mutateGenome(base, amount = 0.055) {
  const genome = {};
  for (const key of GENE_KEYS) genome[key] = clamp(base[key] + rand(-amount, amount), 0.72, 1.3);
  return genome;
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

function addBrood(stage = 'egg', stageAge = 0, genome = mutateGenome(homeQueenGenome), generation = 1) {
  if (brood.length >= broodPool.length || ants.length + brood.length >= MAX_ANTS + 40) return null;
  const item = { id: nextBroodId++, stage, stageAge, care: rand(0.82, 1.08), genome, generation };
  brood.push(item);
  return item;
}

function chooseNestPurpose(ant) {
  if (ant.carrying) return 'stores';
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
  if (ants.length >= MAX_ANTS) return null;
  const angle = rand(0, Math.PI * 2);
  const ageDays = options.ageDays ?? rand(7, 47);
  const genome = options.genome || mutateGenome(homeQueenGenome, initialPopulation ? 0.09 : 0.055);
  const workerCaste = options.workerCaste || (random() < 0.13 ? 'major' : random() < 0.44 ? 'minor' : 'media');
  const casteScale = workerCaste === 'major' ? 1.12 : workerCaste === 'minor' ? 0.9 : 1;
  const ant = {
    id: nextAntId++,
    x: NEST.x + Math.cos(angle) * rand(0.56, 0.82),
    z: NEST.y + Math.sin(angle) * rand(0.56, 0.82),
    heading: angle,
    desired: angle,
    carrying: false,
    carryingNutrition: 1,
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
  remains.push({ mesh, life: 48, x: ant.x, z: ant.z, colony: ant.colony || 'formicarium' });
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
    if (!rival.alive) continue;
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
        if (target.colony === 'rival') {
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

function markRivalDead(rival, cause = 'territorial conflict') {
  if (!rival.alive) return;
  rival.alive = false;
  rival.deathCause = cause;
  rivalColony.deaths++;
  if (cause === 'territorial conflict') rivalColony.rivalCasualties++;
  leaveWorkerRemains(rival);
}

function spawnRival(newborn = false, options = {}) {
  if (rivalAnts.length >= MAX_RIVALS) return null;
  const angle = rand(0, Math.PI * 2);
  const radius = newborn ? rand(0.4, 0.75) : Math.sqrt(random()) * rand(1.2, 8.5);
  const roleRoll = random();
  const genome = options.genome || mutateGenome(rivalQueenGenome, newborn ? 0.055 : 0.09);
  const rival = {
    id: nextRivalId++,
    colony: 'rival',
    x: clamp(RIVAL_NEST.x + Math.cos(angle) * radius, -HALF_W + 0.5, HALF_W - 0.5),
    z: clamp(RIVAL_NEST.y + Math.sin(angle) * radius * 0.78, -HALF_D + 0.5, HALF_D - 0.5),
    heading: angle,
    desired: angle,
    phase: rand(0, 10),
    speed: rand(0.82, 1.16) * genome.speed,
    size: (roleRoll < 0.18 ? rand(1.03, 1.16) : rand(0.82, 1.02)) * genome.size,
    role: roleRoll < 0.18 ? 'guard' : roleRoll < 0.32 ? 'scout' : 'forager',
    health: clamp((newborn ? 82 : rand(84, 100)) + (genome.diseaseResistance - 1) * 10, 72, 100),
    genome,
    generation: options.generation || 0,
    carrying: false,
    carryingNutrition: 1,
    targetFood: null,
    turnClock: rand(0.2, 1.5),
    fightCooldown: rand(0, 0.8),
    alive: true,
    state: newborn ? 'newly eclosed' : 'patrolling rival territory',
  };
  rivalAnts.push(rival);
  return rival;
}

function addRivalBrood(stage = 'egg', stageAge = 0, genome = mutateGenome(rivalQueenGenome), generation = 1) {
  if (rivalBrood.length >= 54) return;
  rivalBrood.push({ stage, stageAge, vigor: rand(0.88, 1.1), genome, generation });
}

for (let i = 0; i < 68; i++) spawnRival(false);
for (let i = 0; i < 6; i++) addRivalBrood('egg', rand(0, BROOD_STAGE_SECONDS.egg));
for (let i = 0; i < 7; i++) addRivalBrood('larva', rand(0, BROOD_STAGE_SECONDS.larva));
for (let i = 0; i < 5; i++) addRivalBrood('pupa', rand(0, BROOD_STAGE_SECONDS.pupa));

function moveRival(rival, dt, speedFactor = 1) {
  const turnRate = dt * 4.2;
  rival.heading += clamp(wrapAngle(rival.desired - rival.heading), -turnRate, turnRate);
  const speed = rival.speed * speedFactor * (1 - weather.rain * 0.22) * webSlowAt(rival.x, rival.z);
  rival.x = clamp(rival.x + Math.cos(rival.heading) * speed * dt, -HALF_W + 0.35, HALF_W - 0.35);
  rival.z = clamp(rival.z + Math.sin(rival.heading) * speed * dt, -HALF_D + 0.35, HALF_D - 0.35);
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
  rival.turnClock -= dt;
  rival.fightCooldown -= dt;

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
      rival.carrying = false;
      rivalColony.storedFood = Math.min(150, rivalColony.storedFood + 2.4 * rival.carryingNutrition);
      rivalColony.delivered++;
      rival.targetFood = null;
      rival.state = 'unloading rival stores';
    }
    moveRival(rival, dt, 1.08);
    return;
  }

  const pickup = nearestRivalFood(rival);
  if (pickup) {
    rival.carrying = true;
    rival.carryingNutrition = pickup.nutrition;
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
  rivalColony.roleClock -= dt;
  if (rivalColony.roleClock <= 0) {
    const guardTarget = clamp(Math.round(rivalAnts.length * 0.16), 7, 18);
    const scoutTarget = clamp(Math.round(rivalAnts.length * 0.14), 6, 16);
    const guards = rivalAnts.filter((rival) => rival.role === 'guard');
    const scouts = rivalAnts.filter((rival) => rival.role === 'scout');
    const promotable = rivalAnts
      .filter((rival) => rival.role === 'forager')
      .sort((a, b) => b.health - a.health || b.size - a.size);
    for (let i = guards.length; i < guardTarget && promotable.length > 0; i++) promotable.shift().role = 'guard';
    for (let i = scouts.length; i < scoutTarget && promotable.length > 0; i++) promotable.shift().role = 'scout';
    rivalColony.roleClock = 5;
  }
  for (let i = rivalBrood.length - 1; i >= 0; i--) {
    const item = rivalBrood[i];
    let development = item.vigor * (rivalColony.storedFood > 8 ? 0.9 : 0.3);
    if (item.stage === 'larva') rivalColony.storedFood = Math.max(0, rivalColony.storedFood - dt * 0.0065);
    item.stageAge += dt * development;
    if (item.stageAge < BROOD_STAGE_SECONDS[item.stage]) continue;
    if (item.stage === 'egg') { item.stage = 'larva'; item.stageAge = 0; }
    else if (item.stage === 'larva') { item.stage = 'pupa'; item.stageAge = 0; }
    else {
      rivalBrood.splice(i, 1);
      if (spawnRival(true, { genome: item.genome, generation: item.generation })) rivalColony.workersEclosed++;
    }
  }
  rivalColony.layClock -= dt;
  if (rivalColony.layClock <= 0) {
    if (rivalColony.storedFood > 24 && rivalBrood.length < 48 && environment.season.name !== 'winter') {
      addRivalBrood('egg');
      rivalColony.eggsLaid++;
      rivalColony.storedFood -= 0.6;
    }
    rivalColony.layClock = rand(14, 21);
  }

  for (const rival of rivalAnts) updateRivalAnt(rival, dt);
  for (let i = rivalAnts.length - 1; i >= 0; i--) if (!rivalAnts[i].alive) rivalAnts.splice(i, 1);
  for (let i = 0; i < rivalAnts.length; i++) {
    const rival = rivalAnts[i];
    for (let j = i + 1; j < rivalAnts.length; j++) {
      const other = rivalAnts[j];
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
  const careRatio = clamp(activeNurses / requiredNurses, 0.35, 1.18);
  for (let i = brood.length - 1; i >= 0; i--) {
    const item = brood[i];
    let development = 0.58 + careRatio * 0.48;
    if (item.stage === 'larva') {
      const ration = Math.min(storedFood, dt * 0.0085);
      storedFood -= ration;
      if (ration < dt * 0.006) {
        development *= 0.32;
        colonyBiology.starvedLarvae++;
      }
    }
    item.care = clamp(item.care + dt * (careRatio - 0.72) * 0.008, 0.62, 1.16);
    item.stageAge += dt * development * item.care;
    if (item.stageAge < BROOD_STAGE_SECONDS[item.stage]) continue;
    if (item.stage === 'egg') {
      item.stage = 'larva';
      item.stageAge = 0;
    } else if (item.stage === 'larva') {
      item.stage = 'pupa';
      item.stageAge = 0;
    } else {
      brood.splice(i, 1);
      if (ants.length < MAX_ANTS) {
        spawnAnt(false, { newborn: true, ageDays: 0, genome: item.genome, generation: item.generation });
        workersEclosed++;
      }
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
      for (let i = 0; i < clutch; i++) if (addBrood()) queenEggsLaid++;
      storedFood = Math.max(0, storedFood - clutch * 0.7);
    }
    queenLayClock = rand(13, 20) * (storedFood < 45 ? 1.35 : 1);
  }
}

let laborClock = 99;
const colonyLabor = {
  targetForagers: 0, targetNurses: 0, targetExcavators: 0, targetSanitizers: 0,
  assignedForagers: 0, assignedNurses: 0, assignedExcavators: 0, assignedSanitizers: 0,
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
  const targetSanitizers = remains.length > 0 ? clamp(Math.ceil(remains.length / 3), 2, 6) : 0;
  const targetForagers = Math.max(ants.length - targetNurses - targetExcavators, Math.round(ants.length * (0.48 + foodPressure * 0.22)));
  colonyLabor.targetExcavators = targetExcavators;
  colonyLabor.targetNurses = targetNurses;
  colonyLabor.targetSanitizers = targetSanitizers;
  colonyLabor.targetForagers = Math.min(ants.length, targetForagers);

  const committed = ants.filter((ant) => ant.assignedRole === 'excavator' && (ant.soilCargo || ant.nestRouteKey === 'excavation'));
  for (const ant of ants) {
    if (ant.soilCargo || ant.sanitationCargo || ant.nestRouteKey === 'excavation') continue;
    ant.assignedRole = 'forager';
  }
  const nurseCandidates = ants
    .filter((ant) => !ant.carrying && !ant.soilCargo && !ant.sanitationCargo && ant.nestRouteKey !== 'excavation')
    .sort((a, b) => {
      const aScore = (workerMaturity(a.ageDays) === 'callow' ? 7 : 0) + (a.tendency === 'nurse' ? 4 : 0) + (a.insideNest ? 2 : 0) - a.ageDays * 0.035;
      const bScore = (workerMaturity(b.ageDays) === 'callow' ? 7 : 0) + (b.tendency === 'nurse' ? 4 : 0) + (b.insideNest ? 2 : 0) - b.ageDays * 0.035;
      return bScore - aScore;
    });
  for (let i = 0; i < Math.min(targetNurses, nurseCandidates.length); i++) nurseCandidates[i].assignedRole = 'nurse';

  const candidates = ants
    .filter((ant) => !ant.carrying && !ant.soilCargo && !ant.sanitationCargo && ant.nestRouteKey !== 'excavation')
    .sort((a, b) => {
      const aScore = (a.nestRouteKey === 'excavation' ? 5 : 0) + (a.tendency === 'excavator' ? 3 : 0) + (a.insideNest ? 1 : 0);
      const bScore = (b.nestRouteKey === 'excavation' ? 5 : 0) + (b.tendency === 'excavator' ? 3 : 0) + (b.insideNest ? 1 : 0);
      return bScore - aScore || b.energy - a.energy;
    });
  const excavationCandidates = candidates.filter((ant) => (ant.assignedRole !== 'nurse' || ants.length < 24) && ant.assignedRole !== 'sanitizer');
  const additionalNeeded = Math.max(0, targetExcavators - committed.length);
  for (let i = 0; i < Math.min(additionalNeeded, excavationCandidates.length); i++) excavationCandidates[i].assignedRole = 'excavator';
  const committedSanitizers = ants.filter((ant) => ant.sanitationCargo).length;
  const sanitationCandidates = candidates
    .filter((ant) => ant.assignedRole === 'forager' && !ant.carrying && !ant.insideNest)
    .sort((a, b) => b.health - a.health || a.ageDays - b.ageDays);
  const sanitationNeeded = Math.max(0, targetSanitizers - committedSanitizers);
  for (let i = 0; i < Math.min(sanitationNeeded, sanitationCandidates.length); i++) sanitationCandidates[i].assignedRole = 'sanitizer';
  colonyLabor.assignedForagers = ants.filter((ant) => ant.assignedRole === 'forager').length;
  colonyLabor.assignedNurses = ants.filter((ant) => ant.assignedRole === 'nurse').length;
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
      const productivity = 0.78 + ant.energy * 0.004 + (ant.tendency === 'excavator' ? 0.18 : 0);
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
      ant.state = 'carrying excavated soil outward';
    }
    return;
  }

  if (ant.nestMode === 'working') {
    ant.nestTimer -= dt;
    ant.state = ant.nestRouteKey === 'stores' ? 'unloading in food stores'
      : ant.nestRouteKey === 'nursery' ? 'tending brood' : 'resting in deep chamber';
    if (ant.pendingDelivery) {
      ant.pendingDelivery = false;
      ant.carrying = false;
      delivered++;
      storedFood = Math.min(180, storedFood + 2.5 * ant.carryingNutrition);
      ant.carryingNutrition = 1;
      ant.tasksCompleted++;
      ant.nestTimer = Math.max(ant.nestTimer, rand(1.6, 3.2));
    }
    if (weather.rain > 0.38 && ant.nestRouteKey === 'rest') ant.nestTimer = Math.max(ant.nestTimer, 1.2);
    if (ant.nestTimer <= 0) {
      if (ant.nestRouteKey === 'nursery' && ant.assignedRole === 'nurse' && brood.length > 0) {
        ant.nestTimer = rand(4.5, 9.5);
        ant.tasksCompleted++;
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
    if (ant.nestLeg < 0) emergeFromNest(ant);
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
      beginNestJourney(ant, 'stores');
      return;
    }
  } else {
    const food = nearestFood(ant);
    if (food) {
      ant.carrying = true;
      ant.carryingNutrition = food.nutrition;
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
  let carryingCount = 0;
  const pos = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const groundTilt = new THREE.Quaternion();
  const headingSpin = new THREE.Quaternion();
  const normal = new THREE.Vector3();
  for (const rival of rivalAnts) {
    if (!rival.alive) continue;
    const frame = Math.floor(rival.phase) % 4;
    const index = frameCounts[frame]++;
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
    const below = ant.insideNest;
    cameraRig.desiredPitch = below ? -0.32 : 0.72;
    cameraRig.desiredDistance = below ? 8.8 : Math.min(cameraRig.desiredDistance, 11.5);
    updateAntNote();
  }
}

function updateAntNote() {
  if (!selectedAnt) return;
  const location = selectedAnt.insideNest
    ? antNestRoute(selectedAnt)?.label || 'nest passage'
    : 'surface';
  antNoteTitle.textContent = `Worker A${String(selectedAnt.id).padStart(3, '0')}`;
  antNoteTask.textContent = selectedAnt.state;
  antNoteFacts.innerHTML = `
    <dt>assignment</dt><dd>${selectedAnt.assignedRole || selectedAnt.tendency}</dd>
    <dt>tendency</dt><dd>${selectedAnt.tendency}</dd>
    <dt>generation</dt><dd>G${selectedAnt.generation}</dd>
    <dt>traits</dt><dd>${selectedAnt.genome.speed.toFixed(2)} speed · ${selectedAnt.genome.diseaseResistance.toFixed(2)} resilience</dd>
    <dt>maturity</dt><dd>${workerMaturity(selectedAnt.ageDays)}</dd>
    <dt>caste</dt><dd>${selectedAnt.workerCaste} worker</dd>
    <dt>location</dt><dd>${location}</dd>
    <dt>age</dt><dd>${selectedAnt.ageDays.toFixed(1)} days</dd>
    <dt>energy</dt><dd>${Math.round(selectedAnt.energy)}%</dd>
    <dt>health</dt><dd>${Math.round(selectedAnt.health)}%</dd>
    <dt>condition</dt><dd>${selectedAnt.infection > 0 ? `infected ${Math.round(selectedAnt.infection * 100)}%` : selectedAnt.health < 70 ? 'injured' : 'healthy'}</dd>
    <dt>cargo</dt><dd>${selectedAnt.sanitationCargo ? 'colony remains' : selectedAnt.soilCargo ? 'excavated soil' : selectedAnt.carrying ? 'food fragment' : 'none'}</dd>
    ${selectedAnt.excavationProject != null ? `<dt>worksite</dt><dd>${tunnelSegments[selectedAnt.excavationProject].name}</dd>` : ''}
    <dt>completed</dt><dd>${selectedAnt.tasksCompleted}</dd>
    <dt>nest trips</dt><dd>${selectedAnt.trips}</dd>`;
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
const weather = { rain: 0, rainTimer: 0, nextRain: 38 };
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
  if (simTime > weather.nextRain && weather.rainTimer <= 0) startRain(rand(9, 15) * environment.season.rain);
  if (weather.rainTimer > 0) weather.rainTimer -= dt;
  const target = weather.rainTimer > 0 ? 1 : 0;
  weather.rain += (target - weather.rain) * dt * (target ? 0.55 : 0.28);
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
  updatePheromones(dt);
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
    followingSelected && selectedAnt?.insideNest ? selectedAnt.nestPosition.y : -5.35,
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
    const hits = raycaster.intersectObjects(antMeshes, false);
    for (const hit of hits) {
      const frame = antMeshes.indexOf(hit.object);
      const ant = antInstanceLookup[frame]?.[hit.instanceId];
      if (ant) return ant;
    }
  } else {
    const hit = raycaster.intersectObjects(undergroundSpritePool, false).find((candidate) => candidate.object.visible);
    if (hit) return ants.find((ant) => ant.id === hit.object.userData.antId) || null;
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
  if (event.key.toLowerCase() === 'n' && !event.repeat) {
    cameraRig.rivalNestFocus = !cameraRig.rivalNestFocus;
    const focusNest = cameraRig.rivalNestFocus ? RIVAL_NEST : NEST;
    cameraRig.target.x = focusNest.x + (cameraRig.rivalNestFocus ? -0.4 : 0.8);
    cameraRig.target.z = focusNest.y + 0.25;
    cameraRig.desiredPitch = -0.32;
    cameraRig.desiredDistance = 10.8;
    followingSelected = false;
  }
  if (event.key.toLowerCase() === 'b' && !event.repeat) {
    followingSelected = false;
    const goingBelow = cameraRig.desiredPitch > -0.1;
    cameraRig.desiredPitch = goingBelow ? -0.32 : 0.78;
    cameraRig.desiredDistance = goingBelow ? 10.8 : 24;
    if (goingBelow) {
      cameraRig.yaw = 1.22;
      const focusNest = cameraRig.rivalNestFocus ? RIVAL_NEST : NEST;
      cameraRig.target.x = focusNest.x + (cameraRig.rivalNestFocus ? -0.4 : 0.8);
      cameraRig.target.z = focusNest.y + 0.25;
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
window.selectAntById = (id) => selectAnt(ants.find((ant) => ant.id === Number(id)) || null);

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
        starvedLarvae: colonyBiology.starvedLarvae,
      },
      nursery: { activeNurses: colonyBiology.activeNurses, requiredNurses: colonyBiology.requiredNurses },
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
      },
      brood: {
        total: rivalBrood.length,
        eggs: rivalBrood.filter((item) => item.stage === 'egg').length,
        larvae: rivalBrood.filter((item) => item.stage === 'larva').length,
        pupae: rivalBrood.filter((item) => item.stage === 'pupa').length,
      },
      storedFood: Number(rivalColony.storedFood.toFixed(1)),
      foodDelivered: rivalColony.delivered,
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
    userObstacles: obstacles.filter((o) => o.mesh).map((o) => ({ x: Number(o.x.toFixed(1)), z: Number(o.z.toFixed(1)), radius: Number(o.r.toFixed(1)) })),
    view: viewState.undergroundBlend > 0.5 ? 'underground nest scan' : 'surface colony',
    camera: { distance: Number(cameraRig.distance.toFixed(1)), pitch: Number(cameraRig.pitch.toFixed(2)), targetX: Number(cameraRig.target.x.toFixed(1)), targetY: Number(cameraRig.focusY.toFixed(1)), targetZ: Number(cameraRig.target.z.toFixed(1)) },
    selectedAnt: selectedAnt ? {
      id: `A${String(selectedAnt.id).padStart(3, '0')}`,
      tendency: selectedAnt.tendency,
      assignment: selectedAnt.assignedRole,
      maturity: workerMaturity(selectedAnt.ageDays),
      caste: selectedAnt.workerCaste,
      generation: selectedAnt.generation,
      genome: Object.fromEntries(GENE_KEYS.map((key) => [key, Number(selectedAnt.genome[key].toFixed(3))])),
      task: selectedAnt.state,
      location: selectedAnt.insideNest ? antNestRoute(selectedAnt)?.label : 'surface',
      energy: Math.round(selectedAnt.energy),
      health: Math.round(selectedAnt.health),
      infection: Number(selectedAnt.infection.toFixed(2)),
      cargo: selectedAnt.sanitationCargo ? 'colony remains' : selectedAnt.soilCargo ? 'soil' : selectedAnt.carrying ? 'food' : 'none',
      trips: selectedAnt.trips,
      following: followingSelected,
    } : null,
    labor: {
      targetForagers: colonyLabor.targetForagers,
      assignedForagers: colonyLabor.assignedForagers,
      targetNurses: colonyLabor.targetNurses,
      assignedNurses: colonyLabor.assignedNurses,
      targetSanitizers: colonyLabor.targetSanitizers,
      assignedSanitizers: colonyLabor.assignedSanitizers,
      targetExcavators: colonyLabor.targetExcavators,
      assignedExcavators: colonyLabor.assignedExcavators,
      activelyDigging: ants.filter((ant) => ant.nestMode === 'digging').length,
      haulingSoil: ants.filter((ant) => ant.soilCargo).length,
      spoilDeposits: excavatedSoil,
    },
    underground: {
      focus: cameraRig.rivalNestFocus ? 'rival colony' : 'formicarium colony',
      rivalArchitecture: { tunnels: rivalNestCurves.length, broodVisible: rivalBrood.length, queenVisible: true },
      completeTunnels: tunnelSegments.filter((segment) => segment.progress >= 0.995).length,
      activeDiggingFronts: tunnelSegments.filter((segment) => segment.available && segment.activeDiggers > 0).length,
      overallConstruction: Number((tunnelSegments.reduce((sum, segment) => sum + segment.progress, 0) / tunnelSegments.length).toFixed(2)),
      deepestDepth: 11.9,
      visibleWorkers: ants.filter((ant) => ant.insideNest).length,
      projects: tunnelSegments.slice(4).map((segment) => ({
        name: segment.name,
        progress: Number(segment.progress.toFixed(3)),
        status: segment.progress >= 0.999 ? 'complete' : segment.available ? 'active' : 'waiting',
        diggers: segment.activeDiggers,
      })),
    },
    controls: 'click an ant to select/follow; Esc releases; WASD/arrow keys move; Q/E descend/ascend; drag orbit; B toggles above/below; N switches nest focus; [ and ] change time speed; 0 resets time; right-drag pan; wheel zoom; empty click adds food; shift-click stone; R rain; P hunting beetle; O web spider; space pause; F fullscreen',
  });
};

renderAnts();
updateCamera(0);
render();

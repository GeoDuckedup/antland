import * as THREE from '../../vendor/three.module.js';
import {
  NEST_POSITION,
  PROP_CELLS,
  SOIL_TEXTURE_SEED,
  WORLD_D,
  WORLD_W,
} from '../config/simulation.js';
import { mulberry32 } from '../simulation/random.js';

function makeSoilTexture(renderer, root) {
  const size = 512;
  const canvas = root.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const texRand = mulberry32(SOIL_TEXTURE_SEED);
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
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5.5, 4.2);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

function atlasTexture(source, col, row, cols, rows) {
  const texture = source.clone();
  texture.repeat.set(1 / cols, 1 / rows);
  texture.offset.set(col / cols, 1 - (row + 1) / rows);
  texture.needsUpdate = true;
  return texture;
}

export function createWorldAssets({
  renderer,
  surfaceGroup,
  groundHeight,
  alignToGround,
  clamp,
  root = document,
}) {
  const terrainGeometry = new THREE.PlaneGeometry(WORLD_W, WORLD_D, 112, 86);
  const terrainPositions = terrainGeometry.attributes.position;
  const terrainColors = [];
  for (let i = 0; i < terrainPositions.count; i++) {
    const x = terrainPositions.getX(i);
    const z = -terrainPositions.getY(i);
    const height = groundHeight(x, z);
    terrainPositions.setZ(i, height);
    const mossiness = clamp((Math.sin(x * 0.32 - z * 0.23) + 0.5) * 0.11, 0, 0.18);
    const disturbedSoil = Math.exp(-((x - NEST_POSITION.x) ** 2 + (z - NEST_POSITION.z) ** 2) / 4.5);
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
    map: makeSoilTexture(renderer, root),
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
  }));
  terrain.receiveShadow = true;
  surfaceGroup.add(terrain);

  const textureLoader = new THREE.TextureLoader();
  const antAtlas = textureLoader.load('./assets/sprites/ant-atlas.png');
  antAtlas.colorSpace = THREE.SRGBColorSpace;
  antAtlas.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const propAtlas = textureLoader.load('./assets/sprites/props-atlas.png');
  propAtlas.colorSpace = THREE.SRGBColorSpace;
  propAtlas.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const antMaterials = Array.from({ length: 4 }, (_, frame) => new THREE.MeshStandardMaterial({
    map: atlasTexture(antAtlas, frame % 2, Math.floor(frame / 2), 2, 2),
    transparent: true,
    alphaTest: 0.075,
    depthWrite: true,
    roughness: 0.82,
    metalness: 0,
    side: THREE.DoubleSide,
  }));

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
      const geometry = new THREE.PlaneGeometry(size, size);
      geometry.rotateX(-Math.PI / 2);
      flatPlaneCache.set(size, geometry);
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

  return { terrain, antMaterials, propMaterials, makeProp };
}

export function createWingTexture({ root = document } = {}) {
  const canvas = root.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
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
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

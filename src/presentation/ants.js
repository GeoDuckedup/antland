import * as THREE from '../../vendor/three.module.js';
import {
  TECHNICAL_HOME_WORKER_LIMIT,
  TECHNICAL_RIVAL_WORKER_LIMIT,
  UNDERGROUND_WORKER_RENDER_LIMIT,
} from '../config/simulation.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export function createAntPresentation({
  surfaceGroup,
  antMaterials,
  groundHeight,
  groundNormal,
  clamp,
}) {
  const antGeometry = new THREE.PlaneGeometry(0.94, 0.94);
  antGeometry.rotateX(-Math.PI / 2);
  const antMeshes = antMaterials.map((material) => {
    const mesh = new THREE.InstancedMesh(antGeometry, material, TECHNICAL_HOME_WORKER_LIMIT);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    surfaceGroup.add(mesh);
    return mesh;
  });

  const rivalMaterials = antMaterials.map((material) => {
    const materialCopy = material.clone();
    materialCopy.color.setHex(0x748fa6);
    return materialCopy;
  });
  const rivalMeshes = rivalMaterials.map((material) => {
    const mesh = new THREE.InstancedMesh(antGeometry, material, TECHNICAL_RIVAL_WORKER_LIMIT);
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
    TECHNICAL_HOME_WORKER_LIMIT,
  );
  antShadows.frustumCulled = false;
  surfaceGroup.add(antShadows);

  const carryGeometry = new THREE.IcosahedronGeometry(0.105, 0);
  const carryMesh = new THREE.InstancedMesh(
    carryGeometry,
    new THREE.MeshStandardMaterial({ color: 0xe3bd66, roughness: 0.9 }),
    TECHNICAL_HOME_WORKER_LIMIT,
  );
  carryMesh.frustumCulled = false;
  carryMesh.castShadow = true;
  surfaceGroup.add(carryMesh);

  const rivalCarryMesh = new THREE.InstancedMesh(
    carryGeometry,
    new THREE.MeshStandardMaterial({ color: 0xb3c985, roughness: 0.9 }),
    TECHNICAL_RIVAL_WORKER_LIMIT,
  );
  rivalCarryMesh.frustumCulled = false;
  rivalCarryMesh.castShadow = true;
  surfaceGroup.add(rivalCarryMesh);

  const soilCarryMesh = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.155, 0),
    new THREE.MeshStandardMaterial({ color: 0x9a5a32, roughness: 1, flatShading: true }),
    TECHNICAL_HOME_WORKER_LIMIT,
  );
  soilCarryMesh.frustumCulled = false;
  soilCarryMesh.castShadow = true;
  surfaceGroup.add(soilCarryMesh);

  const adaptiveVisualState = {
    level: 'full',
    animationFrames: 4,
    shadowStride: 1,
    useTerrainNormals: true,
    undergroundRepresentativeLimit: UNDERGROUND_WORKER_RENDER_LIMIT,
    simulatedSurfaceWorkers: 0,
    renderedSurfaceWorkers: 0,
    renderedHomeWorkers: 0,
    renderedRivalWorkers: 0,
    renderedDescendantWorkers: 0,
    renderedUndergroundWorkers: 0,
  };
  const antInstanceLookup = [[], [], [], []];
  const rivalInstanceLookup = [[], [], [], []];
  const matrix = new THREE.Matrix4();

  function visualFrameForPhase(phase) {
    const raw = Math.floor(phase) % 4;
    if (adaptiveVisualState.animationFrames === 1) return 0;
    if (adaptiveVisualState.animationFrames === 2) return (raw % 2) * 2;
    return raw;
  }

  function updateAdaptiveVisualDetail({ livingColonies, viewState, cameraRig, youngWorkerMeshes, youngCargoMesh }) {
    let surfaceWorkers = 0;
    for (const colony of livingColonies()) {
      surfaceWorkers += colony.workers.reduce((count, worker) => count
        + Number(worker.alive !== false && !worker.insideNest), 0);
    }
    adaptiveVisualState.simulatedSurfaceWorkers = surfaceWorkers;
    const undergroundView = viewState.undergroundBlend > 0.42;
    const overview = undergroundView || surfaceWorkers > 420 || cameraRig.distance > 27;
    const balanced = !overview && (surfaceWorkers > 170 || cameraRig.distance > 18);
    adaptiveVisualState.level = overview ? 'overview' : balanced ? 'balanced' : 'full';
    adaptiveVisualState.animationFrames = overview ? 1 : balanced ? 2 : 4;
    adaptiveVisualState.shadowStride = overview ? 5 : balanced ? 2 : 1;
    adaptiveVisualState.useTerrainNormals = !overview;
    adaptiveVisualState.undergroundRepresentativeLimit = overview ? 120 : balanced ? 180 : UNDERGROUND_WORKER_RENDER_LIMIT;
    const castDetailedShadows = adaptiveVisualState.level === 'full';
    for (const mesh of [...antMeshes, ...rivalMeshes, ...youngWorkerMeshes]) mesh.castShadow = castDetailedShadows;
    carryMesh.castShadow = rivalCarryMesh.castShadow = youngCargoMesh.castShadow = adaptiveVisualState.level !== 'overview';
  }

  function renderHomeWorkers(ants) {
    const frameCounts = [0, 0, 0, 0];
    antInstanceLookup.forEach((lookup) => { lookup.length = 0; });
    let carryingCount = 0;
    let soilCarryingCount = 0;
    let visibleCount = 0;
    let shadowCount = 0;
    const pos = new THREE.Vector3();
    const orientation = new THREE.Quaternion();
    const groundTilt = new THREE.Quaternion();
    const headingSpin = new THREE.Quaternion();
    const normal = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const conditionColor = new THREE.Color();
    const healthyColor = new THREE.Color(0xffffff);
    const infectionColor = new THREE.Color(0x72516f);
    const injuryColor = new THREE.Color(0x9b6a58);
    for (let i = 0; i < ants.length; i++) {
      const ant = ants[i];
      if (ant.insideNest) continue;
      const frame = visualFrameForPhase(ant.phase);
      const index = frameCounts[frame]++;
      antInstanceLookup[frame][index] = ant;
      const bob = Math.sin(ant.phase * Math.PI * 0.5) * 0.012;
      pos.set(ant.x, groundHeight(ant.x, ant.z) + 0.105 + bob, ant.z);
      if (adaptiveVisualState.useTerrainNormals) groundTilt.setFromUnitVectors(Y_AXIS, groundNormal(ant.x, ant.z, normal));
      else groundTilt.identity();
      headingSpin.setFromAxisAngle(Y_AXIS, -ant.heading - Math.PI / 2);
      orientation.copy(groundTilt).multiply(headingSpin);
      const pulse = 1 + Math.sin(ant.phase * Math.PI) * 0.018;
      scale.setScalar(ant.size * pulse);
      matrix.compose(pos, orientation, scale);
      antMeshes[frame].setMatrixAt(index, matrix);
      conditionColor.copy(ant.infection > 0 ? injuryColor : healthyColor).lerp(
        ant.infection > 0 ? infectionColor : injuryColor,
        ant.infection > 0 ? ant.infection : clamp((65 - ant.health) / 50, 0, 0.7),
      );
      antMeshes[frame].setColorAt(index, conditionColor);

      if (visibleCount % adaptiveVisualState.shadowStride === 0) {
        matrix.compose(
          new THREE.Vector3(ant.x, groundHeight(ant.x, ant.z) + 0.038, ant.z),
          groundTilt,
          new THREE.Vector3(ant.size * 1.05, ant.size * 1.05, ant.size * 1.05),
        );
        antShadows.setMatrixAt(shadowCount++, matrix);
      }

      if (ant.carrying) {
        const foodX = ant.x + Math.cos(ant.heading) * 0.29;
        const foodZ = ant.z + Math.sin(ant.heading) * 0.29;
        matrix.compose(
          new THREE.Vector3(foodX, groundHeight(foodX, foodZ) + 0.17, foodZ),
          orientation,
          new THREE.Vector3(1, 0.65, 1),
        );
        carryMesh.setMatrixAt(carryingCount++, matrix);
      }
      if (ant.soilCargo || ant.sanitationCargo) {
        const soilX = ant.x + Math.cos(ant.heading) * 0.3;
        const soilZ = ant.z + Math.sin(ant.heading) * 0.3;
        matrix.compose(
          new THREE.Vector3(soilX, groundHeight(soilX, soilZ) + 0.18, soilZ),
          orientation,
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
    antShadows.count = shadowCount;
    antShadows.instanceMatrix.needsUpdate = true;
    carryMesh.count = carryingCount;
    carryMesh.instanceMatrix.needsUpdate = true;
    soilCarryMesh.count = soilCarryingCount;
    soilCarryMesh.instanceMatrix.needsUpdate = true;
    adaptiveVisualState.renderedHomeWorkers = visibleCount;
  }

  function renderRivalWorkers(rivalAnts) {
    const frameCounts = [0, 0, 0, 0];
    rivalInstanceLookup.forEach((lookup) => { lookup.length = 0; });
    let carryingCount = 0;
    const pos = new THREE.Vector3();
    const orientation = new THREE.Quaternion();
    const groundTilt = new THREE.Quaternion();
    const headingSpin = new THREE.Quaternion();
    const normal = new THREE.Vector3();
    const rivalColor = new THREE.Color();
    const rivalHealthy = new THREE.Color(0xffffff);
    const rivalInjured = new THREE.Color(0xc2736b);
    let visibleCount = 0;
    for (const rival of rivalAnts) {
      if (!rival.alive || rival.insideNest) continue;
      const frame = visualFrameForPhase(rival.phase);
      const index = frameCounts[frame]++;
      rivalInstanceLookup[frame][index] = rival;
      pos.set(rival.x, groundHeight(rival.x, rival.z) + 0.11 + Math.sin(rival.phase) * 0.009, rival.z);
      if (adaptiveVisualState.useTerrainNormals) groundTilt.setFromUnitVectors(Y_AXIS, groundNormal(rival.x, rival.z, normal));
      else groundTilt.identity();
      headingSpin.setFromAxisAngle(Y_AXIS, -rival.heading - Math.PI / 2);
      orientation.copy(groundTilt).multiply(headingSpin);
      matrix.compose(pos, orientation, new THREE.Vector3(rival.size, rival.size, rival.size));
      rivalMeshes[frame].setMatrixAt(index, matrix);
      rivalColor.copy(rivalHealthy).lerp(rivalInjured, clamp((62 - rival.health) / 48, 0, 0.72));
      rivalMeshes[frame].setColorAt(index, rivalColor);
      if (rival.carrying) {
        const foodX = rival.x + Math.cos(rival.heading) * 0.29;
        const foodZ = rival.z + Math.sin(rival.heading) * 0.29;
        matrix.compose(
          new THREE.Vector3(foodX, groundHeight(foodX, foodZ) + 0.17, foodZ),
          orientation,
          new THREE.Vector3(1, 0.65, 1),
        );
        rivalCarryMesh.setMatrixAt(carryingCount++, matrix);
      }
      visibleCount++;
    }
    rivalMeshes.forEach((mesh, frame) => {
      mesh.count = frameCounts[frame];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    rivalCarryMesh.count = carryingCount;
    rivalCarryMesh.instanceMatrix.needsUpdate = true;
    adaptiveVisualState.renderedRivalWorkers = visibleCount;
  }

  return {
    antGeometry,
    antMeshes,
    rivalMeshes,
    antInstanceLookup,
    rivalInstanceLookup,
    adaptiveVisualState,
    visualFrameForPhase,
    updateAdaptiveVisualDetail,
    renderHomeWorkers,
    renderRivalWorkers,
  };
}

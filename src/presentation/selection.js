import * as THREE from '../../vendor/three.module.js';

export function createSelectionPresentation({
  scene,
  surfaceGroup,
  undergroundGroup,
  canvas,
  camera,
  terrain,
  viewState,
}) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
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
  let pathPoints = [];
  let pathClock = 0;

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

  function antAtPointer({
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
    undergroundWorkerSprites = [],
    resolveWorker,
  }) {
    setPointer(clientX, clientY);
    if (viewState.undergroundBlend < 0.5) {
      const hits = raycaster.intersectObjects([...antMeshes, ...rivalMeshes, ...youngWorkerMeshes], false);
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
        const youngFrame = youngWorkerMeshes.indexOf(hit.object);
        if (youngFrame >= 0) {
          const worker = youngWorkerInstanceLookup[youngFrame]?.[hit.instanceId];
          if (worker) return worker;
        }
      }
    } else {
      const hit = raycaster.intersectObjects([
        ...undergroundSpritePool,
        ...rivalTransferPool,
        ...undergroundWorkerSprites,
      ], false)
        .find((candidate) => candidate.object.visible);
      if (hit?.object.userData.workerUid) return resolveWorker?.(hit.object.userData.workerUid) || null;
    }
    return null;
  }

  function select(position) {
    pathPoints = position ? [position] : [];
    pathClock = 0;
    selectedPath.visible = Boolean(position);
  }

  function update({ ant, position, dt, simTime, groundHeight }) {
    selectedSurfaceRing.visible = Boolean(ant && !ant.insideNest);
    selectedNestHalo.visible = Boolean(ant && ant.insideNest);
    if (!ant) return;
    if (ant.insideNest) {
      selectedNestHalo.position.copy(position);
      selectedNestHalo.rotation.y += dt * 0.7;
    } else {
      selectedSurfaceRing.position.set(ant.x, groundHeight(ant.x, ant.z) + 0.09, ant.z);
      selectedSurfaceRing.scale.setScalar(0.92 + Math.sin(simTime * 4.2) * 0.08);
    }
    pathClock += dt;
    if (pathClock >= 0.16) {
      pathClock = 0;
      pathPoints.push(position.clone());
      if (pathPoints.length > 90) pathPoints.shift();
      selectedPathGeometry.setFromPoints(pathPoints);
    }
  }

  return { select, update, groundPoint, antAtPointer };
}

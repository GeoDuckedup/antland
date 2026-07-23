import * as THREE from '../../vendor/three.module.js';
import { nestEdges, nestNodes } from '../simulation/nest-graph.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function vectorFrom(record) {
  return new THREE.Vector3(record.x, record.y, record.z);
}

function scaleFrom(record) {
  return new THREE.Vector3(record.x, record.y, record.z);
}

function disposeObjectMaterial(object) {
  if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
  else object.material?.dispose?.();
}

export function createNestPresenter({
  parent,
  name,
  color = 0xa86b48,
  wireColor = 0xd89a5c,
  chamberColor = color,
  chamberWireColor = wireColor,
  fillOpacity = 0.095,
  wireOpacity = 0.42,
  chamberFillOpacity = fillOpacity,
  chamberWireOpacity = wireOpacity,
  tubeSegments = 48,
  radialSegments = 8,
  chamberSegments = 18,
  chamberRings = 12,
  chamberRevealStart = 0.72,
  createFront = true,
  createFrontFace = false,
  frontColor = color,
  frontOpacity = 0.66,
  frontScaleFactor = 0.78,
  frontOffset = 0,
} = {}) {
  const group = new THREE.Group();
  group.name = name || 'nest-presentation';
  group.visible = false;
  parent?.add(group);

  const fillMaterial = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide, depthWrite: false, fog: false,
  });
  const wireMaterial = new THREE.MeshBasicMaterial({
    color: wireColor, wireframe: true, transparent: true, opacity: wireOpacity,
    side: THREE.DoubleSide, depthWrite: false, fog: false,
  });
  const chamberFillMaterial = new THREE.MeshBasicMaterial({
    color: chamberColor, transparent: true, opacity: chamberFillOpacity,
    side: THREE.DoubleSide, depthWrite: false, fog: false,
  });
  const chamberWireMaterial = new THREE.MeshBasicMaterial({
    color: chamberWireColor, wireframe: true, transparent: true, opacity: chamberWireOpacity,
    side: THREE.DoubleSide, depthWrite: false, fog: false,
  });
  const chamberGeometry = new THREE.SphereGeometry(1, chamberSegments, chamberRings);
  const edgeResources = new Map();
  const nodeResources = new Map();
  let syncedRevision = -1;
  let released = false;

  function createFrontResource(edge) {
    if (!createFront) return { front: null, face: null };
    const front = new THREE.Mesh(
      new THREE.IcosahedronGeometry(edge.radius * frontScaleFactor, 1),
      new THREE.MeshBasicMaterial({ color: frontColor, transparent: true, opacity: frontOpacity, fog: false }),
    );
    front.visible = false;
    group.add(front);
    if (!createFrontFace) return { front, face: null };

    const face = new THREE.Group();
    const faceDisk = new THREE.Mesh(
      new THREE.CircleGeometry(edge.radius * 0.94, 15),
      new THREE.MeshBasicMaterial({ color: 0x351c15, transparent: true, opacity: 0.92, side: THREE.DoubleSide, fog: false }),
    );
    const faceRim = new THREE.Mesh(
      new THREE.RingGeometry(edge.radius * 0.84, edge.radius * 1.12, 15),
      new THREE.MeshBasicMaterial({ color: 0xb66d3b, transparent: true, opacity: 0.7, side: THREE.DoubleSide, fog: false }),
    );
    face.add(faceDisk, faceRim);
    face.visible = false;
    face.renderOrder = 5;
    group.add(face);
    return { front, face };
  }

  function ensureNode(node) {
    const existing = nodeResources.get(node.id);
    if (existing) {
      existing.chamber.position.copy(vectorFrom(node.position));
      existing.targetScale.copy(scaleFrom(node.targetScale));
      return existing;
    }
    if (!node.renderChamber) return null;
    const chamber = new THREE.Group();
    chamber.add(
      new THREE.Mesh(chamberGeometry, chamberFillMaterial),
      new THREE.Mesh(chamberGeometry, chamberWireMaterial),
    );
    chamber.position.copy(vectorFrom(node.position));
    chamber.scale.setScalar(node.completed ? 1 : 0.001);
    chamber.visible = node.completed;
    group.add(chamber);
    const resource = { chamber, targetScale: scaleFrom(node.targetScale) };
    nodeResources.set(node.id, resource);
    return resource;
  }

  function ensureEdge(edge) {
    if (edgeResources.has(edge.id)) return edgeResources.get(edge.id);
    const points = edge.controlPoints.map(vectorFrom);
    const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', edge.tension);
    const geometry = new THREE.TubeGeometry(curve, tubeSegments, edge.radius, radialSegments, false);
    const fill = new THREE.Mesh(geometry, fillMaterial);
    const wire = new THREE.Mesh(geometry, wireMaterial);
    fill.renderOrder = 2;
    wire.renderOrder = 3;
    group.add(fill, wire);
    const { front, face } = createFrontResource(edge);
    const resource = { curve, geometry, fill, wire, front, face };
    edgeResources.set(edge.id, resource);
    return resource;
  }

  function disposeEdgeResource(resource) {
    resource.fill.parent?.remove(resource.fill);
    resource.wire.parent?.remove(resource.wire);
    resource.geometry.dispose();
    if (resource.front) {
      resource.front.parent?.remove(resource.front);
      resource.front.geometry.dispose();
      disposeObjectMaterial(resource.front);
    }
    if (resource.face) {
      resource.face.parent?.remove(resource.face);
      resource.face.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) disposeObjectMaterial(object);
      });
    }
  }

  function syncTopology(graph) {
    if (released) return;
    if (syncedRevision === graph.graphRevision) return;
    const liveNodeIds = new Set(graph.nodes.keys());
    const liveEdgeIds = new Set(graph.edges.keys());
    for (const [id, resource] of edgeResources) {
      if (liveEdgeIds.has(id)) continue;
      disposeEdgeResource(resource);
      edgeResources.delete(id);
    }
    for (const [id, resource] of nodeResources) {
      if (liveNodeIds.has(id)) continue;
      resource.chamber.parent?.remove(resource.chamber);
      nodeResources.delete(id);
    }
    nestNodes(graph).forEach(ensureNode);
    nestEdges(graph).forEach(ensureEdge);
    syncedRevision = graph.graphRevision;
  }

  function syncGraph(graph, {
    visible = true,
    simTime = 0,
    frontFilter = (edge) => !edge.completed,
    activeFrontIds = [],
  } = {}) {
    if (released) return;
    syncTopology(graph);
    group.visible = visible;
    const activeIds = new Set(activeFrontIds);
    for (const edge of nestEdges(graph)) {
      const resource = ensureEdge(edge);
      const count = resource.geometry.index.count;
      resource.geometry.setDrawRange(0, Math.floor(count * clamp(edge.progress, 0, 1) / 6) * 6);
      const node = graph.nodes.get(edge.toNodeId);
      const nodeResource = nodeResources.get(edge.toNodeId);
      const chamberProgress = clamp((edge.progress - chamberRevealStart) / (1 - chamberRevealStart), 0, 1);
      if (node?.renderChamber && nodeResource) {
        const eased = chamberProgress * chamberProgress * (3 - chamberProgress * 2);
        nodeResource.chamber.visible = chamberProgress > 0 || edge.completed;
        nodeResource.chamber.scale.copy(nodeResource.targetScale)
          .multiplyScalar(edge.completed ? 1 : Math.max(0.001, eased));
      }
      const frontVisible = Boolean(resource.front && frontFilter(edge));
      if (resource.front) resource.front.visible = frontVisible;
      if (resource.face) resource.face.visible = frontVisible;
      if (frontVisible) {
        const frontT = Math.max(0.012, edge.progress);
        resource.curve.getPointAt(frontT, resource.front.position);
        const tangent = resource.curve.getTangentAt(frontT).normalize();
        const active = activeIds.has(edge.id);
        resource.front.scale.setScalar(active
          ? 0.34 * (0.78 + Math.sin(simTime * 5.2 + edge.start) * 0.22)
          : createFrontFace ? 0.34 * (0.62 + Math.sin(simTime * 1.4 + edge.start) * 0.06)
            : 0.76 + Math.sin(simTime * 5.2) * 0.18);
        resource.front.position.addScaledVector(tangent, frontOffset);
        if (resource.face) {
          resource.face.position.copy(resource.front.position);
          resource.face.quaternion.setFromUnitVectors(Z_AXIS, tangent);
          resource.face.rotateZ(edge.frontRotation);
        }
      }
    }
  }

  function curveFor(edgeOrId) {
    const id = typeof edgeOrId === 'string' ? edgeOrId : edgeOrId?.id;
    return edgeResources.get(id)?.curve || null;
  }

  function resourceFor(edgeOrId) {
    const id = typeof edgeOrId === 'string' ? edgeOrId : edgeOrId?.id;
    return edgeResources.get(id) || null;
  }

  function release() {
    if (released) return;
    released = true;
    for (const resource of edgeResources.values()) disposeEdgeResource(resource);
    edgeResources.clear();
    nodeResources.clear();
    group.parent?.remove(group);
    chamberGeometry.dispose();
    fillMaterial.dispose();
    wireMaterial.dispose();
    chamberFillMaterial.dispose();
    chamberWireMaterial.dispose();
  }

  return {
    group,
    syncGraph,
    syncTopology,
    curveFor,
    resourceFor,
    nodeResourceFor: (nodeOrId) => nodeResources.get(typeof nodeOrId === 'string' ? nodeOrId : nodeOrId?.id) || null,
    release,
    get released() { return released; },
    get syncedRevision() { return syncedRevision; },
  };
}

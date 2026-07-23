const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function serializablePosition(position = {}) {
  return {
    x: Number(position.x) || 0,
    y: Number(position.y) || 0,
    z: Number(position.z) || 0,
  };
}

function serializableScale(scale = {}) {
  if (Array.isArray(scale)) {
    return { x: Number(scale[0]) || 1, y: Number(scale[1]) || 1, z: Number(scale[2]) || 1 };
  }
  return {
    x: Number(scale.x) || 1,
    y: Number(scale.y) || 1,
    z: Number(scale.z) || 1,
  };
}

function nextId(graph, kind) {
  const key = kind === 'node' ? 'nextNodeSequence' : 'nextEdgeSequence';
  const label = kind === 'node' ? 'chamber' : 'tunnel';
  return `${graph.colonyId}-${label}-${graph[key]++}`;
}

function advanceRevision(graph) {
  graph.graphRevision += 1;
  return graph.graphRevision;
}

export function createNestGraph({
  colonyId,
  entranceNodeId = null,
  capacity = {},
  pressure = {},
  statistics = {},
  nextNodeSequence = 1,
  nextEdgeSequence = 1,
} = {}) {
  if (!colonyId) throw new Error('A nest graph requires a colonyId.');
  return {
    colonyId,
    entranceNodeId,
    nodes: new Map(),
    edges: new Map(),
    activeProjectIds: [],
    capacity: { habitable: 0, brood: 0, storage: 0, ...capacity },
    pressure: { occupancy: 0, brood: 0, storage: 0, growthDrive: 0, ...pressure },
    statistics: { completedProjects: 0, totalExcavated: 0, ...statistics },
    graphRevision: 0,
    nextNodeSequence,
    nextEdgeSequence,
  };
}

export function addNestNode(graph, specification = {}) {
  const id = specification.id || nextId(graph, 'node');
  if (graph.nodes.has(id)) throw new Error(`Duplicate nest node id: ${id}`);
  const node = {
    id,
    type: specification.type || 'resting',
    position: serializablePosition(specification.position),
    parentId: specification.parentId || null,
    capacity: specification.capacity ?? 0,
    storageCapacity: specification.storageCapacity ?? 0,
    completed: specification.completed ?? false,
    children: specification.children ?? 0,
    renderChamber: specification.renderChamber !== false,
    targetScale: serializableScale(specification.targetScale),
  };
  graph.nodes.set(id, node);
  if (!graph.entranceNodeId) graph.entranceNodeId = id;
  advanceRevision(graph);
  return node;
}

export function addNestEdge(graph, specification = {}) {
  const id = specification.id || nextId(graph, 'edge');
  if (graph.edges.has(id)) throw new Error(`Duplicate nest edge id: ${id}`);
  if (!graph.nodes.has(specification.fromNodeId) || !graph.nodes.has(specification.toNodeId)) {
    throw new Error(`Nest edge ${id} must reference existing nodes.`);
  }
  const progress = clamp(specification.progress ?? 0, 0, 1);
  const edge = {
    id,
    name: specification.name || id,
    fromNodeId: specification.fromNodeId,
    toNodeId: specification.toNodeId,
    controlPoints: (specification.controlPoints || []).map(serializablePosition),
    radius: specification.radius ?? 0.24,
    tension: specification.tension ?? 0.42,
    progress,
    progressRevisionStep: specification.progressRevisionStep ?? 0.02,
    progressRevisionBucket: Math.floor(progress / (specification.progressRevisionStep ?? 0.02)),
    workRequired: specification.workRequired ?? 0,
    work: specification.work ?? 0,
    completed: specification.completed ?? progress >= 1,
    available: specification.available ?? false,
    activeDiggerIds: [...(specification.activeDiggerIds || [])],
    chamberScale: serializableScale(specification.chamberScale),
    renderChamber: specification.renderChamber !== false,
    start: specification.start ?? 0,
    duration: specification.duration ?? 0,
    frontRotation: specification.frontRotation ?? 0,
  };
  graph.edges.set(id, edge);
  const fromNode = graph.nodes.get(edge.fromNodeId);
  if (fromNode) fromNode.children += 1;
  if (!edge.completed && !graph.activeProjectIds.includes(id)) graph.activeProjectIds.push(id);
  advanceRevision(graph);
  return edge;
}

export function updateNestEdgeProgress(graph, edgeOrId, progress, { work, completed } = {}) {
  const edge = typeof edgeOrId === 'string' ? graph.edges.get(edgeOrId) : edgeOrId;
  if (!edge || graph.edges.get(edge.id) !== edge) throw new Error('Cannot update an edge outside this nest graph.');
  const nextProgress = clamp(progress, 0, 1);
  const nextCompleted = completed ?? nextProgress >= 1;
  const nextBucket = Math.floor(nextProgress / edge.progressRevisionStep);
  const meaningfulPresentationChange = nextBucket !== edge.progressRevisionBucket || nextCompleted !== edge.completed;
  edge.progress = nextProgress;
  if (work != null) edge.work = work;
  edge.completed = nextCompleted;
  edge.progressRevisionBucket = nextBucket;
  if (nextCompleted) {
    graph.activeProjectIds = graph.activeProjectIds.filter((id) => id !== edge.id);
    const destination = graph.nodes.get(edge.toNodeId);
    if (destination) destination.completed = true;
  }
  else if (!graph.activeProjectIds.includes(edge.id)) graph.activeProjectIds.push(edge.id);
  if (meaningfulPresentationChange) advanceRevision(graph);
  return edge;
}

export function markNestGraphChanged(graph) {
  return advanceRevision(graph);
}

export function nestNodes(graph) {
  return Array.from(graph?.nodes?.values?.() || []);
}

export function nestEdges(graph) {
  return Array.from(graph?.edges?.values?.() || []);
}

export function serializeNestGraph(graph) {
  return {
    colonyId: graph.colonyId,
    entranceNodeId: graph.entranceNodeId,
    nodes: nestNodes(graph).map((node) => ({ ...node, position: { ...node.position }, targetScale: { ...node.targetScale } })),
    edges: nestEdges(graph).map((edge) => ({
      ...edge,
      controlPoints: edge.controlPoints.map((point) => ({ ...point })),
      activeDiggerIds: [...edge.activeDiggerIds],
      chamberScale: { ...edge.chamberScale },
    })),
    activeProjectIds: [...graph.activeProjectIds],
    capacity: { ...graph.capacity },
    pressure: { ...graph.pressure },
    statistics: { ...graph.statistics },
    graphRevision: graph.graphRevision,
    nextNodeSequence: graph.nextNodeSequence,
    nextEdgeSequence: graph.nextEdgeSequence,
  };
}

export function restoreNestGraph(snapshot) {
  const graph = createNestGraph(snapshot);
  for (const node of snapshot.nodes || []) graph.nodes.set(node.id, {
    ...node,
    position: serializablePosition(node.position),
    targetScale: serializableScale(node.targetScale),
  });
  for (const edge of snapshot.edges || []) graph.edges.set(edge.id, {
    ...edge,
    controlPoints: (edge.controlPoints || []).map(serializablePosition),
    activeDiggerIds: [...(edge.activeDiggerIds || [])],
    chamberScale: serializableScale(edge.chamberScale),
  });
  graph.entranceNodeId = snapshot.entranceNodeId || graph.nodes.keys().next().value || null;
  graph.activeProjectIds = [...(snapshot.activeProjectIds || [])];
  graph.graphRevision = snapshot.graphRevision || 0;
  return graph;
}

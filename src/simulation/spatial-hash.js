function defaultCoordinate(entity, key) {
  const value = Number(entity?.[key]);
  return Number.isFinite(value) ? value : 0;
}

export function createSpatialHash({
  cellSize = 1,
  getX = (entity) => defaultCoordinate(entity, 'x'),
  getZ = (entity) => defaultCoordinate(entity, 'z'),
} = {}) {
  if (!(cellSize > 0)) throw new Error('Spatial hash cellSize must be positive.');
  const cells = new Map();
  const cellByEntity = new WeakMap();
  let orderByEntity = new WeakMap();
  let nextOrder = 0;

  const coords = (x, z) => ({ x: Math.floor(x / cellSize), z: Math.floor(z / cellSize) });
  const keyFor = (x, z) => `${x}:${z}`;

  function remove(entity) {
    const key = cellByEntity.get(entity);
    if (key == null) return false;
    const occupants = cells.get(key);
    const index = occupants?.indexOf(entity) ?? -1;
    if (index >= 0) occupants.splice(index, 1);
    if (occupants?.length === 0) cells.delete(key);
    cellByEntity.delete(entity);
    return index >= 0;
  }

  function add(entity) {
    if (!entity || typeof entity !== 'object') return null;
    if (!orderByEntity.has(entity)) orderByEntity.set(entity, nextOrder++);
    remove(entity);
    const point = coords(getX(entity), getZ(entity));
    const key = keyFor(point.x, point.z);
    let occupants = cells.get(key);
    if (!occupants) {
      occupants = [];
      cells.set(key, occupants);
    }
    occupants.push(entity);
    cellByEntity.set(entity, key);
    return entity;
  }

  function update(entity) {
    if (!entity || typeof entity !== 'object') return null;
    const point = coords(getX(entity), getZ(entity));
    const nextKey = keyFor(point.x, point.z);
    if (cellByEntity.get(entity) === nextKey) return entity;
    return add(entity);
  }

  function clear() {
    cells.clear();
    orderByEntity = new WeakMap();
    nextOrder = 0;
  }

  function rebuild(entities) {
    clear();
    for (const entity of entities || []) add(entity);
  }

  function queryRadius(x, z, radius, accept = null) {
    const center = coords(x, z);
    const span = Math.ceil(radius / cellSize);
    const radiusSq = radius * radius;
    const matches = [];
    for (let ox = -span; ox <= span; ox++) {
      for (let oz = -span; oz <= span; oz++) {
        const occupants = cells.get(keyFor(center.x + ox, center.z + oz));
        if (!occupants) continue;
        for (const entity of occupants) {
          if (accept && !accept(entity)) continue;
          const dx = getX(entity) - x;
          const dz = getZ(entity) - z;
          if (dx * dx + dz * dz <= radiusSq) matches.push(entity);
        }
      }
    }
    // Full-array queries historically resolved equal-distance candidates by
    // insertion order. Keep that deterministic contract while querying only
    // the nearby cells.
    matches.sort((a, b) => (orderByEntity.get(a) ?? Number.MAX_SAFE_INTEGER)
      - (orderByEntity.get(b) ?? Number.MAX_SAFE_INTEGER));
    return matches;
  }

  function nearest(x, z, radius, accept = null) {
    let entity = null;
    let distanceSquared = radius * radius;
    for (const candidate of queryRadius(x, z, radius, accept)) {
      const dx = getX(candidate) - x;
      const dz = getZ(candidate) - z;
      const candidateDistance = dx * dx + dz * dz;
      if (candidateDistance < distanceSquared) {
        entity = candidate;
        distanceSquared = candidateDistance;
      }
    }
    return entity ? { entity, distanceSquared } : null;
  }

  return {
    add,
    remove,
    update,
    clear,
    rebuild,
    queryRadius,
    nearest,
    get cellCount() { return cells.size; },
  };
}

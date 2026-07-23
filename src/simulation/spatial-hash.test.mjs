import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpatialHash } from './spatial-hash.js';

test('spatial hash returns only accepted entities inside a local radius', () => {
  const index = createSpatialHash({ cellSize: 1 });
  const entities = [
    { id: 'a', x: 0.2, z: 0.2, active: true },
    { id: 'b', x: 0.8, z: 0.8, active: false },
    { id: 'c', x: 2.2, z: 0.2, active: true },
  ];
  index.rebuild(entities);
  assert.deepEqual(index.queryRadius(0, 0, 1.5, (entity) => entity.active).map((entity) => entity.id), ['a']);
  assert.equal(index.nearest(0, 0, 4, (entity) => entity.active).entity.id, 'a');
});

test('spatial hash tracks moved and removed entities without rebuilding', () => {
  const index = createSpatialHash({ cellSize: 1 });
  const entity = { id: 'moving', x: 0, z: 0 };
  index.add(entity);
  entity.x = 3;
  index.update(entity);
  assert.equal(index.queryRadius(0, 0, 0.5).length, 0);
  assert.equal(index.queryRadius(3, 0, 0.5)[0], entity);
  assert.equal(index.remove(entity), true);
  assert.equal(index.queryRadius(3, 0, 0.5).length, 0);
});

test('spatial hash preserves insertion order when equal-distance candidates span cells', () => {
  const index = createSpatialHash({ cellSize: 1 });
  const first = { id: 'first', x: 1.1, z: 0 };
  const second = { id: 'second', x: -1.1, z: 0 };
  index.add(first);
  index.add(second);
  assert.deepEqual(index.queryRadius(0, 0, 2).map((entity) => entity.id), ['first', 'second']);
  assert.equal(index.nearest(0, 0, 2).entity, first);
});

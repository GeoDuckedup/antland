import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from '../../vendor/three.module.js';
import {
  addNestEdge,
  addNestNode,
  createNestGraph,
  updateNestEdgeProgress,
} from '../simulation/nest-graph.js';
import { createNestPresenter } from './nests.js';

test('nest presentation caches geometry across progress revisions and releases independently', () => {
  const graph = createNestGraph({ colonyId: 'presented-colony' });
  const entrance = addNestNode(graph, { position: { x: 0, y: 0, z: 0 }, renderChamber: false, completed: true });
  const chamber = addNestNode(graph, {
    position: { x: 2, y: -2, z: 1 },
    targetScale: { x: 1.4, y: 0.6, z: 1.1 },
  });
  const edge = addNestEdge(graph, {
    fromNodeId: entrance.id,
    toNodeId: chamber.id,
    controlPoints: [entrance.position, { x: 1, y: -0.8, z: 0.2 }, chamber.position],
    progress: 0.1,
  });
  const parent = new THREE.Group();
  const presenter = createNestPresenter({ parent });
  presenter.syncGraph(graph);
  const firstResource = presenter.resourceFor(edge);
  const firstGeometry = firstResource.geometry;

  updateNestEdgeProgress(graph, edge, 0.54);
  presenter.syncGraph(graph);
  assert.equal(presenter.resourceFor(edge), firstResource);
  assert.equal(presenter.resourceFor(edge).geometry, firstGeometry);
  assert.ok(firstGeometry.drawRange.count > 0);

  presenter.release();
  assert.equal(parent.children.length, 0);
  assert.equal(presenter.released, true);
  assert.equal(graph.nodes.has(chamber.id), true, 'presentation disposal must retain historical graph state');
  assert.equal(graph.edges.has(edge.id), true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addNestEdge,
  addNestNode,
  createNestGraph,
  nestEdges,
  nestNodes,
  restoreNestGraph,
  serializeNestGraph,
  updateNestEdgeProgress,
} from './nest-graph.js';

test('nest graphs stay serializable and independent of DOM and Three.js', () => {
  const graph = createNestGraph({ colonyId: 'test-colony', capacity: { habitable: 12 } });
  const entrance = addNestNode(graph, { type: 'shaft', position: { x: 2, y: 0, z: -3 }, renderChamber: false, completed: true });
  const nursery = addNestNode(graph, { type: 'nursery', position: { x: 3, y: -2, z: -4 }, capacity: 18 });
  const edge = addNestEdge(graph, {
    fromNodeId: entrance.id,
    toNodeId: nursery.id,
    controlPoints: [entrance.position, { x: 2.4, y: -1, z: -3.4 }, nursery.position],
    progress: 0.1,
  });
  const initialRevision = graph.graphRevision;
  updateNestEdgeProgress(graph, edge, 0.11, { work: 4 });
  assert.equal(graph.graphRevision, initialRevision, 'sub-threshold progress should not invalidate presentation geometry');
  updateNestEdgeProgress(graph, edge, 0.14, { work: 7 });
  assert.ok(graph.graphRevision > initialRevision);

  const snapshot = serializeNestGraph(graph);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  assert.equal(snapshot.edges[0].curve, undefined);
  assert.deepEqual(snapshot.nodes[1].position, { x: 3, y: -2, z: -4 });

  const restored = restoreNestGraph(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(serializeNestGraph(restored), snapshot);
  assert.equal(nestNodes(restored).length, 2);
  assert.equal(nestEdges(restored).length, 1);
});

test('completion removes active projects while retaining historical topology', () => {
  const graph = createNestGraph({ colonyId: 'history' });
  const entrance = addNestNode(graph, { id: 'entrance', completed: true });
  const chamber = addNestNode(graph, { id: 'chamber' });
  const edge = addNestEdge(graph, { id: 'project', fromNodeId: entrance.id, toNodeId: chamber.id });
  assert.deepEqual(graph.activeProjectIds, ['project']);
  updateNestEdgeProgress(graph, edge, 1);
  assert.deepEqual(graph.activeProjectIds, []);
  assert.equal(graph.edges.has('project'), true);
});

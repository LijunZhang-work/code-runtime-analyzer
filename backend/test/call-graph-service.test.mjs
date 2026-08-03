import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildCallGraph } from '../src/call-graph-service.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(testDirectory, '..', '..');

test('Clang call graph never returns an edge whose node was trimmed', async () => {
  const graph = await buildCallGraph({
    workspaceRoot,
    compileCommandsPath: resolve(workspaceRoot, 'build', '2048_csv_replay-current-mingw', 'compile_commands.json'),
    filePath: resolve(workspaceRoot, 'labs', '2048_csv_replay', 'src', 'replay_scenario.cpp'),
    focusLine: 85,
    maxNodes: 12,
    maxEdges: 20
  });
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  assert.ok(graph.nodes.some((node) => node.kind === 'definition'));
  assert.ok(graph.edges.length > 0);
  assert.ok(graph.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
  assert.equal(graph.nodes.find((node) => node.id === graph.focusNodeId)?.label, 'main');

  const cached = await buildCallGraph({
    workspaceRoot,
    compileCommandsPath: resolve(workspaceRoot, 'build', '2048_csv_replay-current-mingw', 'compile_commands.json'),
    filePath: resolve(workspaceRoot, 'labs', '2048_csv_replay', 'src', 'replay_scenario.cpp'),
    focusLine: 85,
    maxNodes: 12,
    maxEdges: 20
  });
  assert.equal(cached.performance.cacheHit, true);
});

test('an oversized function keeps a bounded visible node instead of failing the whole graph', async () => {
  const graph = await buildCallGraph({
    workspaceRoot,
    compileCommandsPath: resolve(workspaceRoot, 'build', '2048_csv_replay-current-mingw', 'compile_commands.json'),
    filePath: resolve(workspaceRoot, 'labs', '2048_csv_replay', 'src', 'replay_scenario.cpp'),
    functionNames: ['main'],
    maxNodes: 12,
    maxEdges: 20
  }, {
    runAstJson: async (_compiler, _args, { functionName, maxBytes }) => {
      const error = new Error(`函数 ${functionName} 超过 ${maxBytes}`);
      error.name = 'ClangAstOutputLimitError';
      throw error;
    }
  });

  assert.equal(graph.truncated, true);
  assert.equal(graph.oversizedFunctionCount, 1);
  assert.deepEqual(graph.oversizedFunctions, ['main']);
  assert.equal(graph.nodes.find((node) => node.id === graph.focusNodeId)?.label, 'main');
  assert.equal(graph.nodes.find((node) => node.id === graph.focusNodeId)?.analysisState, 'ast_output_limited');
  assert.match(graph.limitations.at(-1), /安全上限/);
});

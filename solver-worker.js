importScripts('./solver.js');
self.onmessage = event => {
  try { self.postMessage({ type: 'result', result: ShuntingSolver.solve(event.data, stats => self.postMessage({ type: 'progress', stats })) }); }
  catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};

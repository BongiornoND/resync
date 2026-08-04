// Standalone static server for testing the renderer (viewer + UI) in a
// plain browser tab, without launching Electron at all.
const path = require('path');
const { createStaticServer } = require('./static-server');

createStaticServer(path.join(__dirname, '..')).then(({ port }) => {
  console.log(`cad-sync dev server running at http://127.0.0.1:${port}/`);
});

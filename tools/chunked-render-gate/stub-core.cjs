// Host stub: the renderer only imports `convertFileSrc` from the Tauri API.
// .cjs on purpose - package.json sets "type": "module", and a .js stub would be
// treated as ESM, leaving the named import undefined (asset URLs then silently
// stop resolving and the gate would compare a broken path).
exports.convertFileSrc = (p) => 'asset://localhost/' + String(p).replace(/\\/g, '/');
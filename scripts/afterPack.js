// electron-builder's built-in "production dependencies" collector misses
// some transitive dependencies of electron-updater (builder-util-runtime,
// fs-extra, semver, jsonfile, universalify) when asar is disabled — the
// packaged app then fails `require('electron-updater')` at startup with a
// silent, instant crash before any window opens. Copy the full dependency
// tree in ourselves as a safety net, walking each package.json's
// "dependencies" recursively from the project's own node_modules.
const fs = require('fs');
const path = require('path');

function collectDeps(rootNodeModules, moduleName, seen) {
  if (seen.has(moduleName)) return;
  seen.add(moduleName);
  const pkgPath = path.join(rootNodeModules, moduleName, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  for (const dep of deps) collectDeps(rootNodeModules, dep, seen);
}

exports.default = async function afterPack(context) {
  const rootNodeModules = path.join(__dirname, '..', 'node_modules');
  const packagedNodeModules = path.join(context.appOutDir, 'resources', 'app', 'node_modules');
  if (!fs.existsSync(packagedNodeModules)) return;

  const seen = new Set();
  collectDeps(rootNodeModules, 'electron-updater', seen);

  let copied = [];
  for (const name of seen) {
    const dest = path.join(packagedNodeModules, name);
    if (fs.existsSync(dest)) continue;
    const src = path.join(rootNodeModules, name);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, dest, { recursive: true });
    copied.push(name);
  }
  if (copied.length) {
    console.log('[afterPack] Copied missing electron-updater transitive dependencies:', copied.join(', '));
  }
};

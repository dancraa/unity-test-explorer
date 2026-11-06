// Installs the Editor-only bridge into a Unity project as an embedded package.
const fs = require('fs');
const path = require('path');

const BUNDLED_PACKAGE = path.join(__dirname, 'bridge-package');
const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(BUNDLED_PACKAGE, 'package.json'), 'utf8')).name;

function bundledVersion() {
    return JSON.parse(fs.readFileSync(path.join(BUNDLED_PACKAGE, 'package.json'), 'utf8')).version;
}

function embeddedPath(projectRoot) {
    return path.join(projectRoot, 'Packages', PACKAGE_NAME);
}

function isListedInManifest(projectRoot) {
    const manifestPath = path.join(projectRoot, 'Packages', 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;
    return PACKAGE_NAME in (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).dependencies || {});
}

/** The embedded package's version, `managed` if installed some other way, or null if missing. */
function installedVersion(projectRoot) {
    const manifest = path.join(embeddedPath(projectRoot), 'package.json');
    if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    return isListedInManifest(projectRoot) ? 'managed' : null;
}

function needsUpdate(projectRoot) {
    const version = installedVersion(projectRoot);
    return version !== null && version !== 'managed' && version !== bundledVersion();
}

function installBridge(projectRoot) {
    fs.cpSync(BUNDLED_PACKAGE, embeddedPath(projectRoot), { recursive: true, force: true });
}

module.exports = { PACKAGE_NAME, bundledVersion, installedVersion, needsUpdate, installBridge };

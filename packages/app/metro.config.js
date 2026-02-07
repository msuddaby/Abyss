const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// The shared package uses `.js` extensions in TS imports (standard ESM convention).
// Metro doesn't resolve `./foo.js` → `./foo.ts` by default, so we strip `.js`
// and let Metro's normal extension resolution find the `.ts` file.
const sharedRoot = path.resolve(monorepoRoot, 'packages', 'shared');
const originalResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Only rewrite .js imports coming from the shared package
  if (
    context.originModulePath.startsWith(sharedRoot) &&
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js')
  ) {
    const stripped = moduleName.slice(0, -3);
    if (originalResolveRequest) {
      return originalResolveRequest(context, stripped, platform);
    }
    return context.resolveRequest(context, stripped, platform);
  }

  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

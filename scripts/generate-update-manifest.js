#!/usr/bin/env node

/**
 * Generate update manifests for electron-updater
 *
 * This script generates latest-mac.yml, latest.yml, and latest-linux.yml
 * files required by electron-updater for auto-updates.
 *
 * Run after building the desktop app with `npm run make`
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const OUT_DIR = path.join(__dirname, '../packages/desktop/out/make');
const PACKAGE_JSON = require('../packages/desktop/package.json');

/**
 * Calculate SHA-512 hash of a file
 */
function getFileHash(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha512');
  hashSum.update(fileBuffer);
  return hashSum.digest('base64');
}

/**
 * Get file size in bytes
 */
function getFileSize(filePath) {
  const stats = fs.statSync(filePath);
  return stats.size;
}

/**
 * Find file matching pattern in directory (recursive)
 */
function findFile(dir, pattern) {
  if (!fs.existsSync(dir)) {
    return null;
  }

  const files = fs.readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const filePath = path.join(dir, file.name);

    if (file.isDirectory()) {
      const found = findFile(filePath, pattern);
      if (found) return found;
    } else if (pattern.test(file.name)) {
      return filePath;
    }
  }

  return null;
}

/**
 * Generate macOS update manifest
 */
function generateMacManifest() {
  console.log('Generating macOS manifest...');

  // Find .zip file (used for auto-updates on macOS)
  const zipFile = findFile(path.join(OUT_DIR, 'zip'), /\.zip$/);

  if (!zipFile) {
    console.warn('WARNING: macOS .zip file not found. Skipping latest-mac.yml');
    return;
  }

  const fileName = path.basename(zipFile);
  const fileSize = getFileSize(zipFile);
  const sha512 = getFileHash(zipFile);

  const manifest = {
    version: PACKAGE_JSON.version,
    releaseDate: new Date().toISOString(),
    files: [
      {
        url: fileName,
        sha512,
        size: fileSize
      }
    ],
    path: fileName,
    sha512
  };

  const manifestPath = path.join(path.dirname(zipFile), 'latest-mac.yml');
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
  console.log(`✓ Generated ${manifestPath}`);
}

/**
 * Generate Windows update manifest
 */
function generateWindowsManifest() {
  console.log('Generating Windows manifest...');

  // Find .exe installer (Squirrel)
  const exeFile = findFile(path.join(OUT_DIR, 'squirrel.windows'), /\.exe$/);

  if (!exeFile) {
    console.warn('WARNING: Windows .exe file not found. Skipping latest.yml');
    return;
  }

  const fileName = path.basename(exeFile);
  const fileSize = getFileSize(exeFile);
  const sha512 = getFileHash(exeFile);

  const manifest = {
    version: PACKAGE_JSON.version,
    releaseDate: new Date().toISOString(),
    files: [
      {
        url: fileName,
        sha512,
        size: fileSize
      }
    ],
    path: fileName,
    sha512
  };

  const manifestPath = path.join(path.dirname(exeFile), 'latest.yml');
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
  console.log(`✓ Generated ${manifestPath}`);
}

/**
 * Generate Linux update manifest
 */
function generateLinuxManifest() {
  console.log('Generating Linux manifest...');

  // Find AppImage (if available) or .deb file
  let linuxFile = findFile(path.join(OUT_DIR), /\.AppImage$/);

  if (!linuxFile) {
    // Fallback to .deb
    linuxFile = findFile(path.join(OUT_DIR, 'deb'), /\.deb$/);
  }

  if (!linuxFile) {
    console.warn('WARNING: Linux package not found. Skipping latest-linux.yml');
    return;
  }

  const fileName = path.basename(linuxFile);
  const fileSize = getFileSize(linuxFile);
  const sha512 = getFileHash(linuxFile);

  const manifest = {
    version: PACKAGE_JSON.version,
    releaseDate: new Date().toISOString(),
    files: [
      {
        url: fileName,
        sha512,
        size: fileSize
      }
    ],
    path: fileName,
    sha512
  };

  const manifestPath = path.join(path.dirname(linuxFile), 'latest-linux.yml');
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
  console.log(`✓ Generated ${manifestPath}`);
}

// Main execution
console.log('Generating update manifests...\n');

try {
  generateMacManifest();
  generateWindowsManifest();
  generateLinuxManifest();
  console.log('\n✓ Update manifests generated successfully!');
} catch (error) {
  console.error('\n✗ Error generating manifests:', error.message);
  process.exit(1);
}

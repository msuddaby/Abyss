const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { MakerAppImage } = require('@reforged/maker-appimage');
const { version } = require('./package.json');

module.exports = {
  packagerConfig: {
    asar: true,
    name: 'abyss-desktop',
    executableName: 'abyss-desktop',
    icon: './resources/icon',
    extraResource: [
      '../../client/dist',
      './resources/app-update.yml'
    ],
    appBundleId: 'com.abyss.desktop',
    osxSign: {
      identity: process.env.APPLE_IDENTITY,
      hardenedRuntime: true,
      entitlements: './entitlements.plist',
      'entitlements-inherit': './entitlements.plist',
      'signature-flags': 'library'
    },
    osxNotarize: process.env.APPLE_ID ? {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_ID_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID
    } : undefined
  },
  rebuildConfig: {},
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'msuddaby',
          name: 'Abyss'
        },
        prerelease: false,
        draft: true
      }
    }
  ],
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'abyss_desktop',
        setupExe: `abyss-desktop-${version}-Setup.exe`,
        noMsi: true
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
        name: 'Abyss'
      }
    },
    new MakerAppImage({
      options: {
        name: 'Abyss',
        bin: 'abyss-desktop',
        icon: './resources/icon.png',
        genericName: 'Voice Chat',
        categories: ['Network', 'Chat'],
      }
    }),
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

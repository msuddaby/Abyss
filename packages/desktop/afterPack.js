const { flipFuses, FuseV1Options, FuseVersion } = require("@electron/fuses");
const path = require("path");

module.exports = async function afterPack(context) {
  const ext = process.platform === "win32" ? ".exe" : "";
  const executableName = context.packager.appInfo.productFilename + ext;
  const electronBinaryPath = path.join(context.appOutDir, executableName);

  await flipFuses(electronBinaryPath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
};

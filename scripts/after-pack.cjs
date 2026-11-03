/**
 * electron-builder `afterPack` hook: flips the Electron fuses on the packaged
 * binary before the installer is assembled.
 *
 * Why each fuse matters here:
 *  - RunAsNode off        — `ELECTRON_RUN_AS_NODE=1 app.exe` can no longer turn
 *                           the shipped binary into a plain Node interpreter.
 *                           (This bit us during testing: an inherited env var
 *                           started the app as Node and `require('electron')`
 *                           returned a path string instead of the API.)
 *  - NodeOptions env off  — `NODE_OPTIONS` cannot inject a preload/require flag.
 *  - Node CLI inspect off — `--inspect` cannot attach a debugger to the shipped
 *                           main process.
 *  - OnlyLoadAppFromAsar  — the app must come from `app.asar`, not from a
 *                           sibling `app/` directory an attacker could drop in.
 *  - Embedded asar integrity — the asar hash baked into the executable is
 *                           checked, so a modified `app.asar` is refused.
 *  - Cookie encryption    — Chromium cookies use the OS keystore.
 */
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const productFilename = context.packager.appInfo.productFilename;

  let executablePath;
  if (platform === 'win32') {
    executablePath = path.join(context.appOutDir, `${productFilename}.exe`);
  } else if (platform === 'darwin') {
    executablePath = path.join(context.appOutDir, `${productFilename}.app`);
  } else {
    executablePath = path.join(context.appOutDir, productFilename);
  }

  const before = await getCurrentFuseWire(executablePath);

  /*
   * Flipping a fuse rewrites the binary, which invalidates any signature it
   * already carried. On arm64 macOS the linker's ad-hoc signature is what lets
   * the kernel map the page cache, so an invalidated one means the app does not
   * launch at all. `resetAdHocDarwinSignature` re-applies it; it is a no-op
   * everywhere else, and electron-builder still codesigns afterwards.
   *
   * `context.arch` is the numeric Arch enum (arm64 is 3) but is compared as a
   * string too, so a future electron-builder that passes the name still works.
   */
  const isAppleSilicon =
    platform === 'darwin' && (context.arch === 3 || context.arch === 'arm64');

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    ...(isAppleSilicon ? { resetAdHocDarwinSignature: true } : {}),
  });

  const after = await getCurrentFuseWire(executablePath);

  // Print the wire in both states so the build log is the evidence that the
  // shipped binary actually carries the hardened configuration.
  process.stdout.write(
    `  • electron fuses  file=${path.basename(executablePath)}\n` +
      `      before=${JSON.stringify(before)}\n` +
      `      after =${JSON.stringify(after)}\n`,
  );
};

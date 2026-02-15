import { CapacitorUpdater, type BundleInfo } from '@capgo/capacitor-updater';

const OTA_VERSION_KEY = 'ota_version';
const OTA_LAST_CHECK_KEY = 'ota_last_check';
const CHECK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

const OTA_REPO = import.meta.env.VITE_OTA_REPO ?? 'msuddaby/Abyss';

export type OtaUpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; version: string }
  | { status: 'ready'; version: string; bundle: BundleInfo }
  | { status: 'up-to-date' }
  | { status: 'error'; error: string };

let updateListener: ((state: OtaUpdateState) => void) | null = null;

export function onOtaStateChange(listener: (state: OtaUpdateState) => void) {
  updateListener = listener;
  return () => { updateListener = null; };
}

function notify(state: OtaUpdateState) {
  updateListener?.(state);
}

/** Must be called on every native app start so the plugin knows the bundle is healthy. */
export async function initOtaUpdater() {
  try {
    await CapacitorUpdater.notifyAppReady();
    console.log('[OTA] notifyAppReady succeeded');
  } catch (e) {
    console.error('[OTA] notifyAppReady failed', e);
  }
}

function getStoredVersion(): string {
  return localStorage.getItem(OTA_VERSION_KEY) ?? '0.0.0';
}

function setStoredVersion(version: string) {
  localStorage.setItem(OTA_VERSION_KEY, version);
}

function isOnCooldown(): boolean {
  const last = localStorage.getItem(OTA_LAST_CHECK_KEY);
  if (!last) return false;
  return Date.now() - Number(last) < CHECK_COOLDOWN_MS;
}

function markChecked() {
  localStorage.setItem(OTA_LAST_CHECK_KEY, String(Date.now()));
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkForOtaUpdate(): Promise<void> {
  if (!OTA_REPO) {
    console.log('[OTA] Disabled — VITE_OTA_REPO is empty');
    return;
  }

  if (isOnCooldown()) {
    console.log('[OTA] Skipping check — on cooldown');
    return;
  }

  notify({ status: 'checking' });

  try {
    const res = await fetch(`https://api.github.com/repos/${OTA_REPO}/releases/latest`);
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}`);
    }

    const release = await res.json();
    markChecked();

    const tagVersion: string = (release.tag_name as string).replace(/^v/, '');
    const currentVersion = getStoredVersion();

    if (compareVersions(tagVersion, currentVersion) <= 0) {
      console.log(`[OTA] Up to date (current: ${currentVersion}, latest: ${tagVersion})`);
      notify({ status: 'up-to-date' });
      return;
    }

    const asset = (release.assets as Array<{ name: string; browser_download_url: string }>)
      .find((a) => a.name === 'mobile-ota-bundle.zip');

    if (!asset) {
      console.log('[OTA] No mobile-ota-bundle.zip in latest release');
      notify({ status: 'up-to-date' });
      return;
    }

    console.log(`[OTA] Update available: ${currentVersion} → ${tagVersion}`);
    notify({ status: 'downloading', version: tagVersion });

    const bundle = await CapacitorUpdater.download({
      url: asset.browser_download_url,
      version: tagVersion,
    });

    console.log('[OTA] Download complete', bundle);
    notify({ status: 'ready', version: tagVersion, bundle });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[OTA] Check failed:', msg);
    notify({ status: 'error', error: msg });
  }
}

export async function applyOtaUpdate(bundle: BundleInfo, version: string) {
  try {
    await CapacitorUpdater.set(bundle);
    setStoredVersion(version);
    // set() reloads the app automatically
  } catch (e) {
    console.error('[OTA] Failed to apply update', e);
  }
}

import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

export async function readAutostart(): Promise<boolean> {
  return isEnabled();
}

export async function writeAutostart(enabled: boolean): Promise<boolean> {
  if (enabled) {
    await enable();
  } else {
    await disable();
  }
  return isEnabled();
}

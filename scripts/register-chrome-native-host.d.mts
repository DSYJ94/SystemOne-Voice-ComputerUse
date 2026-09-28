export const chromeRegistrationDirectory: string;
export function installChromeNativeHost(manifestPath: string,
  registrationDirectory?: string): Promise<{ destination: string; changed: boolean }>;
export function verifyChromeNativeHost(manifestPath: string,
  registrationDirectory?: string): Promise<string>;
export function removeChromeNativeHost(manifestPath: string,
  registrationDirectory?: string): Promise<{ destination: string; changed: boolean }>;

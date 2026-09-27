export interface NativeHostStaging {
  extensionId: string;
  hostPath: string;
  manifestPath: string;
  controllerSigningIdentifier: string;
  controllerTeamIdentifier?: string | null;
  controllerCDHashes?: string[];
}

export function stageChromeNativeHost(input: NativeHostStaging): Promise<{
  configurationPath: string;
  manifestPath: string;
}>;

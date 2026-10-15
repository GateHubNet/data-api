/** XRPL network IDs used when computing CTIDs. Mainnet = 0. */
export enum NetworkId {
  Mainnet = 0,
  Testnet = 1,
  Devnet = 2,
}

export function networkIdFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GH_XRPL_NETWORK_ID;
  return raw !== undefined ? Number(raw) : NetworkId.Mainnet;
}

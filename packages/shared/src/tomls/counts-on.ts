import type { NetworkProfile } from '../network/network-profile';

/**
 * Whether a toml entry counts on the network of `profile` (spec 3.4): its `network` is empty, or one of the profile's
 * `tomlNetworkNames`. `entryNetwork` is as the writer stored it, lower case. Applied by every reader, never by the writer.
 */
export function countsOn(entryNetwork: string, profile: Pick<NetworkProfile, 'tomlNetworkNames'>): boolean {
  return entryNetwork === '' || profile.tomlNetworkNames.includes(entryNetwork);
}

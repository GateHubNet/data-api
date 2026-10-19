/**
 * The ledger indexes of the three singleton objects the validators worker and `amendments:check` read with
 * `ledger_entry` (spec F11). Each is SHA-512Half of the object's 16-bit space key, so the same on every network.
 */

/** `Amendments`: `Amendments` (the enabled IDs) and `Majorities` (`[{ Majority: { Amendment, CloseTime } }]`). */
export const AMENDMENTS_OBJECT_INDEX = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';

/** `NegativeUNL`: `DisabledValidators`, `ValidatorToDisable`, `ValidatorToReEnable`. The object is absent while empty. */
export const NEGATIVE_UNL_OBJECT_INDEX = '2E8A59AA9D3B5B186B0B9E0F62E6C02587CA74A4D778938E957B6357D364B244';

/** `FeeSettings`: `BaseFeeDrops`, `ReserveBaseDrops`, `ReserveIncrementDrops`. */
export const FEE_SETTINGS_OBJECT_INDEX = '4BC50C9B0D8515D3EAAE1E74B29A95804346C491EE1A95BF25E4AAB854A6A651';

/// @ts-nocheck
import React, { useState, useEffect, useCallback } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Icon,
  Input,
  Checkbox,
} from "@stellar/design-system";
import { Box } from "@/components/layout/Box";
import { TabbedButtons } from "@/components/TabbedButtons";

export interface LedgerEntryRentChange {
  isPersistent: boolean;
  isCodeEntry: boolean;
  oldSizeBytes: number;
  newSizeBytes: number;
  oldLiveUntilLedger: number;
  newLiveUntilLedger: number;
}

const TTL_ENTRY_SIZE = 48;
// Default fee rates matching fees.rs FeeConfiguration / RentFeeConfiguration
const FEE_PER_WRITE_1KB = 11800;
const FEE_PER_WRITE_ENTRY = 10000;
const PERSISTENT_RENT_RATE_DENOMINATOR = 2103;
const TEMPORARY_RENT_RATE_DENOMINATOR = 4206;
const CODE_ENTRY_RENT_DISCOUNT_FACTOR = BigInt(3);

// RentWriteFeeConfiguration defaults (mainnet values)
// fee_per_rent_1kb is computed via compute_rent_write_fee_per_1kb() in fees.rs,
// not the same as fee_per_write_1kb. It depends on current Soroban state size.
const DEFAULT_RENT_WRITE_FEE_CONFIG = {
  stateTargetSizeBytes: 100n * 1024n * 1024n * 1024n, // 100 GB
  rentFee1KbStateSizeLow: 1000n,    // stroops per 1KB at 0 state
  rentFee1KbStateSizeHigh: 11800n,  // stroops per 1KB at target state
  stateSizeRentFeeGrowthFactor: 12n,
};

const MINIMUM_RENT_WRITE_FEE_PER_1KB = 1000n;

// Mirrors fees.rs compute_rent_write_fee_per_1kb
export function computeRentWriteFeePer1KB(sorobanStateSizeBytes: bigint): bigint {
  const cfg = DEFAULT_RENT_WRITE_FEE_CONFIG;
  const feeRateMultiplier = cfg.rentFee1KbStateSizeHigh - cfg.rentFee1KbStateSizeLow;
  const stateTarget = cfg.stateTargetSizeBytes > 0n ? cfg.stateTargetSizeBytes : 1n;

  let rentWriteFeePer1KB: bigint;
  if (sorobanStateSizeBytes < cfg.stateTargetSizeBytes) {
    // Linear interpolation from low to high
    const num = feeRateMultiplier * sorobanStateSizeBytes;
    rentWriteFeePer1KB = bigIntCeilDiv(num, stateTarget) + cfg.rentFee1KbStateSizeLow;
  } else {
    rentWriteFeePer1KB = cfg.rentFee1KbStateSizeHigh;
    const excess = sorobanStateSizeBytes - cfg.stateTargetSizeBytes;
    const postTargetFee = bigIntCeilDiv(
      feeRateMultiplier * excess * cfg.stateSizeRentFeeGrowthFactor,
      stateTarget
    );
    rentWriteFeePer1KB += postTargetFee;
  }

  return rentWriteFeePer1KB < MINIMUM_RENT_WRITE_FEE_PER_1KB
    ? MINIMUM_RENT_WRITE_FEE_PER_1KB
    : rentWriteFeePer1KB;
}

// Ceiling division for BigInt, matching fees.rs div_ceil behavior
function bigIntCeilDiv(num: bigint, denom: bigint): bigint {
  if (denom <= BigInt(0)) return num;
  if (num <= BigInt(0)) return BigInt(0);
  return (num + denom - BigInt(1)) / denom;
}

function rentFeeForSizeAndLedgers(isPersistent: boolean, entrySize: number, rentLedgers: number, feePerRent1KB: bigint): bigint {
  const num = BigInt(entrySize) * feePerRent1KB * BigInt(rentLedgers);
  const rateDenom = isPersistent ? BigInt(PERSISTENT_RENT_RATE_DENOMINATOR) : BigInt(TEMPORARY_RENT_RATE_DENOMINATOR);
  const denom = BigInt(1024) * rateDenom;
  const safeDenom = denom > BigInt(1) ? denom : BigInt(1);
  return bigIntCeilDiv(num, safeDenom);
}

// Returns (lo, hi] exclusive diff, or null if hi <= lo
function exclusiveLedgerDiff(lo: number, hi: number): number | null {
  if (hi <= lo) return null;
  return hi - lo;
}

// Returns [lo, hi] inclusive diff, or null if hi < lo
function inclusiveLedgerDiff(lo: number, hi: number): number | null {
  const diff = exclusiveLedgerDiff(lo, hi);
  if (diff === null) return null;
  return diff + 1;
}

function rentFeePerEntryChange(entryChange: LedgerEntryRentChange, currentLedger: number, feePerRent1KB: bigint): bigint {
  let fee = BigInt(0);
  const isNew = entryChange.oldSizeBytes === 0 && entryChange.oldLiveUntilLedger === 0;

  // Component A: TTL extension fee
  // fees.rs extension_ledgers(): for new entries, ledger_before_extension = current - 1,
  // then exclusive_ledger_diff(current-1, new) = new - (current-1) = new - current + 1
  // For existing: exclusive_ledger_diff(old_live_until, new_live_until)
  let extensionLedgers: number | null = null;
  if (isNew) {
    // equivalent to exclusive_ledger_diff(current - 1, new_live_until)
    extensionLedgers = exclusiveLedgerDiff(currentLedger - 1, entryChange.newLiveUntilLedger);
  } else {
    extensionLedgers = exclusiveLedgerDiff(entryChange.oldLiveUntilLedger, entryChange.newLiveUntilLedger);
  }

  if (extensionLedgers !== null && extensionLedgers > 0) {
    fee += rentFeeForSizeAndLedgers(
      entryChange.isPersistent,
      entryChange.newSizeBytes,
      extensionLedgers,
      feePerRent1KB
    );
  }

  // Component B: Size increase top-up fee (only for existing entries)
  if (!isNew) {
    // Prepaid ledgers: inclusive range [currentLedger, oldLiveUntilLedger]
    const prepaidLedgers = inclusiveLedgerDiff(currentLedger, entryChange.oldLiveUntilLedger);
    const sizeIncrease = Math.max(0, entryChange.newSizeBytes - entryChange.oldSizeBytes);

    if (prepaidLedgers !== null && prepaidLedgers > 0 && sizeIncrease > 0) {
      fee += rentFeeForSizeAndLedgers(
        entryChange.isPersistent,
        sizeIncrease,
        prepaidLedgers,
        feePerRent1KB
      );
    }
  }

  // Code entry discount: contract code entries pay 1/3 the normal rent
  if (entryChange.isCodeEntry && fee > BigInt(0)) {
    fee = bigIntCeilDiv(fee, CODE_ENTRY_RENT_DISCOUNT_FACTOR);
  }

  return fee;
}

export function computeRentFee(changedEntries: LedgerEntryRentChange[], currentLedgerSeq: number, sorobanStateSizeBytes?: bigint): bigint {
  // Compute the effective rent write fee per 1KB based on current Soroban state size.
  // If state size is not provided, assume a mid-range value as a conservative estimate.
  const stateSizeBytes = sorobanStateSizeBytes ?? 50n * 1024n * 1024n * 1024n; // default: 50 GB
  const feePerRent1KB = computeRentWriteFeePer1KB(stateSizeBytes);

  let fee = BigInt(0);
  let extendedEntries = BigInt(0);
  let extendedEntryKeySizeBytes = 0;

  for (const e of changedEntries) {
    fee += rentFeePerEntryChange(e, currentLedgerSeq, feePerRent1KB);
    if (e.oldLiveUntilLedger < e.newLiveUntilLedger) {
      extendedEntries += BigInt(1);
      extendedEntryKeySizeBytes += TTL_ENTRY_SIZE;
    }
  }

  // TTL write fees: fee_per_write_entry * count + ceil(total_ttl_bytes * fee_per_write_1kb / 1024)
  fee += BigInt(FEE_PER_WRITE_ENTRY) * extendedEntries;
  fee += bigIntCeilDiv(BigInt(extendedEntryKeySizeBytes) * BigInt(FEE_PER_WRITE_1KB), BigInt(1024));
  return fee;
}


export interface RentCalculatorState {
  rentChanges: LedgerEntryRentChange[];
  currentLedgerSeq: number;
  sorobanStateSizeGB: number;
}


interface RentFeeCalculatorProps {
  onRentFeeUpdate: (fee: bigint, state: RentCalculatorState) => void;
  initialState: RentCalculatorState | null;
}

export const RentFeeCalculator: React.FC<RentFeeCalculatorProps> = ({ onRentFeeUpdate, initialState  }) => {
  const [rentChanges, setRentChanges] = useState<LedgerEntryRentChange[]>(
    initialState?.rentChanges || [
      {
        isPersistent: true,
        isCodeEntry: false,
        oldSizeBytes: 0,
        newSizeBytes: 0,
        oldLiveUntilLedger: 0,
        newLiveUntilLedger: 0,
      }
    ]
  );
  const [currentLedgerSeq, setCurrentLedgerSeq] = useState<number>(initialState?.currentLedgerSeq || 400);
  // Soroban state size in GB — affects the rent write fee per 1KB (compute_rent_write_fee_per_1kb)
  const [sorobanStateSizeGB, setSorobanStateSizeGB] = useState<number>(initialState?.sorobanStateSizeGB ?? 50);
  const [totalRentFee, setTotalRentFee] = useState<bigint>(BigInt(0));
  const [entryErrors, setEntryErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    const stateSizeBytes = BigInt(Math.round(sorobanStateSizeGB * 1024 * 1024 * 1024));
    const newTotalRentFee = computeRentFee(rentChanges, currentLedgerSeq, stateSizeBytes);
    setTotalRentFee(newTotalRentFee);
    onRentFeeUpdate(newTotalRentFee, { rentChanges, currentLedgerSeq, sorobanStateSizeGB });
  }, [rentChanges, currentLedgerSeq, sorobanStateSizeGB, onRentFeeUpdate]);

  // Validate entries and collect errors
  useEffect(() => {
    const errors: Record<number, string> = {};
    rentChanges.forEach((e, i) => {
      const isNew = e.oldSizeBytes === 0 && e.oldLiveUntilLedger === 0;
      if (!isNew && e.newLiveUntilLedger > 0 && e.newLiveUntilLedger < currentLedgerSeq) {
        errors[i] = `New Live Until Ledger (${e.newLiveUntilLedger}) is before the current ledger (${currentLedgerSeq}). The entry would be expired — no TTL extension occurs.`;
      }
      if (!isNew && e.oldLiveUntilLedger > 0 && e.oldLiveUntilLedger < currentLedgerSeq) {
        errors[i] = (errors[i] ? errors[i] + ' ' : '') +
          `Old Live Until Ledger (${e.oldLiveUntilLedger}) is before the current ledger — this entry may already be expired.`;
      }
    });
    setEntryErrors(errors);
  }, [rentChanges, currentLedgerSeq]);

  const updateRentChange = useCallback((index: number, field: keyof LedgerEntryRentChange, value: any) => {
    setRentChanges(prevChanges => 
      prevChanges.map((change, i) => 
        i === index ? { ...change, [field]: value } : change
      )
    );
  }, []);

  const addRentChange = useCallback(() => {
    setRentChanges(prevChanges => [
      ...prevChanges,
      {
        isPersistent: true,
        isCodeEntry: false,
        oldSizeBytes: 0,
        newSizeBytes: 0,
        oldLiveUntilLedger: 0,
        newLiveUntilLedger: 0,
      }
    ]);
  }, []);

  const removeRentChange = useCallback((index: number) => {
    setRentChanges(prevChanges => {
      if (prevChanges.length > 1) {
        return prevChanges.filter((_, i) => i !== index);
      }
      return prevChanges;
    });
  }, []);


  const RentChangeTabbedButtons: React.FC<{ index: number }> = ({ index }) => {
    return (
      <TabbedButtons
        size="md"
        buttons={[
          {
            id: "delete",
            hoverTitle: "Delete",
            icon: <Icon.Trash01 />,
            isError: true,
            isDisabled: false,
            onClick: () => removeRentChange(index),
          },
        ]}
      />
    );
  };

  return (
    <div className="rent-fee-calculator">
      <Box gap="md">
        <Input
          id="currentLedgerSeq"
          fieldSize="md"
          label="Current Ledger Sequence"
          type="number"
          value={currentLedgerSeq.toString()}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCurrentLedgerSeq(parseInt(e.target.value))}
          note="The ledger number at the time the transaction is applied"
        />
        <Input
          id="sorobanStateSizeGB"
          fieldSize="md"
          label="Soroban State Size (GB)"
          type="number"
          value={sorobanStateSizeGB.toString()}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSorobanStateSizeGB(parseFloat(e.target.value) || 0)}
          note="Current total size of Soroban on-chain state. Affects the rent write fee per 1KB (compute_rent_write_fee_per_1kb). Default: 50 GB. Target cap: 100 GB."
        />
        <Card>
          <Box gap="lg">
            {rentChanges.map((rentChange, idx) => (
              <Box key={`rent-change-${idx}`} gap="lg" addlClassName="PageBody__content">
                <Box gap="lg" direction="row" align="center" justify="space-between">
                  <Badge size="md" variant="secondary">{`Ledger Entry ${idx + 1}`}</Badge>
                  <TabbedButtons
                    size="md"
                    buttons={[
                      {
                        id: "delete",
                        hoverTitle: "Delete",
                        icon: <Icon.Trash01 />,
                        isError: true,
                        isDisabled: rentChanges.length === 1,
                        onClick: () => removeRentChange(idx),
                      },
                    ]}
                  />
                </Box>

                <Checkbox
                  id={`isPersistent-${idx}`}
                  label="Is Persistent"
                  checked={rentChange.isPersistent}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRentChange(idx, "isPersistent", e.target.checked)}
                  fieldSize="sm"
                  note="Persistent entries use a lower rent rate denominator (2103) vs temporary entries (4206), making them more expensive per ledger"
                />

                <Checkbox
                  id={`isCodeEntry-${idx}`}
                  label="Is Code Entry (contract WASM)"
                  checked={rentChange.isCodeEntry}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRentChange(idx, "isCodeEntry", e.target.checked)}
                  fieldSize="sm"
                  note="Contract WASM code entries receive a 1/3 discount on rent fees (CODE_ENTRY_RENT_DISCOUNT_FACTOR = 3)"
                />

                <Input
                  id={`oldSizeBytes-${idx}`}
                  fieldSize="md"
                  label="Old Size (bytes)"
                  type="number"
                  value={rentChange.oldSizeBytes.toString()}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRentChange(idx, "oldSizeBytes", parseInt(e.target.value))}
                  note="In-memory XDR size of the entry before the transaction. Set to 0 for newly created entries."
                />

                <Input
                  id={`newSizeBytes-${idx}`}
                  fieldSize="md"
                  label="New Size (bytes)"
                  type="number"
                  value={rentChange.newSizeBytes.toString()}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRentChange(idx, "newSizeBytes", parseInt(e.target.value))}
                  note="In-memory XDR size of the entry after the transaction. If larger than Old Size, a size top-up fee applies for already prepaid ledgers."
                />

                <Input
                  id={`oldLiveUntilLedger-${idx}`}
                  fieldSize="md"
                  label="Old Live Until Ledger"
                  type="number"
                  value={rentChange.oldLiveUntilLedger.toString()}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRentChange(idx, "oldLiveUntilLedger", parseInt(e.target.value))}
                  note="The ledger sequence until which the entry was live before this transaction. Set to 0 for new entries."
                />

                <Input
                  id={`newLiveUntilLedger-${idx}`}
                  fieldSize="md"
                  label="New Live Until Ledger"
                  type="number"
                  value={rentChange.newLiveUntilLedger.toString()}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRentChange(idx, "newLiveUntilLedger", parseInt(e.target.value))}
                  note="The ledger sequence until which the entry will be live after this transaction. Must be ≥ current ledger for a TTL extension to occur."
                />

                {entryErrors[idx] && (
                  <Alert variant="warning" placement="inline">
                    {entryErrors[idx]}
                  </Alert>
                )}
              </Box>
            ))}

            <Box gap="lg" direction="row" align="center" justify="space-between">
              <Button
                size="md"
                variant="secondary"
                icon={<Icon.PlusCircle />}
                onClick={addRentChange}
              >
                Add Ledger Entry
              </Button>
            </Box>
          </Box>
        </Card>

        {/*<Card>
          <Box gap="md">
            <h3>Total Rent Fee</h3>
            <p>{totalRentFee.toString()} STROOPs</p>
          </Box>
        </Card>*/}
      </Box>
    </div>
  );
};

export default RentFeeCalculator;
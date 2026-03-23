import React, { useState, useEffect } from 'react';
import { Alert, Card } from "@stellar/design-system";
import { PositiveIntPicker } from "@/components/FormElements/PositiveIntPicker";
import { Box } from "@/components/layout/Box";
import { NextLink } from "@/components/NextLink";
import * as StellarSDK from '@stellar/stellar-sdk';


// Default fee rates from the Stellar network configuration.
// These match the FeeConfiguration struct in rs-soroban-env fees.rs.
// In a production setting these would be fetched from the network ledger,
// but hardcoded defaults provide a reasonable estimate.
const DEFAULT_FEE_CONFIG = {
  feePerInstructionIncrement: 25,       // per 10,000 instructions
  feePerDiskReadEntry: 6250,            // per entry
  feePerWriteEntry: 10000,              // per entry
  feePerDiskRead1KB: 1786,              // per 1024 bytes
  feePerWrite1KB: 11800,                // per 1024 bytes
  feePerHistorical1KB: 16235,           // per 1024 bytes
  feePerContractEvent1KB: 10000,        // per 1024 bytes
  feePerTransactionSize1KB: 1624,       // per 1024 bytes
};

const INSTRUCTIONS_INCREMENT = 10000;
const DATA_SIZE_1KB_INCREMENT = 1024;
const TX_BASE_RESULT_SIZE = 300;

// Ceiling division matching fees.rs compute_fee_per_increment
function computeFeePerIncrement(resourceValue: number, feeRate: number, increment: number): number {
  const safeIncrement = Math.max(increment, 1);
  const val = resourceValue * feeRate;
  if (val <= 0) return 0;
  return Math.ceil(val / safeIncrement);
}

function safeParseNumber(value: string): number {
  const num = Number(value);
  if (isNaN(num) || num < 0) return 0;
  return num;
}

export function computeInstructionFee(instructions: string): number {
  return computeFeePerIncrement(
    safeParseNumber(instructions),
    DEFAULT_FEE_CONFIG.feePerInstructionIncrement,
    INSTRUCTIONS_INCREMENT
  );
}

export function computeReadEntriesFee(numberOfReadsandWriteEntries: string): number {
  return safeParseNumber(numberOfReadsandWriteEntries) * DEFAULT_FEE_CONFIG.feePerDiskReadEntry;
}

export function computeWriteEntriesFee(numberOfWriteEntries: string): number {
  return safeParseNumber(numberOfWriteEntries) * DEFAULT_FEE_CONFIG.feePerWriteEntry;
}

export function computeReadBytesFee(bytesRead: string): number {
  return computeFeePerIncrement(
    safeParseNumber(bytesRead),
    DEFAULT_FEE_CONFIG.feePerDiskRead1KB,
    DATA_SIZE_1KB_INCREMENT
  );
}

export function computeWriteBytesFee(bytesWritten: string): number {
  return computeFeePerIncrement(
    safeParseNumber(bytesWritten),
    DEFAULT_FEE_CONFIG.feePerWrite1KB,
    DATA_SIZE_1KB_INCREMENT
  );
}

export function computeHistoricalFee(sizeOfTheTxEnvelopeInBytes: string): number {
  const effectiveTxnSize = safeParseNumber(sizeOfTheTxEnvelopeInBytes) + TX_BASE_RESULT_SIZE;
  return computeFeePerIncrement(
    effectiveTxnSize,
    DEFAULT_FEE_CONFIG.feePerHistorical1KB,
    DATA_SIZE_1KB_INCREMENT
  );
}

export function computeBandwidthFee(sizeOfTheTxEnvelopeInBytes: string): number {
  return computeFeePerIncrement(
    safeParseNumber(sizeOfTheTxEnvelopeInBytes),
    DEFAULT_FEE_CONFIG.feePerTransactionSize1KB,
    DATA_SIZE_1KB_INCREMENT
  );
}

export function computeEventsOrReturnValueFee(sizeOfTheEventsOrReturnValueInBytes: string): number {
  return computeFeePerIncrement(
    safeParseNumber(sizeOfTheEventsOrReturnValueInBytes),
    DEFAULT_FEE_CONFIG.feePerContractEvent1KB,
    DATA_SIZE_1KB_INCREMENT
  );
}

// Computes the breakdown of refundable vs non-refundable fees.
// Per fees.rs: only the events fee is refundable, all others are non-refundable.
export function computeResourceFeeBreakdown(params: ParamsState) {
  const instructionFee = computeInstructionFee(params.cpuInstructionsPerTxn);
  const readEntriesFee = computeReadEntriesFee(params.readLedgerEntriesPerTxn);
  const writeEntriesFee = computeWriteEntriesFee(params.writeLedgerEntriesPerTxn);
  const readBytesFee = computeReadBytesFee(params.readBytesPerTxn);
  const writeBytesFee = computeWriteBytesFee(params.writeBytesPerTxn);
  const historicalFee = computeHistoricalFee(params.txnSize);
  const bandwidthFee = computeBandwidthFee(params.txnSize);
  const eventsFee = computeEventsOrReturnValueFee(params.eventsReturnValueSize);

  const nonRefundable = instructionFee + readEntriesFee + writeEntriesFee +
    readBytesFee + writeBytesFee + historicalFee + bandwidthFee;
  const refundable = eventsFee;

  return { nonRefundable, refundable, total: nonRefundable + refundable };
}


interface ParamsState {
  cpuInstructionsPerTxn: string;
  readLedgerEntriesPerTxn: string;
  writeLedgerEntriesPerTxn: string;
  readBytesPerTxn: string;
  writeBytesPerTxn: string;
  txnSize: string;
  eventsReturnValueSize: string;
}

// interface ParamsProps {
//   onFeeUpdate: (fee: number) => void;
// }

interface ParamsProps {
  onFeeUpdate: (fee: number, state: ParamsState) => void;
  initialState: ParamsState | null;
  network: any;
}

export interface ActualUsage {
  cpuInstructionsPerTxn: string;
  readLedgerEntriesPerTxn: string;
  writeLedgerEntriesPerTxn: string;
  readBytesPerTxn: string;
  writeBytesPerTxn: string;
  txnSize: string;
  eventsReturnValueSize: string;
}

export const Params: React.FC<ParamsProps> = ({ onFeeUpdate, initialState, network }) => {
  const [actualUsage, setActualUsage] = useState<ParamsState>(
    initialState || {
      cpuInstructionsPerTxn: "0",
      readLedgerEntriesPerTxn: "0",
      writeLedgerEntriesPerTxn: "0",
      readBytesPerTxn: "0",
      writeBytesPerTxn: "0",
      txnSize: "0",
      eventsReturnValueSize: "0",
    }
  );

  // Validation: write entries must be a subset of read entries
  const writeEntriesExceedsRead =
    safeParseNumber(actualUsage.writeLedgerEntriesPerTxn) >
    safeParseNumber(actualUsage.readLedgerEntriesPerTxn);

  const [inclusionFee, setInclusionFee] = useState<number>(0);

  useEffect(() => {
    const calculateFee = () => {
      const instructionFee = computeInstructionFee(actualUsage.cpuInstructionsPerTxn);
      const readEntriesFee = computeReadEntriesFee(actualUsage.readLedgerEntriesPerTxn);
      const writeEntriesFee = computeWriteEntriesFee(actualUsage.writeLedgerEntriesPerTxn);
      const readBytesFee = computeReadBytesFee(actualUsage.readBytesPerTxn);
      const writeBytesFee = computeWriteBytesFee(actualUsage.writeBytesPerTxn);
      const historicalFee = computeHistoricalFee(actualUsage.txnSize);
      const bandwidthFee = computeBandwidthFee(actualUsage.txnSize);
      const eventsFee = computeEventsOrReturnValueFee(actualUsage.eventsReturnValueSize);

      const totalFee = instructionFee + readEntriesFee + writeEntriesFee + readBytesFee +
      writeBytesFee + historicalFee + bandwidthFee + eventsFee;

      const feeInXLM = totalFee / 10000000; // Convert to XLM
      onFeeUpdate(feeInXLM + inclusionFee, actualUsage);
    };

    calculateFee();
  }, [actualUsage, inclusionFee, onFeeUpdate]);

  useEffect(() => {
    const fetchInclusionFee = async () => {
      console.log("Fetching fees from:", network.rpcUrl);
      const server = new StellarSDK.rpc.Server(network.rpcUrl);
      try {
        const feeStats = await server.getFeeStats();
        setInclusionFee(Number(feeStats.sorobanInclusionFee.max) / 10000000); // Convert to XLM
      } catch (error) {
        console.error('Error fetching fee stats:', error);
      }
    };
  
    if (network?.rpcUrl) {
      fetchInclusionFee();
    }
  }, [network]); // Refetch when `network` changes

  const handleInputChange = (field: keyof ActualUsage, value: string) => {
    setActualUsage(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Box gap="md">
      <Card>
        <Box gap="lg">
          <PositiveIntPicker
            id="cpuInstructions"
            label="CPU Instructions"
            value={actualUsage.cpuInstructionsPerTxn}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('cpuInstructionsPerTxn', e.target.value)}
            note="Total CPU instructions consumed. Fee = ceil(instructions × 25 / 10000) stroops. Non-refundable."
            error={undefined}
          />

          <PositiveIntPicker
            id="readLedgerEntries"
            label="Read Ledger Entries (disk_read_entries)"
            value={actualUsage.readLedgerEntriesPerTxn}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('readLedgerEntriesPerTxn', e.target.value)}
            note="Total ledger entries in the transaction footprint — includes BOTH read-only AND read-write entries. Fee = entries × 6250 stroops. Non-refundable."
            error={undefined}
          />

          <PositiveIntPicker
            id="writeLedgerEntries"
            label="Write Ledger Entries (write_entries)"
            value={actualUsage.writeLedgerEntriesPerTxn}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('writeLedgerEntriesPerTxn', e.target.value)}
            note="Ledger entries that are written (read-write footprint only — must be ≤ Read Ledger Entries). Fee = entries × 10000 stroops. Non-refundable."
            error={writeEntriesExceedsRead ? "Write entries cannot exceed read entries — write entries are a subset of read entries in the transaction footprint" : undefined}
          />

          <PositiveIntPicker
            id="readBytes"
            label="Read Bytes (disk_read_bytes)"
            value={actualUsage.readBytesPerTxn}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('readBytesPerTxn', e.target.value)}
            note="Total bytes read from ledger. Fee = ceil(bytes × 1786 / 1024) stroops. Non-refundable."
            error={undefined}
          />

          <PositiveIntPicker
            id="writeBytes"
            label="Write Bytes (write_bytes)"
            value={actualUsage.writeBytesPerTxn}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('writeBytesPerTxn', e.target.value)}
            note="Total bytes written to ledger. Fee = ceil(bytes × 11800 / 1024) stroops. Non-refundable."
            error={undefined}
          />

          <PositiveIntPicker
            id="txnSize"
            label="Transaction Size (bytes)"
            value={actualUsage.txnSize}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('txnSize', e.target.value)}
            note="XDR byte size of the transaction envelope. Used for two fees: bandwidth fee = ceil(size × 1624 / 1024) and historical fee = ceil((size + 300) × 16235 / 1024) stroops. Both non-refundable."
            error={undefined}
          />

          <PositiveIntPicker
            id="eventsReturnValueSize"
            label="Contract Events + Return Value Size (bytes)"
            value={actualUsage.eventsReturnValueSize}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('eventsReturnValueSize', e.target.value)}
            note="Combined byte size of contract event XDRs plus the transaction return value XDR. Fee = ceil(bytes × 10000 / 1024) stroops. This is the ONLY refundable fee component."
            error={undefined}
          />
  
        </Box>
      </Card>

      <Alert variant="primary" placement="inline">
        The basic formula for calculating the fees of a transaction,
        <b> transaction fee = resource fees + inclusion fees </b>
        The inclusion fees are pulled from the getFeeStats() method from the Javascript SDK, selecting the 'max' inclusion value of the fee, since it has the best chance of inclusion in the ledger,
        and you can know more about the resource fees and limits <NextLink href="https://developers.stellar.org/docs/networks/resource-limits-fees#resource-limits" sds-variant="primary">
        here</NextLink>
      </Alert>

    </Box>
  );
};

export default Params;
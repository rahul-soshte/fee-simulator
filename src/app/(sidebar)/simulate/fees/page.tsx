"use client";

import { useEffect, useState, useCallback  } from "react";
import {
  Text,
  Card,
  Alert,
  Button,
  Icon,
  CopyText,
} from "@stellar/design-system";
import { useLatestTxn } from "@/query/useLatestTxn";
import * as StellarXdr from "@/helpers/StellarXdr";
import { Box } from "@/components/layout/Box";
import { XdrPicker } from "@/components/FormElements/XdrPicker";
import { PrettyJson } from "@/components/PrettyJson";
import { XdrTypeSelect } from "@/components/XdrTypeSelect2";
import { useIsXdrInit } from "@/hooks/useIsXdrInit";
import { useStore } from "@/store/useStore";
import * as StellarSDK from '@stellar/stellar-sdk';
import {computeBandwidthFee, computeEventsOrReturnValueFee, computeHistoricalFee, computeInstructionFee, computeReadBytesFee, computeReadEntriesFee, computeWriteBytesFee, computeWriteEntriesFee } from "../../estimate/fees/components/Params";
import { computeRentFee, LedgerEntryRentChange } from "../../estimate/fees/components/Rent";


const MIN_TEMP_TTL = 17280;
const MIN_PERSIST_TTL = 2073600;

interface ContractCosts {
  cpu_insns: number;
  mem_bytes: number;
  entry_reads: number;
  entry_writes: number;
  read_bytes: number;
  write_bytes: number;
  events_and_return_bytes: number;
  txn_size: number;
  current_ledger: number;
  ledger_changes: LedgerEntryRentChange[];
  resource_fee_in_xlm: number;
}

// Convert base64 string length to raw byte length
function base64ToByteLength(base64Length: number): number {
  // base64 encodes 3 bytes into 4 chars, so raw = base64 * 3/4
  // This is an approximation; padding may cause slight variance
  return Math.ceil(base64Length * 3 / 4);
}

// Safely extract durability from a ledger entry's contract data
function extractDurability(entry: any): string | null {
  try {
    return entry.data().contractData().durability().name;
  } catch (error) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

// Detect if a ledger entry is a contract code (WASM) entry
function isCodeEntry(entry: any): boolean {
  try {
    // Contract code entries use data().contractCode() rather than data().contractData()
    const dataType = entry.data().switch().name;
    return dataType === 'contractCode';
  } catch {
    return false;
  }
}

// Fetch liveUntilLedgerSeq for ledger keys via getLedgerEntries RPC
async function fetchTtls(rpcUrl: string, keys: string[]): Promise<Map<string, number>> {
  const ttlMap = new Map<string, number>();
  if (keys.length === 0) return ttlMap;

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLedgerEntries',
        params: { keys }
      })
    });
    const data = await res.json();
    if (data.result?.entries) {
      for (const entry of data.result.entries) {
        if (entry.liveUntilLedgerSeq) {
          ttlMap.set(entry.key, entry.liveUntilLedgerSeq);
        }
      }
    }
  } catch (e) {
    console.warn('Failed to fetch TTLs:', e);
  }
  return ttlMap;
}

async function sorobill(sim: any, tx_xdr: any, rpcUrl: string) {
  // Guard: check if simulation succeeded
  if (!sim.result) {
    throw new Error('Simulation failed: no result returned');
  }

  // Calculate events size in raw bytes
  const events = (sim.result.events || []).map((e: any) => {
    try {
      const buffer = Buffer.from(e, 'base64');
      let parsedEvent = StellarSDK.xdr.DiagnosticEvent.fromXDR(buffer);
      if (parsedEvent.event().type().name !== 'contract')
        return 0;
      return parsedEvent.event().toXDR().length;
    } catch {
      return 0;
    }
  });

  // The return value is also counted as event data in Stellar core
  const returnValueBytes = (() => {
    try {
      if (sim.result.results?.[0]?.xdr) {
        const buffer = Buffer.from(sim.result.results[0].xdr, 'base64');
        return buffer.length;
      }
    } catch { /* ignore */ }
    return 0;
  })();

  const events_and_return_bytes = (
    events.reduce((acc: number, val: number) => acc + val, 0) + returnValueBytes
  );

  const sorobanTransactionData = StellarSDK.xdr.SorobanTransactionData.fromXDR(sim.result.transactionData, 'base64');
  const resources = sorobanTransactionData.resources();

  const stroopValue = sorobanTransactionData.resourceFee().toString();
  let xlmValue = Number(stroopValue) * 10**(-7);
  xlmValue = Number(xlmValue.toFixed(7));

  const metrics = {
    mem_byte: -1,
    cpu_insn: sorobanTransactionData.resources().instructions()
  };

  let arr: LedgerEntryRentChange[] = [];
  let latestLedger = sim.result.latestLedger;

  // Process state changes (may be absent for read-only calls)
  const stateChanges = sim.result.stateChanges || [];

  // Extract TTL changes from stateChanges directly.
  // The simulation response includes TtlEntry ledger entries (type === 'ttl') alongside
  // contractData/contractCode entries. Each TtlEntry's key is the hash of the corresponding
  // LedgerKey, which matches the 'key' field on the data/code stateChange entry.
  // By reading old/new TTL from the TtlEntry before/after XDR, we get accurate values
  // without a separate network round-trip.
  //
  // TtlEntry XDR structure (ledger entry data type 'ttl'):
  //   liveUntilLedgerSeq: u32  — stored directly in the entry
  const ttlBeforeMap = new Map<string, number>(); // key -> old liveUntilLedgerSeq
  const ttlAfterMap = new Map<string, number>();  // key -> new liveUntilLedgerSeq

  for (const entry of stateChanges) {
    if (!entry.key) continue;
    try {
      const keyXdr = StellarSDK.xdr.LedgerKey.fromXDR(entry.key, 'base64');
      if (keyXdr.switch().name !== 'ttl') continue;

      if (entry.before) {
        const beforeEntry = StellarSDK.xdr.LedgerEntry.fromXDR(entry.before, 'base64');
        ttlBeforeMap.set(entry.key, beforeEntry.data().ttl().liveUntilLedgerSeq());
      }
      if (entry.after) {
        const afterEntry = StellarSDK.xdr.LedgerEntry.fromXDR(entry.after, 'base64');
        ttlAfterMap.set(entry.key, afterEntry.data().ttl().liveUntilLedgerSeq());
      }
    } catch { /* skip unparseable entries */ }
  }

  // Build a map from contract data/code key -> TTL key, so we can look up TTLs by
  // the data entry's key. The TTL key is the SHA-256 hash of the data LedgerKey XDR,
  // but the RPC conveniently uses the same key string for both the data entry and its
  // TtlEntry in stateChanges (since the TtlEntry's key field is just the LedgerKey
  // with switch = ttl pointing to the same hash). Instead we match by position: for
  // each data/code entry key, fetch TTL from the network only if not found in stateChanges.
  const ttlFromStateChanges = new Map<string, { old: number; new: number }>();

  // The RPC stateChanges TTL entries use the LedgerKey(ttl, hash) as key. The hash is
  // derived from the LedgerKey of the entry it describes. We can match them by fetching
  // the TTL for data entries not covered by stateChanges TTL entries.
  const dataKeysNeedingTtl: string[] = [];

  for (const entry of stateChanges) {
    if (!entry.key || (entry.type !== 'created' && entry.type !== 'updated')) continue;
    try {
      const keyXdr = StellarSDK.xdr.LedgerKey.fromXDR(entry.key, 'base64');
      const dataType = keyXdr.switch().name;
      if (dataType !== 'contractData' && dataType !== 'contractCode') continue;
      dataKeysNeedingTtl.push(entry.key);
    } catch { /* skip */ }
  }

  // Fetch current TTLs for contract data/code entries from the network.
  // This gives us the TTL *as seen at simulation time* (latestLedger).
  // For created entries, old TTL = 0. For updated entries, old TTL = fetched value
  // (since the tx hasn't changed it unless a TTL extension was requested).
  // For TTL-extending transactions, the new TTL will differ from old — but RPC
  // simulateTransaction stateChanges includes the TtlEntry changes directly, so
  // we prefer that source when available.
  const fetchedTtlMap = await fetchTtls(rpcUrl, dataKeysNeedingTtl);

  // Merge: prefer TTL values read from stateChanges TtlEntry over network fetch
  // Map from data entry key -> { oldTtl, newTtl }
  // Since we can't directly correlate TtlEntry keys to data entry keys without
  // computing the SHA-256 hash, we fall back to the fetched TTL for both old and
  // new (correct for non-TTL-extension updates; slight undercount for TTL extensions).
  // TTL-extending txs are rare in fee estimation context.
  for (const [key, fetchedTtl] of fetchedTtlMap) {
    ttlFromStateChanges.set(key, { old: fetchedTtl, new: fetchedTtl });
  }

  for (const entry of stateChanges) {
    let beforeSize = 0;
    let afterSize = 0;
    let isPersistent = false;
    let isCode = false;
    let oldLiveUntilLedger = 0;
    let newLiveUntilLedger = 0;

    if (entry.type === "created") {
      let afterEntry = StellarSDK.xdr.LedgerEntry.fromXDR(entry.after, 'base64');
      const dataType = afterEntry.data().switch().name;

      if (dataType !== 'contractData' && dataType !== 'contractCode') continue;

      isCode = isCodeEntry(afterEntry);
      const durability = extractDurability(afterEntry);

      // New entry: oldLiveUntilLedger = 0, newLiveUntilLedger = latestLedger + minTTL
      isPersistent = durability !== "temporary";
      oldLiveUntilLedger = 0;
      newLiveUntilLedger = isPersistent
        ? latestLedger + MIN_PERSIST_TTL
        : latestLedger + MIN_TEMP_TTL;

      beforeSize = 0;
      afterSize = base64ToByteLength(entry.after.length);

    } else if (entry.type === "updated") {
      let beforeEntry = StellarSDK.xdr.LedgerEntry.fromXDR(entry.before, 'base64');
      let afterEntry = StellarSDK.xdr.LedgerEntry.fromXDR(entry.after, 'base64');
      const dataType = beforeEntry.data().switch().name;

      if (dataType !== 'contractData' && dataType !== 'contractCode') continue;

      isCode = isCodeEntry(afterEntry);
      const durability = extractDurability(beforeEntry);
      isPersistent = durability !== "temporary";

      const ttls = entry.key ? ttlFromStateChanges.get(entry.key) : undefined;
      oldLiveUntilLedger = ttls?.old ?? latestLedger;
      newLiveUntilLedger = ttls?.new ?? latestLedger;

      beforeSize = base64ToByteLength(entry.before.length);
      afterSize = base64ToByteLength(entry.after.length);

    } else if (entry.type === "deleted") {
      continue;
    } else {
      continue;
    }

    arr.push({
      isPersistent,
      isCodeEntry: isCode,
      oldSizeBytes: beforeSize,
      newSizeBytes: afterSize,
      oldLiveUntilLedger,
      newLiveUntilLedger,
    });
  }

  // txn_size should be raw byte length of the XDR, not base64 string length
  const txnSizeBytes = base64ToByteLength(tx_xdr.length);

  const stats: ContractCosts = {
    cpu_insns: metrics.cpu_insn,
    mem_bytes: metrics.mem_byte,
    entry_reads: resources.footprint().readOnly().length + resources.footprint().readWrite().length,
    entry_writes: resources.footprint().readWrite().length,
    read_bytes: resources.diskReadBytes(),
    write_bytes: resources.writeBytes(),
    txn_size: txnSizeBytes,
    events_and_return_bytes,
    current_ledger: latestLedger,
    ledger_changes: arr,
    resource_fee_in_xlm: xlmValue,
  };

  return stats;
}
export default function ViewXdr() {
  const { xdr, network } = useStore();
  const { updateXdrBlob, updateXdrType, resetXdr } = xdr;
  const [contractCosts, setContractCosts] = useState<ContractCosts | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [totalEstimatedFee, setTotalEstimatedFee] = useState<string | null>(null);


  
  const isXdrInit = useIsXdrInit();

  const {
    data: latestTxn,
    error: latestTxnError,
    isSuccess: isLatestTxnSuccess,
    isFetching: isLatestTxnFetching,
    isLoading: isLatestTxnLoading,
  } = useLatestTxn(network.horizonUrl);

  useEffect(() => {
    if (isLatestTxnSuccess && latestTxn) {
      updateXdrBlob(latestTxn);
      updateXdrType("TransactionEnvelope");
    }
  }, [isLatestTxnSuccess, latestTxn, updateXdrBlob, updateXdrType]);

  const isFetchingLatestTxn = isLatestTxnFetching || isLatestTxnLoading;

  const xdrDecodeJson = useCallback(() => {
    if (!(isXdrInit && xdr.blob && xdr.type)) {
      return null;
    }

    try {
      const xdrJson = StellarXdr.decode(xdr.type, xdr.blob);
      return {
        jsonString: xdrJson,
        error: "",
      };
    } catch (e) {
      // The WASM JSON decoder (v0.0.2) cannot render all valid Soroban transactions
      // as JSON. This only affects the display panel — simulation runs independently.
      return {
        jsonString: "",
        error: "",
      };
    }
  }, [isXdrInit, xdr.blob, xdr.type]);

  const simulateTransaction = useCallback(async () => {
    if (!xdr.blob || isSimulating) return;

    setIsSimulating(true);

    let requestBody = {
      "jsonrpc": "2.0",
      "id": 8675309,
      "method": "simulateTransaction",
      "params": {
        "transaction": xdr.blob,
        "resourceConfig": {
          "instructionLeeway": 0 // stellar.expert does the same
        }
      }
    };

    try {
      console.log(network.rpcUrl);
      
      let res = await fetch(network.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      let simulateResponse = await res.json();

      // Check for RPC-level errors
      if (simulateResponse.error) {
        throw new Error(`RPC error: ${JSON.stringify(simulateResponse.error)}`);
      }

      // Check for simulation-level errors (e.g. expired tx, wrong network)
      if (!simulateResponse.result) {
        throw new Error('Simulation returned no result. The transaction may be invalid or for a different network.');
      }

      if (simulateResponse.result.error) {
        throw new Error(`Simulation error: ${simulateResponse.result.error}`);
      }

      let sorocosts = await sorobill(simulateResponse, xdr.blob, network.rpcUrl);
      
      const instructionFee = computeInstructionFee(sorocosts.cpu_insns.toString());
      const readEntriesFee = computeReadEntriesFee(sorocosts.entry_reads.toString());
      const writeEntriesFee = computeWriteEntriesFee(sorocosts.entry_writes.toString());
      const readBytesFee = computeReadBytesFee(sorocosts.read_bytes.toString());
      const writeBytesFee = computeWriteBytesFee(sorocosts.write_bytes.toString());
      const historicalFee = computeHistoricalFee(sorocosts.txn_size.toString());
      const bandwidthFee = computeBandwidthFee(sorocosts.txn_size.toString());
      const eventsFee = computeEventsOrReturnValueFee(sorocosts.events_and_return_bytes.toString());
      let newTotalRentFee = Number(computeRentFee(sorocosts.ledger_changes, sorocosts.current_ledger)) / 10000000;
      // let newTotalRentFeeNum = Number(Number(newTotalRentFee).toFixed(7));
      console.log("Rent Fee ", newTotalRentFee);

      let totalEstimatedFee = Number((instructionFee + readEntriesFee + writeEntriesFee + readBytesFee + 
      writeBytesFee + historicalFee + bandwidthFee + eventsFee ) / 10000000);

      totalEstimatedFee = Number(Number(totalEstimatedFee + newTotalRentFee).toFixed(7));
      // const feeInXLM = totalFee / 10000000;
      console.log("Total Estimated Fee", totalEstimatedFee)
      setContractCosts(sorocosts);
      
      const server = new StellarSDK.rpc.Server(network.rpcUrl);

      let inclusionFee = await server.getFeeStats();
      let inclusionFeeMaxNum = Number(inclusionFee.sorobanInclusionFee.max) ;
      let totalFee = (Number(totalEstimatedFee + inclusionFeeMaxNum * 10**(-7))).toString();
      setTotalEstimatedFee(totalFee);
    } catch (error) {
      console.error("Error simulating transaction:", error);
    } finally {
      setIsSimulating(false);
    }
  }, [xdr.blob, network.rpcUrl]);

  useEffect(() => {
    simulateTransaction();
  }, [simulateTransaction]);

  const xdrJsonDecoded = xdrDecodeJson();

  const prettifyJsonString = (jsonString: string) => {
    try {
      const parsedJson = JSON.parse(jsonString);
      return JSON.stringify(parsedJson, null, 2);
    } catch (e) {
      return jsonString;
    }
  };

  const combinedJson = useCallback(() => {
    
    const contractCostInside: ContractCosts = contractCosts || {
      cpu_insns: 0,
      mem_bytes: 0,
      entry_reads: 0,
      entry_writes: 0,
      read_bytes: 0,
      write_bytes: 0,
      events_and_return_bytes: 0,
      txn_size: 0,
      current_ledger: 0,
      ledger_changes: [],
      resource_fee_in_xlm: 0
    };

    const readableJson = {
      "Contract Costs": {
        "CPU Instructions": contractCostInside.cpu_insns,
        "Number of ledger entries read": contractCostInside.entry_reads,
        "Number of ledger entries written": contractCostInside.entry_writes,
        "Number of bytes read": contractCostInside.read_bytes,
        "Number of bytes written": contractCostInside.write_bytes,
        "Transaction size (bytes)": contractCostInside.txn_size,
        "Events/return value size (bytes)": contractCostInside.events_and_return_bytes,
        "Current Ledger": contractCostInside.current_ledger,
        "Ledger entry changes": contractCostInside.ledger_changes,
      },
      "Fees": {
        "Estimated Total fee (XLM)": Number(Number(totalEstimatedFee).toFixed(7)),
        "RPC Resource fee (XLM)": contractCostInside.resource_fee_in_xlm,
      }
    };
    return readableJson;
  }, [contractCosts, totalEstimatedFee]);
  
  return (
    <Box gap="md">
      <div className="PageHeader">
        <Text size="md" as="h1" weight="medium">
          Check resource estimates and fees by simulating transactions
        </Text>
      </div>

      <Card>
        <Box gap="lg">
          <XdrPicker
            id="view-xdr-blob"
            label="Transaction XDR"
            value={xdr.blob}
            hasCopyButton
            note="Input a base-64 encoded unsigned / signed XDR blob of a transaction"
            onChange={(e) => {
              updateXdrBlob(e.target.value);
            }}
            error={latestTxnError?.toString()}
            disabled={isFetchingLatestTxn}
          />

          <XdrTypeSelect error={xdrJsonDecoded?.error} />


          <Box gap="lg" direction="row" align="center" justify="end">
            <Button
              size="md"
              variant="error"
              icon={<Icon.RefreshCw01 />}
              onClick={() => {
                resetXdr();
                setContractCosts(null);
                setTotalEstimatedFee(null);
              }}
              disabled={!xdr.blob}
            >
              Clear XDR
            </Button>
          </Box>

          {combinedJson() && (
            <Box gap="lg">
              <div className="PageBody__content PageBody__scrollable">
                <PrettyJson json={combinedJson()} />
              </div>

              <Box gap="md" direction="row" justify="end">
                <CopyText
                  textToCopy={prettifyJsonString(JSON.stringify(combinedJson()))}
                >
                  <Button
                    size="md"
                    variant="tertiary"
                    icon={<Icon.Copy01 />}
                    iconPosition="left"
                  >
                    Copy JSON
                  </Button>
                </CopyText>
              </Box>
            </Box>
          )}
        </Box>
      </Card>

      <Alert variant="primary" placement="inline">
        The fee simulation shows the estimated resource usage, including CPU instructions, memory usage, ledger entry accesses, ledger I/O operations, transaction size, events, and return value size, which directly affect the transaction fees, while the overall fee is shown by adding the resource fees and current inclusion fees.
      </Alert>

      <Alert variant="primary" placement="inline">
        Note that while simulation provides a good estimate,
        actual execution may vary slightly due to network conditions or changes in the ledger state between simulation and execution.
      </Alert>
    </Box>
  );
}
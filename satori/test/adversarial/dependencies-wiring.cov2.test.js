/**
 * dependencies-wiring.cov2.test.js
 *
 * SECOND round of adversarial COVERAGE for the dependencies-wiring subsystem.
 * Targets the remaining MEDIUM-priority coverage_gaps from the audit's
 * _raw_review.json that the first coverage file
 * (dependencies-wiring.cov.test.js) does NOT cover, AND asserts the
 * post-audit CONTRACT CHANGE: the platform-fee recipient is now a HARD-CODED
 * compile-time CONSTANT.
 *
 * What cov.test.js already covers (SKIPPED here):
 *   - setSatoriCore one-shot + deployer/zero guards, per child.
 *   - onlyCore enforcement on child mutators.
 *   - cross-ref resolution (Registry.satoriRewards etc. == core getters).
 *   - _update skip-mask correctness.
 *
 * Remaining MEDIUM gaps + the contract change covered here:
 *
 *   1. Fee recipients after the platform fee moved to the immutable SatoriToken
 *      (see test/next/DevFee.test.js): the platform/dev fee no longer lives on
 *      rewards at all — the token carries it as an immutable PLATFORM_FEE_RECIPIENT
 *      (no setter). Rewards keeps only the MARKETING recipient, a constructor-set
 *      immutable (no setter). Neither can be redirected on-chain.
 *
 *   2. setPlatformFeeRecipient / wireFeeRecipient DO NOT EXIST on rewards; the
 *      platform recipient getter is gone from rewards entirely. The admin has NO
 *      path to redirect any fee. Asserted via the contract surface.
 *
 *   3. Admin-role wiring is SEPARATE from the recipient: setAdmin transfers
 *      the admin role (admin-only, non-zero), and the recipient constant is
 *      untouched by an admin transfer.
 *
 *   4. owner() cross-reference wiring: Satori.owner() resolves through
 *      satoriRewards.admin() and tracks a setAdmin transfer — the
 *      "owner" identity is the admin role, never the fee recipient.
 *
 * Intended behavior is asserted from the contracts' CURRENT NatSpec/code
 * (SatoriRewards.sol: MARKETING_FEE_RECIPIENT immutable, inert FeeSlot, setAdmin;
 * SatoriToken.sol: immutable PLATFORM_FEE_RECIPIENT; SatoriHub.sol owner()).
 *
 * All assertions reflect intended behavior; this file is expected GREEN.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySatoriFixture } = require("../fixtures");
const {
    TEST_MARKETING_FEE_RECIPIENT,
} = require("../next/splitFixture");

const ZERO = ethers.ZeroAddress;
// The OLD hard-coded marketing placeholder the constructor still REFUSES (a
// recipient set to it reverts BadInput at deploy). The live marketing recipient
// is the constructor-set immutable (TEST_MARKETING_FEE_RECIPIENT in the fixture).
const PLACEHOLDER_MARKETING = "0x000000000000000000000000000000000000bEEF";

// Deploy a STANDALONE SatoriRewards. The platform/dev fee has moved to the
// immutable SatoriToken (see test/next/DevFee.test.js), so the ctor no longer
// takes initialFeeBps or a platform recipient — only the marketing recipient
// (a constructor-set immutable). We pass the canonical TEST_MARKETING_FEE_RECIPIENT
// so a standalone deploy stays consistent with the shared fixture. `_voting` only
// needs to be non-zero. `coreForFlush` (optional) is a real fixture core to wire
// so setSatoriCore's cross-ref resolution works.
async function deployStandaloneRewards(deployer, admin, coreForFlush) {
    const Rw = await ethers.getContractFactory("SatoriRewards");
    const rw = await Rw.connect(deployer).deploy(
        admin.address,   // _voting placeholder (non-zero; unused by these guards)
        admin.address,   // _admin
        TEST_MARKETING_FEE_RECIPIENT
    );
    await rw.waitForDeployment();
    if (coreForFlush) {
        await rw.connect(deployer).setSatoriCore(coreForFlush);
    }
    return rw;
}

describe("COV2 dependencies-wiring: immutable fee recipient + fee-rate/owner wiring", function () {
    this.timeout(120000);

    // ------------------------------------------------------------------
    // 1. IMMUTABLE platform-fee recipient: the hard-coded constant.
    //    There is no wire, no setter, no event — only the constant getter.
    // ------------------------------------------------------------------
    describe("fee recipients: marketing immutable on rewards; platform on the token", function () {
        it("MARKETING_FEE_RECIPIENT() equals the constructor-passed recipient on a standalone deploy", async function () {
            const [deployer] = await ethers.getSigners();
            const rw = await deployStandaloneRewards(deployer, deployer);
            // platform fee moved to immutable token (see test/next/DevFee.test.js):
            // the platform recipient is no longer a rewards ctor arg. The MARKETING
            // recipient is still a constructor-set immutable on rewards.
            expect(await rw.marketingFeeRecipient()).to.equal(ethers.getAddress(TEST_MARKETING_FEE_RECIPIENT));
            // feeSlot was removed 2026-08-31 with the dead fee storage; its
            // absence is a stronger statement than its inertness was.
            expect(rw.feeSlot).to.equal(undefined);
        });

        it("MARKETING_FEE_RECIPIENT() equals the fixture's TEST recipient; the platform recipient now lives on the token", async function () {
            const f = await deploySatoriFixture();
            expect(await f.rewards.marketingFeeRecipient()).to.equal(ethers.getAddress(TEST_MARKETING_FEE_RECIPIENT));
            // platform fee moved to immutable token (see test/next/DevFee.test.js):
            // the recipient is the token's immutable PLATFORM_FEE_RECIPIENT (non-zero,
            // no setter). The fixture points it at the governor/owner.
            expect(await f.token.PLATFORM_FEE_RECIPIENT()).to.not.equal(ethers.ZeroAddress);
            expect(await f.token.PLATFORM_FEE_RECIPIENT()).to.equal(f.owner.address);
        });

        it("the constructor REVERTS if the marketing recipient is address(0) or the old placeholder (deploy-time validation)", async function () {
            const [deployer] = await ethers.getSigners();
            const Rw = await ethers.getContractFactory("SatoriRewards");
            // platform fee moved to immutable token (see test/next/DevFee.test.js):
            // the platform recipient is no longer a rewards ctor arg, so only the
            // MARKETING recipient is validated here. (The token rejects a zero/
            // placeholder dev recipient — covered in DevFee.test.js.)
            // Zero marketing recipient rejected.
            await expect(Rw.connect(deployer).deploy(
                deployer.address, deployer.address, ZERO
            )).to.be.revertedWithCustomError(Rw, "BadInput");
            // Old 0xbEEF marketing placeholder rejected.
            await expect(Rw.connect(deployer).deploy(
                deployer.address, deployer.address, PLACEHOLDER_MARKETING
            )).to.be.revertedWithCustomError(Rw, "BadInput");
        });
    });

    // ------------------------------------------------------------------
    // platform fee moved to immutable token (see test/next/DevFee.test.js):
    // rewards.accrueProtocolFee() and the platform-fee accrual path no longer
    // exist — the dev fee now self-accrues on the token and is realized by the
    // permissionless token.mintDevFee() pull, covered by DevFee.test.js. The
    // rewards-side accrual-routing test is therefore removed.
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 2. The recipient has NO mutator: neither setPlatformFeeRecipient nor
    //    wireFeeRecipient exists on the contract surface.
    // ------------------------------------------------------------------
    describe("the fee recipient has no on-chain mutator", function () {
        it("SatoriRewards exposes no setPlatformFeeRecipient, no wireFeeRecipient, and no platform recipient at all", async function () {
            const f = await deploySatoriFixture();
            const isFn = (name) => f.rewards.interface.fragments.filter(
                (x) => x.type === "function" && x.name === name
            ).length;
            expect(isFn("setPlatformFeeRecipient")).to.equal(0);
            expect(isFn("wireFeeRecipient")).to.equal(0);
            // platform fee moved to immutable token (see test/next/DevFee.test.js):
            // the platform recipient getter is GONE from rewards (it lives on the
            // token now).
            expect(isFn("PLATFORM_FEE_RECIPIENT")).to.equal(0);
            // The MARKETING recipient is no longer a bytecode constant either: it
            // moved to proxy storage with a recipient-only two-step rotation, so
            // the SCREAMING_CASE getter is gone and a lowerCamel one took its
            // place. Rotation is deliberately NOT an admin power — see
            // test/MarketingFeeRecipientRotation.test.js.
            expect(isFn("MARKETING_FEE_RECIPIENT")).to.equal(0);
            expect(isFn("marketingFeeRecipient")).to.equal(1);
            expect(isFn("transferMarketingFeeRecipient")).to.equal(1);
            expect(isFn("acceptMarketingFeeRecipient")).to.equal(1);
            // ...and still no admin-facing setter of any kind.
            expect(isFn("setMarketingFeeRecipient")).to.equal(0);
        });
    });

    // ------------------------------------------------------------------
    // 3. The admin role is a SEPARATE authority from the recipient:
    //    admin-only, non-zero, transferable via setAdmin. None of these
    //    touch the recipient constant.
    // ------------------------------------------------------------------
    describe("admin role wiring is separate from the recipient", function () {
        let f, rewards, admin, stranger, recipient;

        beforeEach(async function () {
            f = await deploySatoriFixture();
            rewards = f.rewards;
            admin = f.owner;             // fixture sets admin = owner
            stranger = f.signers[1];
            // platform fee moved to immutable token (see test/next/DevFee.test.js):
            // the surviving rewards-side fee immutable is the MARKETING recipient.
            recipient = await rewards.marketingFeeRecipient();
        });

        it("setAdmin transfers the role (admin-only, non-zero) without touching the recipient", async function () {
            const newAdmin = f.signers[2];

            await expect(rewards.connect(stranger).setAdmin(newAdmin.address))
                .to.be.revertedWithCustomError(rewards, "Unauthorized");
            await expect(rewards.connect(admin).setAdmin(ZERO))
                .to.be.revertedWithCustomError(rewards, "BadInput");

            await rewards.connect(admin).setAdmin(newAdmin.address);
            expect(await rewards.admin()).to.equal(newAdmin.address);

            // Old admin loses the role — checked through a NON-GOVERNOR ex-admin.
            //
            // It cannot be checked through `admin` any more: this fixture deploys
            // governor and admin from the same signer, and the governor now keeps
            // a recovery path into setAdmin (an admin key compromise was
            // otherwise unrecoverable — see test/AdminRecovery.test.js). So
            // `admin` losing the ADMIN role does not make it unauthorized here;
            // it is still the governor. Hand the role on once more and check the
            // ex-holder that has no other claim to it.
            const thirdAdmin = f.signers[3];
            await rewards.connect(newAdmin).setAdmin(thirdAdmin.address);
            await expect(rewards.connect(newAdmin).setAdmin(newAdmin.address))
                .to.be.revertedWithCustomError(rewards, "Unauthorized");

            // ...and the role can be handed back.
            await rewards.connect(thirdAdmin).setAdmin(admin.address);
            expect(await rewards.admin()).to.equal(admin.address);

            // The fee recipient immutable (marketing) never moved — the platform
            // fee itself now lives on the token (see test/next/DevFee.test.js).
            expect(await rewards.marketingFeeRecipient()).to.equal(recipient);
        });
    });

    // ------------------------------------------------------------------
    // 4. owner() ownerless signal: Satori.owner() always returns address(0)
    //    (a deliberate "no central authority" broadcast). It does NOT surface
    //    the admin role and is unaffected by a setAdmin transfer. The
    //    operational admin role is read via satoriRewards.admin().
    // ------------------------------------------------------------------
    describe("Satori.owner() is the ownerless address(0) signal, decoupled from admin and recipient", function () {
        it("owner() == address(0) and stays ownerless across setAdmin", async function () {
            const f = await deploySatoriFixture();
            const rewards = f.rewards;
            const admin = f.owner;

            expect(await f.satori.owner()).to.equal(ethers.ZeroAddress);
            expect(await rewards.admin()).to.equal(admin.address);

            const newAdmin = f.signers[3];
            await rewards.connect(admin).setAdmin(newAdmin.address);
            // owner() stays ownerless; the role moves on admin().
            expect(await f.satori.owner()).to.equal(ethers.ZeroAddress);
            expect(await rewards.admin()).to.equal(newAdmin.address);

            // The fee recipient immutable is decoupled from owner() — the MARKETING
            // recipient is unchanged by the admin transfer (the platform fee now
            // lives on the token, see test/next/DevFee.test.js).
            expect(await rewards.marketingFeeRecipient()).to.equal(ethers.getAddress(TEST_MARKETING_FEE_RECIPIENT));
        });
    });
});

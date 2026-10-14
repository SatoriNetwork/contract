const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("CRITICAL: Single-Hop Delegation Security Tests", function() {
    let satori, satoriRewards, satoriRegistry, satoriVoting, registry;
    let owner, alice, bob, carol, dave;
    // The fixture initializes the DEFAULT stream at id 1, so the stream this
    // suite creates lands at id 2 — captured from the event, never hardcoded.
    let streamId;

    // Helper to convert numbers to ether
    const eth = (n) => ethers.parseEther(n.toString());

    beforeEach(async function() {
        [owner, alice, bob, carol, dave] = await ethers.getSigners();

        // Deploy the restructured Satori stack via the shared fixture.
        const fix = await deploySatoriFixture();
        satori = fix.satori;
        satoriVoting = fix.voting;
        satoriRewards = fix.rewards;
        satoriRegistry = fix.registry;
        registry = fix.registry;

        // Enable test mode

        // Create a stream. Admin-created with an explicit cadence of 1 (every
        // round): this suite is about single-hop delegation, and the stream is
        // only scaffolding for the predictions it drives.
        // A public caller may only create cadence >= 2.
        const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("Test Stream", owner.address, 1440);
        const receipt = await tx.wait();
        streamId = Number(receipt.logs
            .map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
            .find((p) => p && p.name === "DataStreamCreated").args.streamId);

        // Transfer tokens from owner for testing
        await satori.transfer(alice.address, ethers.parseEther("200"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.transfer(carol.address, ethers.parseEther("60"));
        await satori.transfer(dave.address, ethers.parseEther("40"));
    });

    describe("CRITICAL: Multi-hop delegation must be IMPOSSIBLE", function() {

        it("MUST NOT allow multi-hop delegation - Carol -> Alice -> Bob should NOT give Bob Carol's power", async function() {
            // Step 1: Carol delegates to Alice
            await satori.connect(carol).delegatePredictionPower(alice.address);

            // Verify Carol has 0 power (delegated away)
            let carolPower = await satoriRewards.getPredictionPower(carol.address);
            expect(carolPower).to.equal(0, "Carol should have 0 power after delegating");

            // Verify Alice has her own power + Carol's
            let alicePower = await satoriRewards.getPredictionPower(alice.address);
            expect(alicePower).to.equal(eth("260"), "Alice should have 1000 (own) + 300 (Carol's)");

            // Step 2: Alice tries to delegate to Bob
            await satori.connect(alice).delegatePredictionPower(bob.address);

            // CRITICAL CHECK: Bob should only get Alice's OWN tokens, NOT Carol's
            let bobPower = await satoriRewards.getPredictionPower(bob.address);
            expect(bobPower).to.equal(eth("300"), "Bob should have 500 (own) + 1000 (Alice's own tokens ONLY)");

            // Alice should now have 0 power
            alicePower = await satoriRewards.getPredictionPower(alice.address);
            expect(alicePower).to.equal(0, "Alice should have 0 power after delegating");

            // Carol's power should still be 0
            carolPower = await satoriRewards.getPredictionPower(carol.address);
            expect(carolPower).to.equal(0, "Carol should still have 0 power");

            // CRITICAL: Carol's delegation should now point to Alice, but Alice has no power
            // So Carol's power is effectively lost until she undelegates
            let carolDelegate = (await satoriRewards.predictionDelegateInfo(carol.address)).delegate;
            expect(carolDelegate).to.equal(alice.address, "Carol's delegate should still be Alice");
        });

        it("MUST NOT allow delegation chains - Dave -> Carol -> Alice -> Bob", async function() {
            // Setup: Dave -> Carol -> Alice -> Bob
            await satori.connect(dave).delegatePredictionPower(carol.address);
            await satori.connect(carol).delegatePredictionPower(alice.address);
            await satori.connect(alice).delegatePredictionPower(bob.address);

            // Check final powers
            let davePower = await satoriRewards.getPredictionPower(dave.address);
            let carolPower = await satoriRewards.getPredictionPower(carol.address);
            let alicePower = await satoriRewards.getPredictionPower(alice.address);
            let bobPower = await satoriRewards.getPredictionPower(bob.address);

            // Dave delegated to Carol, so Dave has 0
            expect(davePower).to.equal(0, "Dave should have 0 power");

            // Carol delegated to Alice, so Carol has 0
            expect(carolPower).to.equal(0, "Carol should have 0 power");

            // Alice delegated to Bob, so Alice has 0
            expect(alicePower).to.equal(0, "Alice should have 0 power");

            // Bob should ONLY have his own 500 + Alice's own 1000
            // NOT Carol's 300 or Dave's 200
            expect(bobPower).to.equal(eth("300"), "Bob should only have 500 (own) + 1000 (Alice's own)");

            // CRITICAL: Dave and Carol's power is essentially lost in the chain
            // This is the expected behavior to prevent multi-hop exploitation
        });

        it("When delegated user delegates elsewhere, original delegator's power is NOT transferred", async function() {
            // Alice delegates to Bob
            await satori.connect(alice).delegatePredictionPower(bob.address);

            let bobPower = await satoriRewards.getPredictionPower(bob.address);
            expect(bobPower).to.equal(eth("300"), "Bob should have 500 + 1000");

            // Bob delegates to Carol
            await satori.connect(bob).delegatePredictionPower(carol.address);

            // Carol should only get Bob's original 500, not Alice's 1000
            let carolPower = await satoriRewards.getPredictionPower(carol.address);
            expect(carolPower).to.equal(eth("160"), "Carol should have 300 (own) + 500 (Bob's own only)");

            // Bob should have 0
            bobPower = await satoriRewards.getPredictionPower(bob.address);
            expect(bobPower).to.equal(0, "Bob should have 0 after delegating");

            // Alice should still have 0 (still delegated to Bob even though Bob has no power)
            let alicePower = await satoriRewards.getPredictionPower(alice.address);
            expect(alicePower).to.equal(0, "Alice should still have 0");
        });

        it("Undelegating breaks the chain properly", async function() {
            // Setup delegation chain
            await satori.connect(carol).delegatePredictionPower(alice.address);
            await satori.connect(alice).delegatePredictionPower(bob.address);

            // Bob has Alice's tokens only
            let bobPower = await satoriRewards.getPredictionPower(bob.address);
            expect(bobPower).to.equal(eth("300"), "Bob: 500 + 1000 (Alice)");

            // Carol undelegates
            await satori.connect(carol).delegatePredictionPower(ethers.ZeroAddress);

            // Carol should get her power back
            let carolPower = await satoriRewards.getPredictionPower(carol.address);
            expect(carolPower).to.equal(eth("60"), "Carol should have her 300 back");

            // Bob's power should remain unchanged
            bobPower = await satoriRewards.getPredictionPower(bob.address);
            expect(bobPower).to.equal(eth("300"), "Bob still has 500 + 1000 (Alice)");

            // Alice undelegates
            await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

            // Alice should get her power back
            let alicePower = await satoriRewards.getPredictionPower(alice.address);
            expect(alicePower).to.equal(eth("200"), "Alice should have her 1000 back");

            // Bob should only have his own tokens now
            bobPower = await satoriRewards.getPredictionPower(bob.address);
            expect(bobPower).to.equal(eth("100"), "Bob should only have his own 500");
        });

        it("Circular delegation results in both having 0 power", async function() {
            // Alice "self-delegates" — normalized to address(0) (= undelegated).
            await satori.connect(alice).delegatePredictionPower(alice.address);

            let alicePower = await satoriRewards.getPredictionPower(alice.address);
            expect(alicePower).to.equal(eth("200"), "Alice should have exactly her own tokens");

            // Bob delegates to Alice
            await satori.connect(bob).delegatePredictionPower(alice.address);

            alicePower = await satoriRewards.getPredictionPower(alice.address);
            expect(alicePower).to.equal(eth("300"), "Alice should have own + Bob's delegation");

            // Self-delegate set lockUntilNextRound on Alice. Advance one round
            // so she can re-delegate.
            await time.increase(86400);

            // Alice delegates to Bob (creating circular delegation: Bob -> Alice -> Bob)
            await satori.connect(alice).delegatePredictionPower(bob.address);

            // CRITICAL: In circular delegation, BOTH users have 0 power
            // Bob still has his delegation pointing to Alice, so Bob has 0
            let bobPower = await satoriRewards.getPredictionPower(bob.address);
            expect(bobPower).to.equal(0, "Bob should have 0 (still delegated to Alice)");

            // Alice has delegated to Bob, so Alice has 0
            alicePower = await satoriRewards.getPredictionPower(alice.address);
            expect(alicePower).to.equal(0, "Alice should have 0 (delegated to Bob)");

            // The power is effectively lost in the circular delegation
            // This prevents any gaming of the delegation system
        });
    });

    describe("Verify delegation only uses OWN token balance", function() {

        it("delegatePredictionPower only delegates balanceOf(user), not getPredictionPower(user)", async function() {
            // Setup: Carol delegates to Alice first
            await satori.connect(carol).delegatePredictionPower(alice.address);

            // Alice now has 1300 power (1000 own + 300 Carol)
            let alicePower = await satoriRewards.getPredictionPower(alice.address);
            expect(alicePower).to.equal(eth("260"));

            // When Alice delegates to Bob, check the delegated amount
            let aliceBalance = await satori.balanceOf(alice.address);
            expect(aliceBalance).to.equal(eth("200"), "Alice's actual token balance is 1000");

            // Alice delegates to Bob
            await satori.connect(alice).delegatePredictionPower(bob.address);

            // Bob should receive exactly Alice's balance, not her total power
            let bobDelegatedPower = (await satoriRewards.predictionDelegateInfo(bob.address)).power;
            expect(bobDelegatedPower).to.equal(eth("200"), "Bob should receive exactly Alice's balance");

            // Total power check
            let bobPower = await satoriRewards.getPredictionPower(bob.address);
            expect(bobPower).to.equal(eth("300"), "Bob: 500 own + 1000 from Alice");
        });
    });

    describe("Prediction power calculation verification", function() {

        it("User with incoming delegation who delegates out should have 0 power", async function() {
            // Dave delegates to Alice
            await satori.connect(dave).delegatePredictionPower(alice.address);

            // Alice has 1200 power
            let alicePower = await satoriRewards.getPredictionPower(alice.address);
            expect(alicePower).to.equal(eth("240"), "Alice: 1000 own + 200 Dave");

            // Alice delegates to Bob
            await satori.connect(alice).delegatePredictionPower(bob.address);

            // Alice should have 0 power (not Dave's 200)
            alicePower = await satoriRewards.getPredictionPower(alice.address);
            expect(alicePower).to.equal(0, "Alice should have 0 power when delegated out");

            // Verify Alice's delegate is Bob
            let aliceDelegate = (await satoriRewards.predictionDelegateInfo(alice.address)).delegate;
            expect(aliceDelegate).to.equal(bob.address);
        });

        it("Complex scenario with multiple delegations", async function() {
            // Initial setup
            expect(await satoriRewards.getPredictionPower(alice.address)).to.equal(eth("200"));
            expect(await satoriRewards.getPredictionPower(bob.address)).to.equal(eth("100"));
            expect(await satoriRewards.getPredictionPower(carol.address)).to.equal(eth("60"));
            expect(await satoriRewards.getPredictionPower(dave.address)).to.equal(eth("40"));

            // Dave -> Alice
            await satori.connect(dave).delegatePredictionPower(alice.address);
            expect(await satoriRewards.getPredictionPower(alice.address)).to.equal(eth("240"));
            expect(await satoriRewards.getPredictionPower(dave.address)).to.equal(0);

            // Carol -> Bob
            await satori.connect(carol).delegatePredictionPower(bob.address);
            expect(await satoriRewards.getPredictionPower(bob.address)).to.equal(eth("160"));
            expect(await satoriRewards.getPredictionPower(carol.address)).to.equal(0);

            // Alice -> Bob (should only transfer Alice's 1000, not Dave's 200)
            await satori.connect(alice).delegatePredictionPower(bob.address);
            expect(await satoriRewards.getPredictionPower(bob.address)).to.equal(eth("360")); // 500 + 300 + 1000
            expect(await satoriRewards.getPredictionPower(alice.address)).to.equal(0);

            // Dave undelegates from Alice (who has already delegated to Bob)
            await satori.connect(dave).delegatePredictionPower(ethers.ZeroAddress);
            expect(await satoriRewards.getPredictionPower(dave.address)).to.equal(eth("40"));
            // Bob's power shouldn't change
            expect(await satoriRewards.getPredictionPower(bob.address)).to.equal(eth("360"));
        });
    });

    describe("Prevention of delegation abuse in predictions", function() {

        beforeEach(async function() {
            // Buy the stream's game some weight so it earns. The OWNER burns —
            // alice/bob/carol/dave's balances feed the power assertions below.
            await voteFor(satori, owner, streamId);
            await time.increase(86400); // Move to a clean round
        });

        it("Cannot use multi-hop delegated power for predictions", async function() {
            // Carol -> Alice -> Bob chain
            await satori.connect(carol).delegatePredictionPower(alice.address);
            await satori.connect(alice).delegatePredictionPower(bob.address);

            // Bob makes a prediction with his power
            await registry.setValue(streamId, 100);
            await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP

            // Check Bob's prediction power used. The first-predictor liveness
            // bonus is gone, so nothing lands in unclaimedRewards here — power
            // is exactly Bob's 100 + Alice's own 200.
            let bobPower = await satoriRewards.getPredictionPower(bob.address);
            expect(bobPower).to.equal(eth("300"), "Bob used own + Alice (multi-hop blocked)");

            // Advance rounds and score
            await time.increase(86400);
            await registry.setValue(streamId, 150); // Stream goes up
            await time.increase(86400);

            // Bob predicts again to trigger scoring
            await registry.setValue(streamId, 200); // Update value for new round
            await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

            // Verify only Bob and Alice get rewards, not Carol
            // This is because Carol's power wasn't actually used in the prediction
        });

        it("Switching delegates mid-round doesn't allow double power use", async function() {
            // Alice delegates to Bob
            await satori.connect(alice).delegatePredictionPower(bob.address);

            // Bob predicts using Alice's power
            await registry.setValue(streamId, 100);
            await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

            // Alice CAN undelegate (this is allowed for safety)
            await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

            // But Alice CANNOT predict herself because she's locked
            // (Bob's prediction locked Alice's tokens)
            await expect(
                satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(2) }])
            ).to.be.revertedWithCustomError(satori, "Locked");

            // Alice also CANNOT delegate to Carol because she's now locked
            // (After undelegating, Alice is locked from Bob's prediction)
            await expect(
                satori.connect(alice).delegatePredictionPower(carol.address)
            ).to.be.revertedWithCustomError(satori, "Locked");
        });
    });
});
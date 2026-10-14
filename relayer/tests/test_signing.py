"""Pins app.signing to a vector produced by ethers' signTypedData — the same
library the contract's GaslessRelay.test.js proves against SatoriHub.relay().
If this passes, Python, ethers and the contract all hash the same bytes."""

from eth_account import Account

from app.signing import RelayAction, recover_signer, typed_data

CHAIN_ID = 84532
HUB = "0x1111111111111111111111111111111111111111"

# Generated with ethers v6 (see repo history for the generator one-liner);
# key 0xabab…ab, so the vector is reproducible.
VECTOR_SIGNER = "0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6"
VECTOR_SIG = (
    "0x8e175b045fdacc8ef28d2880f0a89f003982578ec8fa210f47af91302da1daa7"
    "74d83d4fc44f03eabc687f790c5aa3546e6c1f10d5cbb9f45928db0972f763421b"
)
VECTOR_MSG = {
    "user": VECTOR_SIGNER,
    "action": 0,
    "data": "0xdeadbeef",
    "fee": 250000000000000000,
    "relayer": "0x2222222222222222222222222222222222222222",
    "nonce": 7,
    "deadline": 4102444800,
}


def test_recovers_ethers_signature():
    assert recover_signer(CHAIN_ID, HUB, VECTOR_MSG, VECTOR_SIG) == VECTOR_SIGNER


def test_tampered_field_recovers_differently():
    for field, value in [("fee", 1), ("action", 1), ("data", "0xdeadbeff"),
                         ("nonce", 8), ("deadline", 4102444801),
                         ("relayer", "0x3333333333333333333333333333333333333333")]:
        assert recover_signer(CHAIN_ID, HUB, {**VECTOR_MSG, field: value},
                              VECTOR_SIG) != VECTOR_SIGNER


def test_wrong_domain_recovers_differently():
    assert recover_signer(8453, HUB, VECTOR_MSG, VECTOR_SIG) != VECTOR_SIGNER
    assert recover_signer(CHAIN_ID, "0x9999999999999999999999999999999999999999",
                          VECTOR_MSG, VECTOR_SIG) != VECTOR_SIGNER


def test_roundtrip_with_eth_account():
    acct = Account.from_key("0x" + "cd" * 32)
    msg = {**VECTOR_MSG, "user": acct.address, "action": int(RelayAction.Vote)}
    td = typed_data(CHAIN_ID, HUB, msg)
    sig = acct.sign_typed_data(full_message=td).signature.to_0x_hex()
    assert recover_signer(CHAIN_ID, HUB, msg, sig) == acct.address


def test_typed_data_shape_for_wallets():
    td = typed_data(CHAIN_ID, HUB, VECTOR_MSG)
    assert td["primaryType"] == "RelayRequest"
    assert td["domain"]["verifyingContract"] == HUB
    assert [f["name"] for f in td["types"]["RelayRequest"]] == [
        "user", "action", "data", "fee", "relayer", "nonce", "deadline"]

"""EIP-712 construction and verification for SatoriHub.relay().

The field list and typehash string here MUST stay byte-identical to
SatoriHub.RELAY_TYPEHASH — the contract's GaslessRelay tests sign with ethers'
standard signTypedData, and tests/test_signing.py pins this module to a vector
produced by that same library."""

from enum import IntEnum

from eth_account import Account
from eth_account.messages import encode_typed_data


class RelayAction(IntEnum):  # SatoriHub.RelayAction
    Predict = 0
    Claim = 1
    Transfer = 2
    DelegatePrediction = 3
    SetAllowedDelegator = 4
    SetPredictorFee = 5
    Vote = 6


RELAY_TYPES = {
    "RelayRequest": [
        {"name": "user", "type": "address"},
        {"name": "action", "type": "uint8"},
        {"name": "data", "type": "bytes"},
        {"name": "fee", "type": "uint256"},
        {"name": "relayer", "type": "address"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
    ]
}


def relay_domain(chain_id: int, hub_address: str) -> dict:
    return {
        "name": "SatoriHub",
        "version": "1",
        "chainId": chain_id,
        "verifyingContract": hub_address,
    }


def typed_data(chain_id: int, hub_address: str, request: dict) -> dict:
    """The full EIP-712 payload a wallet signs (eth_signTypedData_v4 shape)."""
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            **RELAY_TYPES,
        },
        "primaryType": "RelayRequest",
        "domain": relay_domain(chain_id, hub_address),
        "message": request,
    }


def recover_signer(chain_id: int, hub_address: str, request: dict, signature: str) -> str:
    """Reconstructed server-side from the raw fields — never from
    client-supplied typed data (spec §14)."""
    msg = encode_typed_data(
        domain_data=relay_domain(chain_id, hub_address),
        message_types=RELAY_TYPES,
        message_data=request,
    )
    return Account.recover_message(msg, signature=signature)

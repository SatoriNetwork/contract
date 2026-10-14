"""Minimal ABI surface — only what the relayer calls. Kept inline rather than
copying build artifacts so the service has no build-output dependency; if
relay()'s signature ever changes, tests/test_e2e.py is what catches drift."""

from web3 import AsyncWeb3

HUB_ABI = [
    {
        "type": "function", "name": "relay", "stateMutability": "nonpayable",
        "inputs": [
            {"name": "r", "type": "tuple", "components": [
                {"name": "user", "type": "address"},
                {"name": "action", "type": "uint8"},
                {"name": "data", "type": "bytes"},
                {"name": "fee", "type": "uint256"},
                {"name": "relayer", "type": "address"},
                {"name": "nonce", "type": "uint256"},
                {"name": "deadline", "type": "uint256"},
            ]},
            {"name": "sig", "type": "bytes"},
            {"name": "p", "type": "tuple", "components": [
                {"name": "value", "type": "uint256"},
                {"name": "deadline", "type": "uint256"},
                {"name": "signature", "type": "bytes"},
            ]},
        ],
        "outputs": [],
    },
    {
        "type": "function", "name": "relayNonces", "stateMutability": "view",
        "inputs": [{"name": "", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]

TOKEN_ABI = [
    {
        "type": "function", "name": "balanceOf", "stateMutability": "view",
        "inputs": [{"name": "", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function", "name": "allowance", "stateMutability": "view",
        "inputs": [{"name": "", "type": "address"}, {"name": "", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function", "name": "nonces", "stateMutability": "view",
        "inputs": [{"name": "", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]

NO_PERMIT = (0, 0, b"")


def hub_contract(w3: AsyncWeb3, address: str):
    return w3.eth.contract(address=w3.to_checksum_address(address), abi=HUB_ABI)


def token_contract(w3: AsyncWeb3, address: str):
    return w3.eth.contract(address=w3.to_checksum_address(address), abi=TOKEN_ABI)

"""Validation, simulation and broadcast.

The division of labour (docs/design/gasless-relay.md): the CONTRACT answers
"did this user authorize this exact action and fee"; this module answers "am I
willing to spend ETH to execute it". Everything here can refuse; nothing here
can take a user's SATORI without their signature."""

import asyncio
import time
from decimal import Decimal

from eth_account import Account
from web3 import AsyncWeb3
from web3.providers.rpc import AsyncHTTPProvider

from .config import settings
from .contracts import NO_PERMIT, hub_contract, token_contract
from .fees import fee_wei
from .signing import RelayAction, recover_signer


class RelayRefused(Exception):
    """A request the relayer declines — maps to HTTP 400."""


class Relayer:
    def __init__(self) -> None:
        settings.validate_live()
        self.w3 = AsyncWeb3(AsyncHTTPProvider(settings.rpc_url))
        self.account = Account.from_key(settings.relayer_private_key)
        self.hub = hub_contract(self.w3, settings.hub_address)
        self.token = token_contract(self.w3, settings.token_address)
        # One tx in flight at a time. Two async submissions racing
        # get_transaction_count would broadcast with the same nonce and one
        # would silently replace the other (spec §17). V1 is one process, so a
        # plain asyncio lock is the whole story.
        self._send_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    async def healthy(self) -> tuple[bool, Decimal]:
        bal = Decimal(await self.w3.eth.get_balance(self.account.address)) / Decimal(10**18)
        return bal >= settings.min_relayer_eth, bal

    async def quote(self, user: str, action: int, data: str) -> dict:
        ok, _ = await self.healthy()
        if not ok:
            raise RelayRefused("relayer ETH depleted; no new quotes")
        act = RelayAction(action)
        nonce = await self.hub.functions.relayNonces(
            self.w3.to_checksum_address(user)).call()
        return {
            "user": self.w3.to_checksum_address(user),
            "action": int(act),
            "data": data,
            "fee": fee_wei(act),
            "relayer": self.account.address,
            "nonce": int(nonce),
            # Anchored to CHAIN time, which is what the contract's deadline
            # check reads — wall clock drifts from block.timestamp on any chain
            # and jumps wildly on a dev node.
            "deadline": await self._chain_now() + settings.quote_ttl_seconds,
        }

    async def _chain_now(self) -> int:
        return (await self.w3.eth.get_block("latest"))["timestamp"]

    # ------------------------------------------------------------------
    async def submit(self, s) -> str:
        """spec §14: rebuild, verify, simulate, then broadcast."""
        request = {
            "user": self.w3.to_checksum_address(s.user),
            "action": s.action,
            "data": s.data,
            "fee": int(s.fee),
            "relayer": self.account.address,
            "nonce": s.nonce,
            "deadline": s.deadline,
        }
        act = RelayAction(s.action)

        if s.deadline < await self._chain_now():
            raise RelayRefused("authorization expired")
        # The fee must satisfy the CURRENT policy — a stale cheaper quote does
        # not oblige us. (If policy dropped meanwhile, an over-signed fee is
        # the user's signed choice and still fine.)
        if request["fee"] < fee_wei(act):
            raise RelayRefused("fee below current policy; request a fresh quote")

        signer = recover_signer(settings.chain_id, settings.hub_address, request, s.signature)
        if signer.lower() != request["user"].lower():
            raise RelayRefused("signature does not recover to user")

        onchain_nonce = await self.hub.functions.relayNonces(request["user"]).call()
        if onchain_nonce != s.nonce:
            raise RelayRefused(f"nonce mismatch (expected {onchain_nonce})")

        ok, _ = await self.healthy()
        if not ok:
            raise RelayRefused("relayer ETH depleted")

        permit = NO_PERMIT
        if s.permit is not None:
            permit = (int(s.permit.value), s.permit.deadline,
                      bytes.fromhex(s.permit.signature[2:]))

        relay_tuple = (request["user"], request["action"],
                       bytes.fromhex(s.data[2:]), request["fee"],
                       request["relayer"], request["nonce"], request["deadline"])
        fn = self.hub.functions.relay(relay_tuple, bytes.fromhex(s.signature[2:]), permit)

        # Simulate + estimate before spending real ETH; a revert here costs
        # nothing and a revert on-chain costs the whole gas of the tx.
        try:
            gas = await fn.estimate_gas({"from": self.account.address})
        except Exception as e:  # noqa: BLE001 — any revert reason is a refusal
            raise RelayRefused(f"simulation reverted: {getattr(e, 'message', e)}") from e
        if gas > settings.max_gas_limit:
            raise RelayRefused(f"gas {gas} above relayer limit")

        async with self._send_lock:
            tx = await fn.build_transaction({
                "from": self.account.address,
                "nonce": await self.w3.eth.get_transaction_count(self.account.address, "pending"),
                "gas": int(gas * 12 // 10),
                "chainId": settings.chain_id,
            })
            signed = self.account.sign_transaction(tx)
            tx_hash = await self.w3.eth.send_raw_transaction(signed.raw_transaction)
        return tx_hash.to_0x_hex()

    # ------------------------------------------------------------------
    async def tx_status(self, tx_hash: str) -> dict:
        try:
            receipt = await self.w3.eth.get_transaction_receipt(tx_hash)
        except Exception:  # noqa: BLE001 — not found = still pending/unknown
            try:
                await self.w3.eth.get_transaction(tx_hash)
                return {"status": "pending"}
            except Exception:  # noqa: BLE001
                return {"status": "unknown"}
        return {
            "status": "success" if receipt["status"] == 1 else "reverted",
            "blockNumber": receipt["blockNumber"],
            "gasUsed": receipt["gasUsed"],
        }

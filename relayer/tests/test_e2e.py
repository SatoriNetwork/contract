"""End-to-end: a REAL gasless predict through the HTTP API against a local
hardhat node running the deployed Satori stack.

    cd ../satori
    npx hardhat node                                              # background
    npx hardhat run scripts/deploy-relay-e2e.js --network localhost
    cd ../relayer && python3 -m pytest tests/test_e2e.py -q

Skips itself when the deploy target file is absent, so the unit suite stays
runnable anywhere. tests/run_e2e.sh does the whole dance."""

import asyncio
import importlib
import json
import os
from pathlib import Path

import pytest

TARGET = Path(__file__).parent / "e2e-target.json"

pytestmark = pytest.mark.skipif(
    not TARGET.exists(), reason="no e2e target — run scripts/deploy-relay-e2e.js first"
)


@pytest.fixture()
def target():
    return json.loads(TARGET.read_text())


@pytest.fixture()
def client(target, monkeypatch, tmp_path):
    fee_file = tmp_path / "fees.json"
    fee_file.write_text(json.dumps({"default": "0.25"}))
    monkeypatch.setenv("RPC_URL", target["rpc"])
    monkeypatch.setenv("CHAIN_ID", str(target["chainId"]))
    monkeypatch.setenv("HUB_ADDRESS", target["hub"])
    monkeypatch.setenv("TOKEN_ADDRESS", target["token"])
    monkeypatch.setenv("RELAYER_PRIVATE_KEY", target["relayerKey"])
    monkeypatch.setenv("FEE_FILE", str(fee_file))

    from app import config, contracts, fees, main, relayer
    for mod in (config, fees, contracts, relayer, main):
        importlib.reload(mod)

    return main.app


async def _with_client(app, fn):
    import httpx
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://relay") as c:
            return await fn(c)


def _sign_permit(target, spender: str, value: int, deadline: int, w3_nonce: int) -> dict:
    from eth_account import Account
    acct = Account.from_key(target["userKey"])
    td = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Permit": [
                {"name": "owner", "type": "address"},
                {"name": "spender", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "nonce", "type": "uint256"},
                {"name": "deadline", "type": "uint256"},
            ],
        },
        "primaryType": "Permit",
        "domain": {"name": "Satori", "version": "1",
                   "chainId": target["chainId"], "verifyingContract": target["token"]},
        "message": {"owner": acct.address, "spender": spender, "value": value,
                    "nonce": w3_nonce, "deadline": deadline},
    }
    sig = acct.sign_typed_data(full_message=td).signature.to_0x_hex()
    return {"value": str(value), "deadline": deadline, "signature": sig}


def test_gasless_predict_end_to_end(client, target):
    from eth_abi import encode as abi_encode
    from eth_account import Account
    from web3 import AsyncWeb3
    from web3.providers.rpc import AsyncHTTPProvider

    from app.contracts import hub_contract, token_contract

    user = Account.from_key(target["userKey"])
    predict_data = "0x" + abi_encode(
        ["address", "(uint32,bytes)[]"],
        ["0x0000000000000000000000000000000000000000", [(target["streamId"], b"\x01")]],
    ).hex()

    async def flow(c):
        w3 = AsyncWeb3(AsyncHTTPProvider(target["rpc"]))
        hub = hub_contract(w3, target["hub"])
        token = token_contract(w3, target["token"])

        health = (await c.get("/health")).json()
        assert health["ok"], health

        # 1. quote
        q = await c.post("/gasless/quote",
                         json={"user": user.address, "action": 0, "data": predict_data})
        assert q.status_code == 200, q.text
        quote = q.json()
        assert quote["nonce"] == 0

        # 2. sign the quote's typed data — exactly what a wallet does
        sig = user.sign_typed_data(full_message=quote["typedData"]).signature.to_0x_hex()

        # 3. standing-allowance permit rides along (user allowance was zeroed
        #    by the deploy script, so this permit is load-bearing)
        permit = _sign_permit(
            target, target["hub"], 20 * 10**18, quote["deadline"],
            await token.functions.nonces(user.address).call())

        relayer_before = await token.functions.balanceOf(target["relayer"]).call()

        # 4. submit
        s = await c.post("/gasless/submit", json={
            "user": user.address, "action": 0, "data": predict_data,
            "fee": quote["fee"], "nonce": quote["nonce"],
            "deadline": quote["deadline"], "signature": sig, "permit": permit,
        })
        assert s.status_code == 200, s.text
        tx_hash = s.json()["transactionHash"]

        # 5. confirmed on chain (hardhat automines)
        for _ in range(20):
            status = (await c.get(f"/gasless/tx/{tx_hash}")).json()
            if status["status"] != "pending":
                break
            await asyncio.sleep(0.25)
        assert status["status"] == "success", status

        # 6. the states only a real relay produces
        assert await hub.functions.relayNonces(user.address).call() == 1
        relayer_after = await token.functions.balanceOf(target["relayer"]).call()
        assert relayer_after - relayer_before == int(quote["fee"])

        # 7. a replay of the same signed request is refused before broadcast
        s2 = await c.post("/gasless/submit", json={
            "user": user.address, "action": 0, "data": predict_data,
            "fee": quote["fee"], "nonce": quote["nonce"],
            "deadline": quote["deadline"], "signature": sig, "permit": permit,
        })
        assert s2.status_code == 400 and "nonce" in s2.text

    asyncio.run(_with_client(client, flow))


def test_tampered_submission_refused(client, target):
    from eth_abi import encode as abi_encode
    from eth_account import Account

    user = Account.from_key(target["userKey"])
    predict_data = "0x" + abi_encode(
        ["address", "(uint32,bytes)[]"],
        ["0x0000000000000000000000000000000000000000", [(target["streamId"], b"\x01")]],
    ).hex()

    async def flow(c):
        q = (await c.post("/gasless/quote",
                          json={"user": user.address, "action": 0, "data": predict_data})).json()
        sig = user.sign_typed_data(full_message=q["typedData"]).signature.to_0x_hex()
        # raise the fee after signing
        s = await c.post("/gasless/submit", json={
            "user": user.address, "action": 0, "data": predict_data,
            "fee": str(int(q["fee"]) * 2), "nonce": q["nonce"],
            "deadline": q["deadline"], "signature": sig,
        })
        assert s.status_code == 400 and "signature" in s.text

    asyncio.run(_with_client(client, flow))

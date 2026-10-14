import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from decimal import Decimal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .fees import policy_ok
from .models import HealthOut, QuoteIn, QuoteOut, SubmitIn, SubmitOut, TxOut
from .relayer import Relayer, RelayRefused
from .signing import typed_data


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.relayer = Relayer()
    yield


app = FastAPI(title="Satori gasless relayer", lifespan=lifespan)

# The dapp calls this service from the browser, cross-origin (the UI and the
# relayer are different hosts/ports), so without CORS every fetch is blocked
# before it leaves the page. Allowed origins are configurable; default "*"
# because the API is public by design (it holds no per-origin secret — every
# request is authorized by the user's on-chain-verified signature, not by who
# is calling).
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# Per-IP sliding window over the public endpoints. In-memory on purpose: one
# relayer process is the V1 shape, and losing counters on restart is harmless.
_hits: dict[str, deque] = defaultdict(deque)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if request.url.path.startswith("/gasless/"):
        ip = request.client.host if request.client else "?"
        now = time.monotonic()
        window = _hits[ip]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= settings.rate_limit_per_minute:
            raise HTTPException(429, "rate limited")
        window.append(now)
    return await call_next(request)


@app.post("/gasless/quote", response_model=QuoteOut)
async def quote(q: QuoteIn, request: Request):
    r: Relayer = request.app.state.relayer
    try:
        req = await r.quote(q.user, q.action, q.data)
    except RelayRefused as e:
        raise HTTPException(400, str(e)) from e
    return QuoteOut(
        fee=str(req["fee"]),
        relayer=req["relayer"],
        nonce=req["nonce"],
        deadline=req["deadline"],
        typedData=typed_data(settings.chain_id, settings.hub_address,
                             {**req, "fee": req["fee"]}),
    )


@app.post("/gasless/submit", response_model=SubmitOut)
async def submit(s: SubmitIn, request: Request):
    r: Relayer = request.app.state.relayer
    try:
        tx_hash = await r.submit(s)
    except RelayRefused as e:
        raise HTTPException(400, str(e)) from e
    return SubmitOut(transactionHash=tx_hash)


@app.get("/gasless/tx/{tx_hash}", response_model=TxOut)
async def tx(tx_hash: str, request: Request):
    r: Relayer = request.app.state.relayer
    return TxOut(**await r.tx_status(tx_hash))


@app.get("/health", response_model=HealthOut)
async def health(request: Request):
    r: Relayer = request.app.state.relayer
    ok, bal = await r.healthy()
    fees_ok = policy_ok()
    return HealthOut(
        ok=ok and fees_ok,
        chainId=settings.chain_id,
        relayer=r.account.address,
        relayerEth=str(bal),
        minEth=str(Decimal(settings.min_relayer_eth)),
        feePolicyOk=fees_ok,
    )

from pydantic import BaseModel, Field, field_validator

HEX = r"^0x[0-9a-fA-F]*$"
ADDR = r"^0x[0-9a-fA-F]{40}$"


class QuoteIn(BaseModel):
    user: str = Field(pattern=ADDR)
    action: int = Field(ge=0, le=6)
    data: str = Field(pattern=HEX, description="abi-encoded action args")


class QuoteOut(BaseModel):
    fee: str
    relayer: str
    nonce: int
    deadline: int
    typedData: dict


class PermitIn(BaseModel):
    value: str = Field(description="allowance in wei, decimal string")
    deadline: int
    signature: str = Field(pattern=HEX)


class SubmitIn(BaseModel):
    user: str = Field(pattern=ADDR)
    action: int = Field(ge=0, le=6)
    data: str = Field(pattern=HEX)
    fee: str = Field(description="wei, decimal string — exactly what was signed")
    nonce: int
    deadline: int
    signature: str = Field(pattern=HEX)
    permit: PermitIn | None = None

    @field_validator("fee")
    @classmethod
    def _fee_is_uint(cls, v: str) -> str:
        if int(v) < 0:
            raise ValueError("fee must be non-negative")
        return v


class SubmitOut(BaseModel):
    transactionHash: str


class TxOut(BaseModel):
    status: str  # pending | success | reverted | unknown
    blockNumber: int | None = None
    gasUsed: int | None = None


class HealthOut(BaseModel):
    ok: bool
    chainId: int
    relayer: str
    relayerEth: str
    minEth: str
    feePolicyOk: bool

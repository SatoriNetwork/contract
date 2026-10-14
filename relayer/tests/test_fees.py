import importlib
import json


def _fees(tmp_path, monkeypatch, content=None):
    """Fresh fees module bound to a temp FEE_FILE (or a missing one)."""
    path = tmp_path / "fees.json"
    if content is not None:
        path.write_text(content)
    monkeypatch.setenv("FEE_FILE", str(path))
    monkeypatch.setenv("FLAT_FEE_SATORI", "0.25")
    from app import config, fees
    importlib.reload(config)
    return importlib.reload(fees)


def test_missing_file_falls_back_to_flat_fee(tmp_path, monkeypatch):
    fees = _fees(tmp_path, monkeypatch)
    from app.signing import RelayAction
    assert fees.fee_wei(RelayAction.Predict) == 250_000_000_000_000_000
    assert fees.policy_ok()


def test_per_action_and_default(tmp_path, monkeypatch):
    fees = _fees(tmp_path, monkeypatch, json.dumps(
        {"default": "0.5", "per_action": {"Claim": "0", "Predict": "1.5"}}))
    from app.signing import RelayAction
    assert fees.fee_wei(RelayAction.Predict) == 1_500_000_000_000_000_000
    assert fees.fee_wei(RelayAction.Claim) == 0
    assert fees.fee_wei(RelayAction.Vote) == 500_000_000_000_000_000


def test_edit_reprices_without_restart(tmp_path, monkeypatch):
    import os
    import time
    fees = _fees(tmp_path, monkeypatch, json.dumps({"default": "0.5"}))
    from app.signing import RelayAction
    assert fees.fee_wei(RelayAction.Predict) == 500_000_000_000_000_000
    path = tmp_path / "fees.json"
    path.write_text(json.dumps({"default": "0.75"}))
    # mtime resolution can swallow a same-second rewrite; force it forward.
    st = os.stat(path)
    os.utime(path, (st.st_atime, st.st_mtime + 2))
    _ = time
    assert fees.fee_wei(RelayAction.Predict) == 750_000_000_000_000_000


def test_malformed_file_falls_back_and_flags_health(tmp_path, monkeypatch):
    fees = _fees(tmp_path, monkeypatch, "{not json")
    from app.signing import RelayAction
    assert fees.fee_wei(RelayAction.Predict) == 250_000_000_000_000_000
    assert not fees.policy_ok()

# se_kernel — Rust kernel for the strategy engine's indicator math

`se_kernel` is a small PyO3 extension that replaces the hot numeric helpers in
`signal_engine.py` (`calculate_indicators` and the bar helpers under it). It
exists because a cached Unusual Whales backtest session spent ~76% of its CPU
re-aggregating ~2,300 one-minute bars and re-deriving Eastern-time session
membership in pure Python on every simulated minute; the same functions run
live at 4 Hz in `trade_prefetch_service.py`.

The Python bodies stay in `signal_engine.py` as `*_py` functions and remain the
reference implementation. The kernel must produce **bit-identical** results.

## Contract

- **Same inputs.** Functions take the engine's `list[dict]` bars
  (`time, open, high, low, close, volume`).
- **No clock.** Every entry point takes `now: float`. The Python wrappers pass
  `time.time()`, so the backtest's clock monkeypatch and the tests' `patch()`
  keep working.
- **No rounding.** Rust returns raw `f64`; the wrappers apply the same
  `round(...)` calls as the reference (`round` is correctly-rounded half-even
  on the decimal value, which is easier to keep exact in Python).
- **Same arithmetic order.** Sequential sums, the EMA recursion, medians and
  comparisons follow the Python statements one for one.
- **Same errors and skips.** Fields that are not plain int/float fall back to
  the original Python object so `KeyError`/`TypeError`/`ValueError` and the
  "skip malformed time" behaviour match.
- **Original objects.** Filters (`session_bars`, `completed_bars`) return the
  caller's bar objects, not copies.

Exports: `session_bars`, `completed_bars`, `aggregate_bars`, `time_of_day_rvol`,
`atr`, `ema`, `median_volume`, `completed_vwap`, `indicator_core`.

## Switch

`SE_KERNEL` environment variable, read once at import of `signal_engine`:

| value | behaviour |
|---|---|
| `auto` (default) | use the extension when importable, else the Python reference |
| `python` | always the Python reference (production rollback) |
| `rust` | require the extension; `ImportError` if missing (used by the parity harness so it can never silently compare Python to Python) |

`signal_engine.kernel_backend()` reports `"rust"` or `"python"`; the strategy
engine writes it into `health.json` as `"kernel"`.

## Build

Dev Mac (system Python 3.9 is fine: the wheel is abi3, one build serves 3.9+):

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
python3 -m pip install --user maturin
cd strategy-engine/se_kernel
maturin build --release --out target/wheels
python3 -m pip install --user --force-reinstall --no-deps target/wheels/*.whl
python3 -c "import se_kernel; print(se_kernel.__version__)"
```

Docker: `strategy-engine/Dockerfile` builds the wheel in a
`ghcr.io/pyo3/maturin` stage (multi-arch manylinux, so the same file works on
the arm64 dev Mac and the Linux Coolify host) and installs it into the
`python:3.11-slim` runtime stage. Coolify builds from Git on push; the Rust
dependency compile is a cached layer keyed on `Cargo.toml`/`Cargo.lock`.

## Verify

```sh
cd strategy-engine
SE_KERNEL=python python3 -m unittest discover -p 'test_*.py'
SE_KERNEL=rust   python3 -m unittest discover -p 'test_*.py'   # includes test_se_kernel_parity.py
./kernel_parity_check.sh /tmp/parity both                     # 10 cached UW sessions, byte-identical outputs
```

`kernel_parity_check.sh` runs `uw_backtest.py --cache-only` and
`kernel_indicator_dump.py` (per-minute `calculate_indicators` output) under
both backends and diffs every file. It never calls the vendor API.

## Measured (dev Mac, Python 3.9, one cached session, 2026-08-20)

| | pure Python | se_kernel |
|---|---|---|
| `calculate_indicators`, 656 calls, cumulative (profiled) | 9.27 s | 0.61 s |
| session wall time, unprofiled | 7.1 s | 1.9 s |
| live-shaped single call (~3,000 bars) | 2.33 ms | 0.61 ms |

## Adding a function

1. Port the Python body to Rust in `src/lib.rs` (or `src/fast.rs` when it runs
   inside `indicator_core`), keeping statement order and error behaviour.
2. Rename the Python body to `<name>_py` and add the `if _USE_RUST:` dispatch.
3. Extend `test_se_kernel_parity.py` and rerun `kernel_parity_check.sh both`.

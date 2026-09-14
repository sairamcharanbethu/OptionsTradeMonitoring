# se_kernel: the strategy engine's Rust indicator kernel

## Why it exists

On 2026-09-13 the operator asked whether to convert the Node/TypeScript
services to Rust. The assessment said no (nothing is latency-bound; the
broker clients have no mature Rust equivalents; a rewrite would reset months of
incident-driven fixes in the kill switch, flatten and gate code) and instead
profiled for a real CPU hotspot. The TypeScript replay backtester turned out to
be I/O-bound. The Python strategy engine was not: `cProfile` on one cached
Unusual Whales session put 76% of 12.2 s inside
`signal_engine.calculate_indicators`, which re-aggregates ~2,300 one-minute bars
into 5/15/60-minute candles and recomputes Eastern-time session membership on
every simulated minute, in pure Python with no numpy.

That function and its helpers now have a Rust implementation in
`strategy-engine/se_kernel/` (PyO3, abi3 wheel built by maturin). The Python
bodies remain in `signal_engine.py` as the reference and the fallback.

## Guarantees

- Bit-identical output to the Python reference, verified three ways: the
  existing unit suite passes under both backends; `test_se_kernel_parity.py`
  compares every kernel function against the reference on seeded random bars
  with feed quirks (int and float volumes, zero/None/missing volume, malformed
  time) across both 2026 DST transitions and asserts value **and** type
  equality; `kernel_parity_check.sh` replays ten cached sessions from 2026-04
  to 2026-08 under both backends and diffs the per-minute indicator dumps, the
  backtest output and the trade files byte for byte.
- No change to the live contract. `engine_version` stays `signal-only-v2`; the
  file/Redis protocol with the Node adapter is untouched. The only visible
  addition is `"kernel": "rust" | "python"` in `health.json`.
- The kernel never reads the clock, so the backtest's `time.time` monkeypatch
  and the tests' `patch()` continue to drive it.

## Operating it

- Default is `SE_KERNEL=auto`: the container uses the kernel because the image
  installs it; a dev checkout without the wheel silently uses Python.
- **Rollback**: set `SE_KERNEL=python` in the `strategy-engine` and
  `zerogex-prefetch` service environment in compose, redeploy, and confirm
  `health.json` shows `"kernel": "python"`. No code change needed.
- The Docker build gains a `ghcr.io/pyo3/maturin` stage. First uncached build
  on Coolify compiles pyo3 and chrono (a few minutes); later builds hit the
  cached dependency layer unless `Cargo.toml`/`Cargo.lock` change.

## Measured effect (dev Mac, Python 3.9, cached session 2026-08-20)

| metric | pure Python | se_kernel |
|---|---|---|
| session wall time, unprofiled | 7.1 s | 1.9 s |
| `calculate_indicators` cumulative under cProfile (656 calls) | 9.27 s | 0.61 s |
| single live-shaped call, ~3,000 bars (6 sessions) | 2.33 ms | 0.61 ms |

The remaining ~1.3 s per session is `build_signal` and its dict-shaping helpers;
those are decision-tree code, not numeric loops, and were left in Python on
purpose. A cached yearly re-run of the overnight backtest is therefore roughly
30 minutes in Python and about 8 minutes with the kernel.

## Not ported (deliberately)

- `gex_wall_evaluator._aggregate`: looks like `_aggregate_bars` but floats every
  field and skips malformed rows per bucket, so it is not byte-identical and is
  cheap (one call per tick).
- `_ema_vwap_rejection_event`, `price_structure.session_levels`,
  `build_signal`: small share of the profile after the kernel; port only if a
  new profile says so.
- Anything in `backend/` (TypeScript). The replay backtester's only CPU blemish
  is constructing `Intl.DateTimeFormat` per call in `getTimeWindowKey` and
  `parseBarTime`, a two-line hoist if it ever matters.

See `strategy-engine/se_kernel/README.md` for the build and the parity
commands.

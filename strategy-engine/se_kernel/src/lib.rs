//! `se_kernel`: Rust implementations of the hot numeric helpers in
//! `strategy-engine/signal_engine.py`.
//!
//! Contract (see se_kernel/README.md):
//! * Inputs are the same `list[dict]` bars the Python helpers take.
//! * Every entry point takes `now` explicitly and never reads the clock.
//! * Nothing here rounds; the Python wrappers apply `round(...)`.
//! * Filters return the caller's original bar objects, not copies.
//! * Arithmetic is performed in the same order as the Python reference so
//!   results are bit-identical.

mod et;
mod fast;
mod util;

use pyo3::exceptions::{PyKeyError, PyOverflowError, PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyFloat, PyInt, PyList};

use et::{et_stamp, EtStamp};
use util::{bucket_of, ema, is_number, is_truthy, median, py_float, py_sum};

// ---------------------------------------------------------------------------
// dict access helpers
// ---------------------------------------------------------------------------

/// `bar[key]` — KeyError when missing (TypeError when not subscriptable).
fn item<'py>(bar: &Bound<'py, PyAny>, key: &str) -> PyResult<Bound<'py, PyAny>> {
    bar.get_item(key)
}

/// `bar.get(key)` — `None` when missing.
fn dget<'py>(bar: &Bound<'py, PyAny>, key: &str) -> PyResult<Option<Bound<'py, PyAny>>> {
    if let Ok(dict) = bar.cast::<PyDict>() {
        return dict.get_item(key);
    }
    let value = bar.call_method1("get", (key,))?;
    Ok(if value.is_none() { None } else { Some(value) })
}

/// `float(bar.get(key, 0))`
fn get_float_default0(bar: &Bound<'_, PyAny>, key: &str) -> PyResult<f64> {
    match dget(bar, key)? {
        Some(value) => py_float(&value),
        None => Ok(0.0),
    }
}

/// `float(bar.get(key, 0) or 0)`
fn get_float_or0(bar: &Bound<'_, PyAny>, key: &str) -> PyResult<f64> {
    match dget(bar, key)? {
        Some(value) if is_truthy(&value)? => py_float(&value),
        _ => Ok(0.0),
    }
}

fn collect<'py>(bars: &Bound<'py, PyAny>) -> PyResult<Vec<Bound<'py, PyAny>>> {
    bars.try_iter()?.collect()
}

fn to_list<'py>(py: Python<'py>, items: Vec<Bound<'py, PyAny>>) -> PyResult<Bound<'py, PyList>> {
    PyList::new(py, items)
}

/// `datetime.fromtimestamp(ts, ET)` where CPython would raise instead of skip.
fn et_or_raise(ts: f64) -> PyResult<EtStamp> {
    if ts.is_nan() {
        return Err(PyValueError::new_err("cannot convert float NaN to integer"));
    }
    if ts.is_infinite() {
        return Err(PyOverflowError::new_err("cannot convert float infinity to integer"));
    }
    et_stamp(ts).ok_or_else(|| PyValueError::new_err("timestamp out of range for platform time_t"))
}

// ---------------------------------------------------------------------------
// _session_bars / _completed_bars
// ---------------------------------------------------------------------------

fn session_filter<'py>(bars: &[Bound<'py, PyAny>], now: f64) -> PyResult<Vec<Bound<'py, PyAny>>> {
    let today = et_or_raise(now)?;
    let mut out = Vec::with_capacity(bars.len());
    for bar in bars {
        // except (KeyError, TypeError, ValueError, OSError): continue
        let stamp_obj = match item(bar, "time") {
            Ok(value) => value,
            Err(err) => {
                let py = bar.py();
                if err.is_instance_of::<PyKeyError>(py) || err.is_instance_of::<PyTypeError>(py) {
                    continue;
                }
                return Err(err);
            }
        };
        let ts = match py_float(&stamp_obj) {
            Ok(ts) => ts,
            Err(err) => {
                let py = bar.py();
                if err.is_instance_of::<PyTypeError>(py) || err.is_instance_of::<PyValueError>(py) {
                    continue;
                }
                return Err(err); // OverflowError propagates in Python too
            }
        };
        if ts.is_infinite() {
            return Err(PyOverflowError::new_err("cannot convert float infinity to integer"));
        }
        // NaN -> ValueError (caught), out of range -> OSError (caught)
        if let Some(stamp) = et_stamp(ts) {
            if stamp.ordinal == today.ordinal {
                out.push(bar.clone());
            }
        }
    }
    Ok(out)
}

fn completed_filter<'py>(bars: &[Bound<'py, PyAny>], now: f64) -> PyResult<Vec<Bound<'py, PyAny>>> {
    let minute_start = bucket_of(now, 60)? as f64;
    let mut out = Vec::with_capacity(bars.len());
    for bar in bars {
        if get_float_default0(bar, "time")? < minute_start {
            out.push(bar.clone());
        }
    }
    Ok(out)
}

/// `signal_engine._session_bars(bars, now=now)`
#[pyfunction]
#[pyo3(signature = (bars, now))]
fn session_bars<'py>(py: Python<'py>, bars: &Bound<'py, PyAny>, now: f64) -> PyResult<Bound<'py, PyList>> {
    let items = collect(bars)?;
    to_list(py, session_filter(&items, now)?)
}

/// `signal_engine._completed_bars(bars)` with the clock passed in.
#[pyfunction]
#[pyo3(signature = (bars, now))]
fn completed_bars<'py>(py: Python<'py>, bars: &Bound<'py, PyAny>, now: f64) -> PyResult<Bound<'py, PyList>> {
    let items = collect(bars)?;
    to_list(py, completed_filter(&items, now)?)
}

// ---------------------------------------------------------------------------
// _aggregate_bars
// ---------------------------------------------------------------------------

/// Python `sum(... or 0)` result type tracking: int unless any float joined.
#[derive(Clone, Copy)]
struct VolSum {
    value: f64,
    is_float: bool,
}

struct Agg<'py> {
    time: i64,
    open: Bound<'py, PyAny>,
    high: Bound<'py, PyAny>,
    low: Bound<'py, PyAny>,
    close: Bound<'py, PyAny>,
    volume: VolSum,
}

fn aggregate<'py>(bars: &[Bound<'py, PyAny>], minutes: i64, now: f64) -> PyResult<Vec<Agg<'py>>> {
    let seconds = minutes * 60;
    // insertion-ordered groups keyed by bucket
    let mut order: Vec<i64> = Vec::new();
    let mut groups: std::collections::HashMap<i64, Vec<&Bound<'py, PyAny>>> = std::collections::HashMap::new();
    for bar in bars {
        let ts = py_float(&item(bar, "time")?)?;
        let bucket = bucket_of(ts, seconds)?;
        let entry = groups.entry(bucket).or_insert_with(|| {
            order.push(bucket);
            Vec::new()
        });
        entry.push(bar);
    }
    order.sort_unstable();
    let mut out = Vec::with_capacity(order.len());
    for bucket in order {
        let items = &groups[&bucket];
        let open = item(items[0], "open")?;
        // max()/min(): first maximal / minimal element wins on ties
        let mut high = item(items[0], "high")?;
        let mut high_f = py_float(&high)?;
        for it in &items[1..] {
            let candidate = item(it, "high")?;
            let value = py_float(&candidate)?;
            if value > high_f {
                high = candidate;
                high_f = value;
            }
        }
        let mut low = item(items[0], "low")?;
        let mut low_f = py_float(&low)?;
        for it in &items[1..] {
            let candidate = item(it, "low")?;
            let value = py_float(&candidate)?;
            if value < low_f {
                low = candidate;
                low_f = value;
            }
        }
        let close = item(items[items.len() - 1], "close")?;
        py_float(&close)?; // Python floats the close too; keep its error behaviour
        let mut volume = VolSum { value: 0.0, is_float: false };
        for it in items.iter() {
            match dget(it, "volume")? {
                Some(v) if is_truthy(&v)? => {
                    if v.is_instance_of::<PyFloat>() {
                        volume.is_float = true;
                        volume.value += py_float(&v)?;
                    } else if v.is_instance_of::<PyInt>() {
                        volume.value += py_float(&v)?;
                    } else {
                        return Err(PyTypeError::new_err(format!(
                            "unsupported operand type(s) for +: 'int' and '{}'",
                            v.get_type().name()?
                        )));
                    }
                }
                _ => {} // `or 0` → adding int 0 changes nothing
            }
        }
        out.push(Agg { time: bucket, open, high, low, close, volume });
    }
    let current_bucket = bucket_of(now, seconds)?;
    out.retain(|agg| agg.time < current_bucket);
    Ok(out)
}

fn agg_to_dict<'py>(py: Python<'py>, agg: &Agg<'py>) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("time", agg.time)?;
    dict.set_item("open", &agg.open)?;
    dict.set_item("high", &agg.high)?;
    dict.set_item("low", &agg.low)?;
    dict.set_item("close", &agg.close)?;
    if agg.volume.is_float {
        dict.set_item("volume", agg.volume.value)?;
    } else {
        dict.set_item("volume", agg.volume.value as i64)?;
    }
    Ok(dict)
}

/// `signal_engine._aggregate_bars(bars, minutes)` with the clock passed in.
#[pyfunction]
#[pyo3(signature = (bars, minutes, now))]
fn aggregate_bars<'py>(py: Python<'py>, bars: &Bound<'py, PyAny>, minutes: i64, now: f64) -> PyResult<Bound<'py, PyList>> {
    let items = collect(bars)?;
    let aggs = aggregate(&items, minutes, now)?;
    let dicts: Vec<Bound<'py, PyAny>> = aggs
        .iter()
        .map(|agg| agg_to_dict(py, agg).map(|d| d.into_any()))
        .collect::<PyResult<_>>()?;
    to_list(py, dicts)
}

// ---------------------------------------------------------------------------
// _time_of_day_rvol / _atr / _ema / _median_volume / _completed_vwap
// ---------------------------------------------------------------------------

fn time_of_day_rvol_inner(
    latest: Option<&Bound<'_, PyAny>>,
    all_completed: &[Bound<'_, PyAny>],
    minute_tolerance: i32,
) -> PyResult<(Option<f64>, usize)> {
    let latest = match latest {
        Some(obj) if is_truthy(obj)? => obj,
        _ => return Ok((None, 0)),
    };
    let latest_time = match dget(latest, "time")? {
        Some(value) if is_number(&value) => py_float(&value)?,
        _ => return Ok((None, 0)),
    };
    let latest_stamp = et_or_raise(latest_time)?;
    let mut reference: Vec<f64> = Vec::new();
    for bar in all_completed {
        let time_obj = match dget(bar, "time")? {
            Some(value) if is_number(&value) => value,
            _ => continue,
        };
        let volume_obj = match dget(bar, "volume")? {
            Some(value) if is_number(&value) => value,
            _ => continue,
        };
        let stamp = et_or_raise(py_float(&time_obj)?)?;
        if stamp.ordinal != latest_stamp.ordinal
            && (stamp.minute_of_day - latest_stamp.minute_of_day).abs() <= minute_tolerance
        {
            let volume = py_float(&volume_obj)?;
            if volume > 0.0 {
                reference.push(volume);
            }
        }
    }
    let latest_volume = get_float_or0(latest, "volume")?;
    let baseline = if reference.len() >= 10 { Some(median(&reference)) } else { None };
    let rvol = match baseline {
        Some(b) if latest_volume > 0.0 && b != 0.0 => Some(latest_volume / b),
        _ => None,
    };
    Ok((rvol, reference.len()))
}

/// `signal_engine._time_of_day_rvol(latest, all_completed, minute_tolerance=2)`
#[pyfunction]
#[pyo3(signature = (latest, all_completed, minute_tolerance = 2))]
fn time_of_day_rvol(
    latest: Option<&Bound<'_, PyAny>>,
    all_completed: &Bound<'_, PyAny>,
    minute_tolerance: i32,
) -> PyResult<(Option<f64>, usize)> {
    let items = collect(all_completed)?;
    time_of_day_rvol_inner(latest, &items, minute_tolerance)
}

fn atr_from(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> Option<f64> {
    let n = highs.len();
    if n < 2 {
        return None;
    }
    let mut ranges = Vec::with_capacity(n - 1);
    for i in 1..n {
        let hl = highs[i] - lows[i];
        let hc = (highs[i] - closes[i - 1]).abs();
        let lc = (lows[i] - closes[i - 1]).abs();
        // max(a, b, c): first maximal wins; only the value matters for floats
        let mut m = hl;
        if hc > m {
            m = hc;
        }
        if lc > m {
            m = lc;
        }
        ranges.push(m);
    }
    let start = ranges.len().saturating_sub(period);
    let window = &ranges[start..];
    if window.is_empty() {
        return None;
    }
    Some(py_sum(window.iter().copied()) / window.len() as f64)
}

fn hlc_of_bars(bars: &[Bound<'_, PyAny>]) -> PyResult<(Vec<f64>, Vec<f64>, Vec<f64>)> {
    let mut highs = Vec::with_capacity(bars.len());
    let mut lows = Vec::with_capacity(bars.len());
    let mut closes = Vec::with_capacity(bars.len());
    for bar in bars {
        highs.push(py_float(&item(bar, "high")?)?);
        lows.push(py_float(&item(bar, "low")?)?);
        closes.push(py_float(&item(bar, "close")?)?);
    }
    Ok((highs, lows, closes))
}

/// `signal_engine._atr(bars, period=14)` unrounded.
#[pyfunction]
#[pyo3(signature = (bars, period = 14))]
fn atr(bars: &Bound<'_, PyAny>, period: usize) -> PyResult<Option<f64>> {
    let items = collect(bars)?;
    if items.len() < 2 {
        return Ok(None);
    }
    let (highs, lows, closes) = hlc_of_bars(&items)?;
    Ok(atr_from(&highs, &lows, &closes, period))
}

/// `signal_engine._ema(values, period)` unrounded.
#[pyfunction]
#[pyo3(name = "ema", signature = (values, period))]
fn ema_py(values: &Bound<'_, PyAny>, period: i64) -> PyResult<Option<f64>> {
    let floats: Vec<f64> = values.try_iter()?.map(|v| py_float(&v?)).collect::<PyResult<_>>()?;
    Ok(ema(&floats, period))
}

fn median_volume_inner(completed: &[Bound<'_, PyAny>], window: usize) -> PyResult<Option<f64>> {
    let start = completed.len().saturating_sub(window);
    let mut volumes: Vec<f64> = Vec::new();
    for bar in &completed[start..] {
        let py = bar.py();
        let value = match dget(bar, "volume")? {
            Some(v) => v,
            None => 0i64.into_pyobject(py)?.into_any(),
        };
        if value.gt(0i64)? {
            volumes.push(py_float(&value)?);
        }
    }
    if volumes.is_empty() {
        return Ok(None);
    }
    let first = median(&volumes);
    let limit = first * 3.0;
    let filtered: Vec<f64> = volumes.iter().copied().filter(|v| *v <= limit).collect();
    Ok(Some(if filtered.is_empty() { median(&volumes) } else { median(&filtered) }))
}

/// `signal_engine._median_volume(completed, window=20)`
#[pyfunction]
#[pyo3(signature = (completed, window = 20))]
fn median_volume(completed: &Bound<'_, PyAny>, window: usize) -> PyResult<Option<f64>> {
    let items = collect(completed)?;
    median_volume_inner(&items, window)
}

/// `signal_engine._completed_vwap(bars, cutoff)` unrounded.
#[pyfunction]
#[pyo3(signature = (bars, cutoff))]
fn completed_vwap(bars: &Bound<'_, PyAny>, cutoff: f64) -> PyResult<Option<f64>> {
    let items = collect(bars)?;
    let mut eligible: Vec<&Bound<'_, PyAny>> = Vec::with_capacity(items.len());
    for bar in &items {
        if py_float(&item(bar, "time")?)? < cutoff {
            eligible.push(bar);
        }
    }
    let mut volume = 0.0f64;
    for bar in &eligible {
        volume += py_float(&item(bar, "volume")?)?;
    }
    if volume <= 0.0 {
        return Ok(None);
    }
    let mut weighted = 0.0f64;
    for bar in &eligible {
        let o = py_float(&item(bar, "open")?)?;
        let h = py_float(&item(bar, "high")?)?;
        let l = py_float(&item(bar, "low")?)?;
        let c = py_float(&item(bar, "close")?)?;
        let v = py_float(&item(bar, "volume")?)?;
        weighted += (o + h + l + c) / 4.0 * v;
    }
    Ok(Some(weighted / volume))
}

// ---------------------------------------------------------------------------
// indicator_core: the numeric body of calculate_indicators, unrounded
// ---------------------------------------------------------------------------

fn set_opt(dict: &Bound<'_, PyDict>, key: &str, value: Option<f64>) -> PyResult<()> {
    match value {
        Some(v) => dict.set_item(key, v),
        None => dict.set_item(key, dict.py().None()),
    }
}

/// Raw (unrounded) values behind `signal_engine.calculate_indicators`.
///
/// Bars are converted once (see `fast.rs`); everything after that is plain
/// f64 arithmetic in the same order as the Python body.
#[pyfunction]
#[pyo3(signature = (bars, now))]
fn indicator_core<'py>(py: Python<'py>, bars: &Bound<'py, PyAny>, now: f64) -> PyResult<Bound<'py, PyDict>> {
    let objs = collect(bars)?;
    let all_bars = fast::convert(py, &objs)?;
    let all_idx: Vec<usize> = (0..all_bars.len()).collect();
    let session = fast::session_idx(&all_bars, now)?;
    let completed = fast::completed_idx(&all_bars, &session, now)?;
    let all_completed = fast::completed_idx(&all_bars, &all_idx, now)?;

    let closes = fast::closes(&all_bars, &completed)?;
    let (volume_sum, vwap_numerator) = fast::session_vwap_terms(&all_bars, &session)?;

    let five = fast::aggregate(&all_bars, &all_completed, 5, now)?;
    let fifteen = fast::aggregate(&all_bars, &all_completed, 15, now)?;
    let hourly = fast::aggregate(&all_bars, &all_completed, 60, now)?;
    let five_closes: Vec<f64> = five.iter().map(|a| a.close).collect();
    let fifteen_closes: Vec<f64> = fifteen.iter().map(|a| a.close).collect();
    let hourly_closes: Vec<f64> = hourly.iter().map(|a| a.close).collect();

    let median_vol = fast::median_volume(&all_bars, &completed, 20)?;
    let latest_volume = fast::latest_volume(&all_bars, &completed)?;
    let (historical_rvol, historical_samples) =
        fast::time_of_day_rvol(&all_bars, completed.last().copied(), &all_completed, 2)?;
    let rolling_rvol = match (latest_volume, median_vol) {
        (Some(lv), Some(mv)) if lv != 0.0 && mv != 0.0 => Some(lv / mv),
        _ => None,
    };

    let out = PyDict::new(py);
    out.set_item("bars_1m", session.len())?;
    out.set_item("completed_1m", completed.len())?;
    out.set_item("completed_5m", five.len())?;
    match completed.last() {
        Some(&i) => {
            let t = item(all_bars[i].obj, "time")?;
            out.set_item("last_completed_at", &t)?;
            out.set_item("completed_bar_age_seconds", now - py_float(&t)?)?;
        }
        None => {
            out.set_item("last_completed_at", py.None())?;
            out.set_item("completed_bar_age_seconds", py.None())?;
        }
    }
    set_opt(&out, "last_close", closes.last().copied())?;
    {
        let (h, l, c) = fast::hlc(&all_bars, &completed)?;
        set_opt(&out, "atr_1m", if completed.len() < 2 { None } else { atr_from(&h, &l, &c, 14) })?;
    }
    set_opt(&out, "ema9", ema(&closes, 9))?;
    set_opt(&out, "ema21", ema(&closes, 21))?;
    set_opt(&out, "vwap", if volume_sum != 0.0 { Some(vwap_numerator / volume_sum) } else { None })?;
    set_opt(&out, "median_volume", median_vol)?;
    set_opt(&out, "last_volume", latest_volume)?;
    set_opt(&out, "historical_rvol", historical_rvol)?;
    out.set_item("historical_samples", historical_samples)?;
    set_opt(&out, "rolling_rvol", rolling_rvol)?;

    set_opt(&out, "ema9_5m", ema(&five_closes, 9))?;
    set_opt(&out, "ema21_5m", ema(&five_closes, 21))?;
    match five.last() {
        Some(agg) => out.set_item("last_completed_5m_at", agg.time)?,
        None => out.set_item("last_completed_5m_at", py.None())?,
    }
    set_opt(&out, "last_close_5m", five_closes.last().copied())?;
    set_opt(&out, "ema9_15m", ema(&fifteen_closes, 9))?;
    set_opt(&out, "ema21_15m", ema(&fifteen_closes, 21))?;
    match fifteen.last() {
        Some(agg) => out.set_item("last_completed_15m_at", agg.time)?,
        None => out.set_item("last_completed_15m_at", py.None())?,
    }
    set_opt(&out, "last_close_15m", fifteen_closes.last().copied())?;
    set_opt(&out, "ema9_60m", ema(&hourly_closes, 9))?;
    set_opt(&out, "ema21_60m", ema(&hourly_closes, 21))?;
    set_opt(&out, "last_close_60m", hourly_closes.last().copied())?;
    {
        let highs: Vec<f64> = five.iter().map(|a| a.high).collect();
        let lows: Vec<f64> = five.iter().map(|a| a.low).collect();
        set_opt(&out, "atr_5m", if five.len() < 2 { None } else { atr_from(&highs, &lows, &five_closes, 14) })?;
        let start = five.len().saturating_sub(3);
        let recent_high = highs[start..].iter().copied().fold(None, |acc: Option<f64>, v| match acc {
            Some(m) if v <= m => Some(m),
            _ => Some(v),
        });
        let recent_low = lows[start..].iter().copied().fold(None, |acc: Option<f64>, v| match acc {
            Some(m) if v >= m => Some(m),
            _ => Some(v),
        });
        set_opt(&out, "recent_high_5m", recent_high)?;
        set_opt(&out, "recent_low_5m", recent_low)?;
    }
    Ok(out)
}

#[pymodule]
fn se_kernel(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    m.add_function(wrap_pyfunction!(session_bars, m)?)?;
    m.add_function(wrap_pyfunction!(completed_bars, m)?)?;
    m.add_function(wrap_pyfunction!(aggregate_bars, m)?)?;
    m.add_function(wrap_pyfunction!(time_of_day_rvol, m)?)?;
    m.add_function(wrap_pyfunction!(atr, m)?)?;
    m.add_function(wrap_pyfunction!(ema_py, m)?)?;
    m.add_function(wrap_pyfunction!(median_volume, m)?)?;
    m.add_function(wrap_pyfunction!(completed_vwap, m)?)?;
    m.add_function(wrap_pyfunction!(indicator_core, m)?)?;
    Ok(())
}

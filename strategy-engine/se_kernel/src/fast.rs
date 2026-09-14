//! Single-pass bar conversion for `indicator_core`.
//!
//! `calculate_indicators` walks the same ~2,300 bars a dozen times. Reading a
//! Python dict field costs far more than the arithmetic, so each bar is read
//! once into `BarF`. A field that is not a plain int/float is left as `None`
//! and resolved through the original object on demand ("slow path"), which is
//! how the Python reference's error and skip semantics are preserved exactly.

use pyo3::exceptions::{PyKeyError, PyOverflowError, PyTypeError, PyValueError};
use pyo3::intern;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyString};

use crate::et::{et_stamp, EtStamp};
use crate::util::{bucket_of, is_number, is_truthy, median, py_float};

#[derive(Clone, Copy)]
pub enum Vol {
    Missing,
    Int(f64),
    Float(f64),
    /// None, bool, str, huge int, ... — consult the object.
    Other,
}

pub struct BarF<'a, 'py> {
    pub obj: &'a Bound<'py, PyAny>,
    pub time: Option<f64>,
    pub open: Option<f64>,
    pub high: Option<f64>,
    pub low: Option<f64>,
    pub close: Option<f64>,
    pub volume: Vol,
}

/// Plain finite int/float (bool excluded) as f64; anything else → None.
fn fast_num(obj: &Bound<'_, PyAny>) -> Option<f64> {
    if let Ok(f) = obj.cast::<PyFloat>() {
        let v = f.value();
        return if v.is_finite() { Some(v) } else { None };
    }
    if obj.is_instance_of::<PyInt>() && !obj.is_instance_of::<PyBool>() {
        return obj.extract::<f64>().ok();
    }
    None
}

fn field<'py>(dict: &Bound<'py, PyDict>, key: &Bound<'py, PyString>) -> PyResult<Option<Bound<'py, PyAny>>> {
    dict.get_item(key)
}

pub fn convert<'a, 'py>(py: Python<'py>, bars: &'a [Bound<'py, PyAny>]) -> PyResult<Vec<BarF<'a, 'py>>> {
    let k_time = intern!(py, "time");
    let k_open = intern!(py, "open");
    let k_high = intern!(py, "high");
    let k_low = intern!(py, "low");
    let k_close = intern!(py, "close");
    let k_volume = intern!(py, "volume");
    let mut out = Vec::with_capacity(bars.len());
    for obj in bars {
        let Ok(dict) = obj.cast::<PyDict>() else {
            // not a dict: everything goes through the slow path
            out.push(BarF { obj, time: None, open: None, high: None, low: None, close: None, volume: Vol::Other });
            continue;
        };
        let num = |key: &Bound<'py, PyString>| -> PyResult<Option<f64>> { Ok(field(dict, key)?.as_ref().and_then(fast_num)) };
        let volume = match field(dict, k_volume)? {
            None => Vol::Missing,
            Some(v) => {
                if let Ok(f) = v.cast::<PyFloat>() {
                    let x = f.value();
                    if x.is_finite() { Vol::Float(x) } else { Vol::Other }
                } else if v.is_instance_of::<PyInt>() && !v.is_instance_of::<PyBool>() {
                    match v.extract::<f64>() {
                        Ok(x) => Vol::Int(x),
                        Err(_) => Vol::Other,
                    }
                } else {
                    Vol::Other
                }
            }
        };
        out.push(BarF {
            obj,
            time: num(k_time)?,
            open: num(k_open)?,
            high: num(k_high)?,
            low: num(k_low)?,
            close: num(k_close)?,
            volume,
        });
    }
    Ok(out)
}

// ---- slow-path helpers (exact Python semantics on the original object) ----

fn item<'py>(bar: &Bound<'py, PyAny>, key: &str) -> PyResult<Bound<'py, PyAny>> {
    bar.get_item(key)
}

fn dget<'py>(bar: &Bound<'py, PyAny>, key: &str) -> PyResult<Option<Bound<'py, PyAny>>> {
    if let Ok(dict) = bar.cast::<PyDict>() {
        return dict.get_item(key);
    }
    let value = bar.call_method1("get", (key,))?;
    Ok(if value.is_none() { None } else { Some(value) })
}

/// `float(bar[key])`
fn f_item(bar: &BarF<'_, '_>, fast: Option<f64>, key: &str) -> PyResult<f64> {
    match fast {
        Some(v) => Ok(v),
        None => py_float(&item(bar.obj, key)?),
    }
}

/// `float(bar.get("volume", 0) or 0)`
fn vol_or0(bar: &BarF<'_, '_>) -> PyResult<f64> {
    match bar.volume {
        Vol::Int(v) | Vol::Float(v) => Ok(v),
        Vol::Missing => Ok(0.0),
        Vol::Other => match dget(bar.obj, "volume")? {
            Some(v) if is_truthy(&v)? => py_float(&v),
            _ => Ok(0.0),
        },
    }
}

/// `float(bar.get("volume", 0))`
fn vol_default0(bar: &BarF<'_, '_>) -> PyResult<f64> {
    match bar.volume {
        Vol::Int(v) | Vol::Float(v) => Ok(v),
        Vol::Missing => Ok(0.0),
        Vol::Other => match dget(bar.obj, "volume")? {
            Some(v) => py_float(&v),
            None => Ok(0.0),
        },
    }
}

fn et_or_raise(ts: f64) -> PyResult<EtStamp> {
    if ts.is_nan() {
        return Err(PyValueError::new_err("cannot convert float NaN to integer"));
    }
    if ts.is_infinite() {
        return Err(PyOverflowError::new_err("cannot convert float infinity to integer"));
    }
    et_stamp(ts).ok_or_else(|| PyValueError::new_err("timestamp out of range for platform time_t"))
}

// ---- filters ----

/// `_session_bars`: returns indices into `bars`.
pub fn session_idx(bars: &[BarF<'_, '_>], now: f64) -> PyResult<Vec<usize>> {
    let today = et_or_raise(now)?;
    let mut out = Vec::with_capacity(bars.len());
    for (i, bar) in bars.iter().enumerate() {
        let ts = match bar.time {
            Some(v) => v,
            None => {
                // except (KeyError, TypeError, ValueError, OSError): continue
                let py = bar.obj.py();
                let stamp_obj = match item(bar.obj, "time") {
                    Ok(v) => v,
                    Err(err) if err.is_instance_of::<PyKeyError>(py) || err.is_instance_of::<PyTypeError>(py) => continue,
                    Err(err) => return Err(err),
                };
                match py_float(&stamp_obj) {
                    Ok(v) => v,
                    Err(err) if err.is_instance_of::<PyTypeError>(py) || err.is_instance_of::<PyValueError>(py) => continue,
                    Err(err) => return Err(err),
                }
            }
        };
        if ts.is_infinite() {
            return Err(PyOverflowError::new_err("cannot convert float infinity to integer"));
        }
        if let Some(stamp) = et_stamp(ts) {
            if stamp.ordinal == today.ordinal {
                out.push(i);
            }
        }
    }
    Ok(out)
}

/// `_completed_bars` over a subset (indices), returning indices.
pub fn completed_idx(bars: &[BarF<'_, '_>], subset: &[usize], now: f64) -> PyResult<Vec<usize>> {
    let minute_start = bucket_of(now, 60)? as f64;
    let mut out = Vec::with_capacity(subset.len());
    for &i in subset {
        let bar = &bars[i];
        let ts = match bar.time {
            Some(v) => v,
            None => match dget(bar.obj, "time")? {
                Some(v) => py_float(&v)?,
                None => 0.0,
            },
        };
        if ts < minute_start {
            out.push(i);
        }
    }
    Ok(out)
}

// ---- aggregate ----

pub struct AggF {
    pub time: i64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
}

pub fn aggregate(bars: &[BarF<'_, '_>], subset: &[usize], minutes: i64, now: f64) -> PyResult<Vec<AggF>> {
    let seconds = minutes * 60;
    let mut order: Vec<i64> = Vec::new();
    let mut groups: std::collections::HashMap<i64, Vec<usize>> = std::collections::HashMap::new();
    for &i in subset {
        let ts = f_item(&bars[i], bars[i].time, "time")?;
        let bucket = bucket_of(ts, seconds)?;
        groups
            .entry(bucket)
            .or_insert_with(|| {
                order.push(bucket);
                Vec::new()
            })
            .push(i);
    }
    order.sort_unstable();
    let current_bucket = bucket_of(now, seconds)?;
    let mut out = Vec::with_capacity(order.len());
    for bucket in order {
        let items = &groups[&bucket];
        // Python evaluates open, high, low, close, volume in this order and
        // raises on the first bad field; mirror that so error parity holds.
        let _open = f_item(&bars[items[0]], bars[items[0]].open, "open")?;
        let mut high = f_item(&bars[items[0]], bars[items[0]].high, "high")?;
        for &i in &items[1..] {
            let v = f_item(&bars[i], bars[i].high, "high")?;
            if v > high {
                high = v;
            }
        }
        let mut low = f_item(&bars[items[0]], bars[items[0]].low, "low")?;
        for &i in &items[1..] {
            let v = f_item(&bars[i], bars[i].low, "low")?;
            if v < low {
                low = v;
            }
        }
        let last = items[items.len() - 1];
        let close = f_item(&bars[last], bars[last].close, "close")?;
        // volume sum is only needed for its error behaviour here (unsupported types raise)
        for &i in items {
            if let Vol::Other = bars[i].volume {
                if let Some(v) = dget(bars[i].obj, "volume")? {
                    if is_truthy(&v)? && !v.is_instance_of::<PyFloat>() && !v.is_instance_of::<PyInt>() {
                        return Err(PyTypeError::new_err(format!(
                            "unsupported operand type(s) for +: 'int' and '{}'",
                            v.get_type().name()?
                        )));
                    }
                }
            }
        }
        if bucket < current_bucket {
            out.push(AggF { time: bucket, high, low, close });
        }
    }
    Ok(out)
}

// ---- scalar helpers over indices ----

pub fn time_of_day_rvol(
    bars: &[BarF<'_, '_>],
    latest: Option<usize>,
    all_completed: &[usize],
    minute_tolerance: i32,
) -> PyResult<(Option<f64>, usize)> {
    let latest = match latest {
        Some(i) if is_truthy(bars[i].obj)? => &bars[i],
        _ => return Ok((None, 0)),
    };
    let latest_time = match latest.time {
        Some(v) => v,
        None => match dget(latest.obj, "time")? {
            Some(v) if is_number(&v) => py_float(&v)?,
            _ => return Ok((None, 0)),
        },
    };
    let latest_stamp = et_or_raise(latest_time)?;
    let mut reference: Vec<f64> = Vec::new();
    for &i in all_completed {
        let bar = &bars[i];
        let (ts, volume) = match (bar.time, bar.volume) {
            (Some(t), Vol::Int(v) | Vol::Float(v)) => (t, v),
            _ => {
                let t = match dget(bar.obj, "time")? {
                    Some(v) if is_number(&v) => v,
                    _ => continue,
                };
                let vol = match dget(bar.obj, "volume")? {
                    Some(v) if is_number(&v) => v,
                    _ => continue,
                };
                (py_float(&t)?, py_float(&vol)?)
            }
        };
        let stamp = et_or_raise(ts)?;
        if stamp.ordinal != latest_stamp.ordinal
            && (stamp.minute_of_day - latest_stamp.minute_of_day).abs() <= minute_tolerance
            && volume > 0.0
        {
            reference.push(volume);
        }
    }
    let latest_volume = vol_or0(latest)?;
    let baseline = if reference.len() >= 10 { Some(median(&reference)) } else { None };
    let rvol = match baseline {
        Some(b) if latest_volume > 0.0 && b != 0.0 => Some(latest_volume / b),
        _ => None,
    };
    Ok((rvol, reference.len()))
}

pub fn median_volume(bars: &[BarF<'_, '_>], completed: &[usize], window: usize) -> PyResult<Option<f64>> {
    let start = completed.len().saturating_sub(window);
    let mut volumes: Vec<f64> = Vec::new();
    for &i in &completed[start..] {
        let bar = &bars[i];
        match bar.volume {
            Vol::Int(v) | Vol::Float(v) => {
                if v > 0.0 {
                    volumes.push(v);
                }
            }
            Vol::Missing => {} // 0 > 0 is False
            Vol::Other => {
                let py = bar.obj.py();
                let value = match dget(bar.obj, "volume")? {
                    Some(v) => v,
                    None => 0i64.into_pyobject(py)?.into_any(),
                };
                if value.gt(0i64)? {
                    volumes.push(py_float(&value)?);
                }
            }
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

/// `(highs, lows, closes)` via `float(bar[key])`.
pub fn hlc(bars: &[BarF<'_, '_>], subset: &[usize]) -> PyResult<(Vec<f64>, Vec<f64>, Vec<f64>)> {
    let mut highs = Vec::with_capacity(subset.len());
    let mut lows = Vec::with_capacity(subset.len());
    let mut closes = Vec::with_capacity(subset.len());
    for &i in subset {
        let bar = &bars[i];
        highs.push(f_item(bar, bar.high, "high")?);
        lows.push(f_item(bar, bar.low, "low")?);
        closes.push(f_item(bar, bar.close, "close")?);
    }
    Ok((highs, lows, closes))
}

pub fn closes(bars: &[BarF<'_, '_>], subset: &[usize]) -> PyResult<Vec<f64>> {
    let mut out = Vec::with_capacity(subset.len());
    for &i in subset {
        out.push(f_item(&bars[i], bars[i].close, "close")?);
    }
    Ok(out)
}

/// `(volume_sum, vwap_numerator)` over the session bars, Python order.
pub fn session_vwap_terms(bars: &[BarF<'_, '_>], session: &[usize]) -> PyResult<(f64, f64)> {
    let mut volume_sum = 0.0f64;
    for &i in session {
        volume_sum += vol_or0(&bars[i])?;
    }
    let mut numerator = 0.0f64;
    for &i in session {
        let bar = &bars[i];
        let h = f_item(bar, bar.high, "high")?;
        let l = f_item(bar, bar.low, "low")?;
        let c = f_item(bar, bar.close, "close")?;
        let v = vol_or0(bar)?;
        numerator += (h + l + c) / 3.0 * v;
    }
    Ok((volume_sum, numerator))
}

pub fn latest_volume(bars: &[BarF<'_, '_>], completed: &[usize]) -> PyResult<Option<f64>> {
    match completed.last() {
        Some(&i) => Ok(Some(vol_default0(&bars[i])?)),
        None => Ok(None),
    }
}

//! Python-semantics helpers. Every function here exists to make the Rust
//! result bit-identical to what CPython would produce for the same input.

use pyo3::exceptions::{PyOverflowError, PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyFloat, PyInt, PyString};

/// `signal_engine._number`: an int or float (not bool) that is finite.
pub fn is_number(obj: &Bound<'_, PyAny>) -> bool {
    if obj.is_instance_of::<PyBool>() {
        return false;
    }
    if obj.is_instance_of::<PyFloat>() {
        return obj
            .cast::<PyFloat>()
            .map(|f| f.value().is_finite())
            .unwrap_or(false);
    }
    obj.is_instance_of::<PyInt>()
}

/// Python `float(obj)`: floats and ints (bool included) convert directly;
/// anything else goes through the real builtin so string parsing and error
/// types (TypeError / ValueError / OverflowError) match exactly.
pub fn py_float(obj: &Bound<'_, PyAny>) -> PyResult<f64> {
    if let Ok(f) = obj.cast::<PyFloat>() {
        return Ok(f.value());
    }
    if obj.is_instance_of::<PyInt>() {
        // Python raises OverflowError for ints beyond f64 range; extract does too.
        return obj.extract::<f64>().map_err(|_| {
            PyOverflowError::new_err("int too large to convert to float")
        });
    }
    if obj.is_instance_of::<PyString>() || obj.hasattr("__float__")? || obj.hasattr("__index__")? {
        let py = obj.py();
        let float_type = py.get_type::<PyFloat>();
        return float_type.call1((obj,))?.extract::<f64>();
    }
    Err(PyTypeError::new_err(format!(
        "float() argument must be a string or a real number, not '{}'",
        obj.get_type().name()?
    )))
}

/// Python truthiness for the `value or 0` idiom.
pub fn is_truthy(obj: &Bound<'_, PyAny>) -> PyResult<bool> {
    obj.is_truthy()
}

/// CPython `float_floor_div` (the `//` operator on floats).
pub fn py_floordiv(a: f64, b: f64) -> PyResult<f64> {
    if b == 0.0 {
        return Err(PyValueError::new_err("float floor division by zero"));
    }
    let m = a % b; // fmod
    let mut div = (a - m) / b;
    if m != 0.0 && ((b < 0.0) != (m < 0.0)) {
        div -= 1.0;
    }
    if div != 0.0 {
        let floordiv = div.floor();
        if div - floordiv > 0.5 {
            Ok(floordiv + 1.0)
        } else {
            Ok(floordiv)
        }
    } else {
        Ok(0.0f64.copysign(a / b))
    }
}

/// `int(x // seconds) * seconds` for a float `x` and int `seconds`.
pub fn bucket_of(x: f64, seconds: i64) -> PyResult<i64> {
    let q = py_floordiv(x, seconds as f64)?;
    if !q.is_finite() {
        return Err(PyOverflowError::new_err("cannot convert float infinity to integer"));
    }
    Ok((q as i64) * seconds)
}

/// `statistics.median` on a non-empty list of floats.
pub fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

/// Python `sum()` of floats: sequential left-to-right, starting from int 0.
pub fn py_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut acc = 0.0f64;
    for v in values {
        acc += v;
    }
    acc
}

/// `signal_engine._ema` without the trailing `round(..., 4)`.
pub fn ema(values: &[f64], period: i64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let alpha = 2.0 / ((period + 1) as f64);
    let one_minus = 1.0 - alpha;
    let mut result = values[0];
    for value in &values[1..] {
        result = value * alpha + result * one_minus;
    }
    Some(result)
}

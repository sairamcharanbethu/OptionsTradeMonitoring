//! `datetime.fromtimestamp(ts, ZoneInfo("America/New_York"))` equivalents.

use chrono::{DateTime, Datelike, TimeZone, Timelike};
use chrono_tz::America::New_York;
use chrono_tz::Tz;

/// Local Eastern-time components of a POSIX timestamp, or `None` where
/// CPython would raise (non-finite, or out of the platform range).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EtStamp {
    /// Days since the civil epoch, unique per local date.
    pub ordinal: i32,
    pub minute_of_day: i32,
}

pub fn et_stamp(ts: f64) -> Option<EtStamp> {
    if !ts.is_finite() {
        return None;
    }
    // CPython rounds the float to whole microseconds, half-to-even.
    let micros = (ts * 1e6).round_ties_even();
    if micros.abs() > 9.0e21 {
        return None;
    }
    let secs = (micros / 1e6).floor();
    let nanos = ((micros - secs * 1e6) * 1e3) as u32;
    let dt: DateTime<Tz> = New_York.timestamp_opt(secs as i64, nanos).single()?;
    Some(EtStamp {
        ordinal: dt.date_naive().num_days_from_ce(),
        minute_of_day: (dt.hour() * 60 + dt.minute()) as i32,
    })
}

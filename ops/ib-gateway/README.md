# IB Gateway supervision

IBKR is **market data only** for StrikePilot (orders go to Wealthsimple through
SnapTrade). When the gateway is down:

- the strategy engine produces no new signals (no entries), and
- the streaming exit monitor is blind, so exits fall back to the backend's
  60-second safety-net poller using SnapTrade quotes.

Nothing in the compose stack starts or restarts the gateway. It is a container
on the **host**, reached at `host.docker.internal:4001`. These files close that
gap.

## Install (on the Coolify host)

```bash
sudo install -m 0755 ops/ib-gateway/ibgw-supervise.sh /usr/local/bin/ibgw-supervise.sh
sudo tee /etc/default/ibgw-supervise >/dev/null <<'EOF'
IBGW_CONTAINER=ib-gateway          # docker ps --format '{{.Names}}' to confirm
IBGW_PORT=4001                     # 4002 for paper
IBGW_RESTART_WINDOW=23:30-00:15    # must match IBC AUTO_RESTART_TIME below and IBKR_RESTART_WINDOW_ET in Coolify
HEARTBEAT_HOST_URL=                # healthchecks.io ping URL for the "strikepilot-host" check (10 min grace)
EOF

# Either cron:
( crontab -l 2>/dev/null; echo '*/2 * * * * /usr/local/bin/ibgw-supervise.sh >> /var/log/ibgw-supervise.log 2>&1' ) | crontab -

# ...or systemd:
sudo install -m 0644 ops/ib-gateway/ibgw-supervise.service ops/ib-gateway/ibgw-supervise.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ibgw-supervise.timer
journalctl -u ibgw-supervise.service -n 20
```

## What it does

Every 2 minutes: TCP-probe the API port and read the container's Docker
health. After **3 consecutive failures outside the restart window** it runs
`docker restart` (max 2 per hour) and resets the counter. Every run pings the
host heartbeat (`/fail` while unhealthy), so a dead host or Docker daemon is
caught even though the backend's own heartbeat is also dead at that point.

State lives in `/var/tmp/ibgw-supervise/` (`fail_count`, `restarts.log`).

## The 2FA constraint (read before relying on auto-restart)

- A **live** account needs IB Key two-factor on every *full* re-login. A
  container restart that triggers a fresh login will sit at the 2FA prompt
  until someone taps the phone. The supervisor cannot fix that; it only
  recovers hangs and crashes where the session is still valid.
- Use the `gnzsnz/ib-gateway` image with IBC and set `AUTO_RESTART_TIME` (for
  example `11:45 PM`): the gateway restarts itself nightly **without**
  re-authenticating, and the session survives. Set `TWOFA_TIMEOUT_ACTION=restart`
  so a missed 2FA prompt retries instead of exiting.
- IBKR still forces a **weekly full re-login on Sunday**. That needs a human
  tap. The backend's health evaluator posts a Discord reminder ("IB weekly
  re-auth due") on Sunday at 16:00 ET so it is done before Monday's open.
- Paper accounts need no 2FA; auto-restart is fully hands-off there.

Keep the three windows aligned: `IBGW_RESTART_WINDOW` here, IBC's
`AUTO_RESTART_TIME` in the gateway container, and `IBKR_RESTART_WINDOW_ET` in
the backend (which mutes disconnect alerts inside it). Default `23:30-00:15` ET.

## Verify

```bash
docker stop ib-gateway        # simulate a crash
# within ~6 minutes: /var/log/ibgw-supervise.log shows "unhealthy #1..#3" then "restarting"
docker ps | grep ib-gateway   # running again
```

During market hours the backend will also page `engine_disconnected` /
`ibkr_stream` after 3 minutes; outside the restart window and after 30 minutes
off-hours it posts a warning.

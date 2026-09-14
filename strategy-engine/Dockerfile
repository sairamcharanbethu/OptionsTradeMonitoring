# Stage 1: build the se_kernel Rust extension as a manylinux abi3 wheel.
# ghcr.io/pyo3/maturin is multi-arch (amd64 + arm64) and bundles rustc +
# maturin, so the same Dockerfile builds on the arm64 dev Mac and the Linux
# Coolify host. Manifest files are copied first so the dependency compile is a
# cached layer that only changes when Cargo.toml / Cargo.lock change.
FROM ghcr.io/pyo3/maturin:v1.15.0 AS kernel
WORKDIR /src
COPY se_kernel/Cargo.toml se_kernel/Cargo.lock se_kernel/pyproject.toml ./
RUN mkdir -p src && echo "" > src/lib.rs \
    && (maturin build --release --out /wheels >/dev/null 2>&1 || true) \
    && rm -rf /wheels
COPY se_kernel/src ./src
# COPY keeps the checkout mtimes, which can be older than the placeholder
# lib.rs above; touch so cargo does not treat the warm-up build as fresh.
RUN touch src/*.rs && maturin build --release --out /wheels

# Stage 2: the runtime image (unchanged apart from installing the wheel).
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=kernel /wheels/*.whl /tmp/wheels/
RUN pip install --no-cache-dir /tmp/wheels/*.whl && rm -rf /tmp/wheels \
    && python3 -c "import se_kernel; print('se_kernel', se_kernel.__version__)"

COPY *.py ./
RUN mkdir -p /data/trade

CMD ["python3", "trade_prefetch_service.py", "--output-dir", "/data/trade"]

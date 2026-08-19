# IMPORTANT: this image MUST be built from the REPOSITORY ROOT as the build
# context, because it copies `strategy-engine/signal_engine.py`, which lives
# OUTSIDE this directory. Building with `lean-engine/` as the context fails with
# `"/strategy-engine/signal_engine.py": not found`.
#
#   Correct:   docker build -f lean-engine/Dockerfile -t lean-shadow .
#   Compose:   docker compose build lean-shadow      (context: . in compose)
#   WRONG:     docker build lean-engine/             # sibling COPY not in context
ARG LEAN_IMAGE=quantconnect/lean:latest
FROM ${LEAN_IMAGE}

USER root
# Paths are relative to the repo root (the required build context), not to this file.
COPY lean-engine/ /opt/lean-shadow/
COPY strategy-engine/signal_engine.py /opt/strategy-engine/signal_engine.py
# signal_engine imports the wall-reaction strategy (merged into Day Trading);
# ship it so `from signal_engine import build_signal` resolves inside the image.
COPY strategy-engine/gex_wall_evaluator.py /opt/strategy-engine/gex_wall_evaluator.py
RUN chmod +x /opt/lean-shadow/entrypoint.sh /opt/lean-shadow/entrypoint.py && mkdir -p /state

ENTRYPOINT ["/opt/lean-shadow/entrypoint.sh"]

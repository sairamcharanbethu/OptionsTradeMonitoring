ARG LEAN_IMAGE=quantconnect/lean:latest
FROM ${LEAN_IMAGE}

USER root
COPY lean-engine/ /opt/lean-shadow/
COPY strategy-engine/signal_engine.py /opt/strategy-engine/signal_engine.py
RUN chmod +x /opt/lean-shadow/entrypoint.sh /opt/lean-shadow/entrypoint.py && mkdir -p /state

ENTRYPOINT ["/opt/lean-shadow/entrypoint.sh"]

FROM eclipse-temurin:21-jre

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget && \
    mkdir -p /opt/thetadata /var/lib/thetadata && \
    wget -q https://download-latest.thetadata.us -O /opt/thetadata/ThetaTerminal.jar && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY start-terminal.sh /usr/local/bin/start-terminal
RUN chmod +x /usr/local/bin/start-terminal

WORKDIR /var/lib/thetadata

EXPOSE 25503 25520

CMD ["start-terminal"]

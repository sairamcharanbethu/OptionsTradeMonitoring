FROM eclipse-temurin:21-jre

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget && \
    mkdir -p /opt/thetadata /var/lib/thetadata /var/lib/thetadata/files /root/.theta /root/ThetaData/ThetaTerminal /root/.ThetaData/ThetaTerminal && \
    wget -q https://download-latest.thetadata.us -O /opt/thetadata/ThetaTerminal.jar && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY start-terminal.sh /usr/local/bin/start-terminal
RUN chmod +x /usr/local/bin/start-terminal

WORKDIR /var/lib/thetadata

EXPOSE 25510 25520 11000 10000

CMD ["start-terminal"]

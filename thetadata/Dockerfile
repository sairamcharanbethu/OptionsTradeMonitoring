FROM eclipse-temurin:17-jre

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget && \
    mkdir -p /opt/thetadata /var/lib/thetadata && \
    wget -q https://download-latest.thetadata.us -O /opt/thetadata/ThetaTerminal.jar && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /var/lib/thetadata

EXPOSE 25503 25520

CMD ["sh", "-c", "if [ -n \"${THETADATA_TERMINAL_ARGS:-}\" ]; then exec java ${THETADATA_JAVA_OPTS:-} -jar /opt/thetadata/ThetaTerminal.jar ${THETADATA_TERMINAL_ARGS}; elif [ -n \"${THETADATA_USERNAME:-}\" ] && [ -n \"${THETADATA_PASSWORD:-}\" ]; then exec java ${THETADATA_JAVA_OPTS:-} -jar /opt/thetadata/ThetaTerminal.jar \"${THETADATA_USERNAME}\" \"${THETADATA_PASSWORD}\"; elif [ -n \"${THETADATA_API_KEY:-}\" ]; then exec java ${THETADATA_JAVA_OPTS:-} -jar /opt/thetadata/ThetaTerminal.jar \"${THETADATA_API_KEY}\"; else exec java ${THETADATA_JAVA_OPTS:-} -jar /opt/thetadata/ThetaTerminal.jar; fi"]

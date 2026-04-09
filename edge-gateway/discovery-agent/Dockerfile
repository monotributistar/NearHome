# Edge Gateway Discovery Agent
# Runs on balenaOS Raspberry Pi to discover and monitor IP cameras

# Use balena's Raspberry Pi Python image
FROM balenalib/raspberrypi4-64:latest-python

# Set working directory
WORKDIR /app

# Install system dependencies for network scanning
RUN apt-get update && apt-get install -y \
    arp-scan \
    iproute2 \
    iputils-ping \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY src/ ./src/
COPY config.yaml .

# Create non-root user for security
RUN useradd -m -u 1000 -s /bin/bash appuser && \
    chown -R appuser:appuser /app
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Expose health check port
EXPOSE 8080

# Run discovery agent
CMD ["python", "-u", "src/discovery_agent.py"]
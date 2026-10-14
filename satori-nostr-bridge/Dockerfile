# Small by construction: no build step, no compiler, no chain node. The bridge
# is a poller that holds one key and talks to two services over the network.
FROM python:3.12-slim

# git, because satorilib is installed from its repository rather than PyPI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source edit does not re-resolve them.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
ENV PYTHONPATH=/app/src PYTHONUNBUFFERED=1

# The cursor lives here. Without a volume a restart replays every observation
# onto the relay: harmless (34601 is replaceable) but noisy and rude to the
# relay operator, and it makes a restart look like a data event to subscribers.
VOLUME ["/data"]
ENV STATE_PATH=/data/bridge.db

# Unprivileged: this process needs to read a URL, sign, and write one sqlite
# file. Nothing it does wants root.
RUN useradd --create-home --uid 1000 bridge && mkdir -p /data && chown bridge:bridge /data
USER bridge

CMD ["python", "-m", "bridge"]

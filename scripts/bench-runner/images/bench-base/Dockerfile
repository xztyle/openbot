# OpenBot bench base image: the default image for `benchctl run`. Built on the server
# (benchd.py build-images) and on every bench (the runner builds missing images by itself).
# Extra images must be built FROM this one so they keep the entrypoint (Xvfb, low priority).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget git git-lfs openssh-client gnupg xz-utils zip unzip file jq procps tini \
        build-essential pkg-config cmake ninja-build autoconf automake libtool gdb \
        python3 python3-pip python3-venv python3-dev \
        xvfb xauth x11-utils x11-xserver-utils xdotool imagemagick fonts-dejavu-core fonts-noto-core \
        mesa-utils mesa-vulkan-drivers vulkan-tools libvulkan1 libgl1 libgl1-mesa-dri libegl1 libgles2 \
        libglx-mesa0 libegl-mesa0 libgbm1 libasound2t64 libpulse0 \
    && rm -rf /var/lib/apt/lists/*

# Node.js LTS from the official tarball (checksum verified).
ARG NODE_VERSION=22.12.0
RUN set -eux; cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f node-v* SHASUMS256.txt; node --version; npm --version

# The uid jobs run as (the same on the server and on every bench).
RUN groupadd -g 10010 bench && useradd -u 10010 -g 10010 -d /tmp -M -s /bin/bash bench

COPY bench-entry /usr/local/bin/bench-entry
RUN chmod 755 /usr/local/bin/bench-entry
ENV HOME=/tmp npm_config_cache=/tmp/.npm PIP_CACHE_DIR=/tmp/.pip XDG_CACHE_HOME=/tmp/.cache
WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/bench-entry"]
CMD ["bash"]

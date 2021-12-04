FROM debian:buster-slim

ENV TON_GITHUB_REPO=https://github.com/tonlabs/ton-1.git
ENV TON_STABLE_GITHUB_COMMIT_ID=658c9c65e1122d523aff054855f406a3f3b334d5

RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    git \
    libz-dev \
    libssl-dev

RUN git clone --recurse-submodules $TON_GITHUB_REPO ton \
    && cd ton \
    && git checkout $TON_STABLE_GITHUB_COMMIT_ID \
    && mkdir build && cd build \
    && cmake .. -G "Ninja" -DCMAKE_BUILD_TYPE=Release -DPORTABLE=ON -DTON_ARCH:STRING=x86-64 \
    && ninja fift lite-client validator-engine-console generate-random-id

RUN git clone https://github.com/tonlabs/ton-labs-contracts.git

FROM rust:1.53.0-buster

ENV TON_LABS_NODE_TOOLS_GITHUB_REPO=https://github.com/tonlabs/ton-labs-node-tools.git
ENV TON_LABS_NODE_TOOLS_GITHUB_COMMIT_ID=master

RUN apt-get update && apt-get install -y clang \
    && git clone --recurse-submodules $TON_LABS_NODE_TOOLS_GITHUB_REPO \
    && cd ton-labs-node-tools \
    && git checkout $TON_LABS_NODE_TOOLS_GITHUB_COMMIT_ID \
    && cargo build --release --bin console --bin keygen

FROM node:buster-slim

EXPOSE 3000

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y \
    git \
    ca-certificates \
    zlib1g \
    libssl1.1

COPY --from=0 \
    /ton/build/crypto/fift \
    /ton/build/lite-client/lite-client \
    /ton/build/validator-engine-console/validator-engine-console \
    /ton/build/utils/generate-random-id \
    /usr/bin/
COPY --from=0 /ton/crypto/fift/lib ton/crypto/fift/lib
COPY --from=0 /ton/crypto/smartcont ton/crypto/smartcont
COPY --from=0 /ton-labs-contracts/solidity contracts/solidity

COPY --from=1 \
    /ton-labs-node-tools/target/release/console \
    /ton-labs-node-tools/target/release/keygen \
    /usr/bin/

# ADD https://raw.githubusercontent.com/.../Elector.abi.json contracts/solidity/elector/

COPY package.json package-lock.json ./
RUN npm install

COPY . .

CMD ["node", "./bin/www"]


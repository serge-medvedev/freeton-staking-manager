FROM debian:stretch-slim AS builder

ENV TON_GITHUB_REPO=https://github.com/tonlabs/ton-1.git
ENV TON_STABLE_GITHUB_COMMIT_ID=9186d482981d2a784bcbd3322cf0c09ea8184991

RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    git \
    libz-dev \
    libssl-dev

RUN git clone --recursive $TON_GITHUB_REPO ton \
    && cd ton \
    && git checkout $TON_STABLE_GITHUB_COMMIT_ID \
    && mkdir build && cd build \
    && cmake .. -G "Ninja" -DCMAKE_BUILD_TYPE=Release -DPORTABLE=ON \
    && ninja fift validator-engine-console

RUN git clone https://github.com/tonlabs/ton-labs-contracts.git

FROM node:current-slim

EXPOSE 3000

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    zlib1g \
    libssl1.1

COPY --from=builder \
    /ton/build/validator-engine-console/validator-engine-console \
    /ton/build/crypto/fift \
    /usr/bin/
COPY --from=builder /ton/crypto/fift/lib ton/crypto/fift/lib
COPY --from=builder /ton/crypto/smartcont ton/crypto/smartcont
COPY --from=builder /ton-labs-contracts/solidity contracts/solidity

COPY package.json package-lock.json ./
RUN npm install

COPY . .

CMD ["node", "./bin/www"]

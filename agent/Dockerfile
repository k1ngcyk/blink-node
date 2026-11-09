FROM rust:1.92-bookworm AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry cargo build --release --locked

FROM builder AS checks
RUN rustup component add rustfmt clippy
RUN --mount=type=cache,target=/usr/local/cargo/registry cargo fmt --check && cargo test --locked --offline && cargo clippy --all-targets --offline -- -D warnings

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iputils-ping procps && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --user-group --create-home --home-dir /var/lib/blink-agent --shell /bin/sh blink-agent
COPY --from=builder /src/target/release/blink-agent /usr/local/bin/blink-agent
USER blink-agent
ENTRYPOINT ["blink-agent"]

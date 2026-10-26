# Tauri 2 の Android ビルド環境（試作の検証用）
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip xz-utils git build-essential pkg-config file \
        openjdk-17-jdk-headless \
        libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev \
    && rm -rf /var/lib/apt/lists/*

# Node.js
ARG NODE_VERSION=22.12.0
RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
    | tar -xJ -C /usr/local --strip-components=1

# Rust
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && rustup target add aarch64-linux-android x86_64-linux-android

# Android SDK コマンドラインツール
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
    && curl -fsSL -o /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
    && unzip -q /tmp/clt.zip -d /tmp/clt && mv /tmp/clt/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
    && rm -rf /tmp/clt /tmp/clt.zip \
    && yes | sdkmanager --licenses > /dev/null

# Android 17（API 37）向けの SDK と NDK
ARG NDK_VERSION=30.0.16248370
RUN sdkmanager --install "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" "ndk;${NDK_VERSION}" > /dev/null
ENV NDK_HOME=$ANDROID_HOME/ndk/${NDK_VERSION}

WORKDIR /work

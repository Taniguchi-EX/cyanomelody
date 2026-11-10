# Android 向けのビルド環境（試作用）：JDK 17・Android SDK と NDK・Rust（Android のターゲット）・Node.js
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip git build-essential pkg-config file python3 xz-utils \
      openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
# Rust と Android のターゲット
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
    && rustup target add aarch64-linux-android x86_64-linux-android armv7-linux-androideabi i686-linux-android
# Android SDK（コマンドラインツール）・プラットフォーム・ビルドツール・NDK
ENV ANDROID_HOME=/opt/android-sdk
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
    && curl -sSfo /tmp/ct.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip -q /tmp/ct.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest && rm /tmp/ct.zip
ENV PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
RUN yes | sdkmanager --licenses > /dev/null \
    && sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" "ndk;27.2.12479018" > /dev/null
ENV NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
WORKDIR /work

//! 出力先。再生エンジンは `AudioOutput` を通して音を出す。実際の出力先は cpal、テストでは偽物を使う。

use super::PlaybackError;

/// 出力先のバッファを埋める関数。引数は、チャンネルごとに交互に並べたバッファと、チャンネル数。
pub type RenderFn = Box<dyn FnMut(&mut [f32], usize) + Send>;

/// 開いた出力先の形式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputFormat {
    pub sample_rate: u32,
    pub channels: usize,
}

/// 出力先。開いている間、出力先の都合で `render` が呼ばれ続ける。
pub trait AudioOutput {
    fn open(&mut self, render: RenderFn) -> Result<OutputFormat, PlaybackError>;
    fn close(&mut self);
    fn is_open(&self) -> bool;
}

/// cpal で既定の出力先に音を出す（Windows は WASAPI、Ubuntu は ALSA、Android は AAudio）。
#[cfg(feature = "cpal-output")]
#[derive(Default)]
pub struct CpalOutput {
    stream: Option<cpal::Stream>,
}

#[cfg(feature = "cpal-output")]
impl AudioOutput for CpalOutput {
    fn open(&mut self, mut render: RenderFn) -> Result<OutputFormat, PlaybackError> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        self.close();
        let err = |e: &dyn std::fmt::Display| PlaybackError::Output(e.to_string());
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| PlaybackError::Output("出力先がない".into()))?;
        let config = device.default_output_config().map_err(|e| err(&e))?;
        let format = OutputFormat {
            sample_rate: config.sample_rate().0,
            channels: config.channels() as usize,
        };
        log::info!(
            "出力先を開く: {:?} / {:?} / {}Hz {}ch {:?}",
            host.id(),
            device.name().unwrap_or_default(),
            format.sample_rate,
            format.channels,
            config.sample_format()
        );
        let channels = format.channels;
        let on_error = |e: cpal::StreamError| log::error!("出力のエラー: {e}");
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_output_stream(
                &config.into(),
                move |data: &mut [f32], _| render(data, channels),
                on_error,
                None,
            ),
            // 16 ビット整数しか受け付けない出力先では、f32 で作ってから変換する
            cpal::SampleFormat::I16 => {
                let mut scratch = Vec::new();
                device.build_output_stream(
                    &config.into(),
                    move |data: &mut [i16], _| {
                        scratch.resize(data.len(), 0.0);
                        render(&mut scratch, channels);
                        for (d, s) in data.iter_mut().zip(&scratch) {
                            *d = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        }
                    },
                    on_error,
                    None,
                )
            }
            other => {
                return Err(PlaybackError::Output(format!(
                    "対応していない出力の形式: {other:?}"
                )));
            }
        }
        .map_err(|e| err(&e))?;
        stream.play().map_err(|e| err(&e))?;
        self.stream = Some(stream);
        Ok(format)
    }

    fn close(&mut self) {
        if self.stream.take().is_some() {
            log::info!("出力先を閉じた");
        }
    }

    fn is_open(&self) -> bool {
        self.stream.is_some()
    }
}

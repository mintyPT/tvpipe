//! Hand-rolled AAC-LC encoder, so PCM can reach Cast receivers without
//! ffmpeg.
//!
//! Scope: mono or stereo, 8-96 kHz, 1024-sample frames, sine windows,
//! block switching (long/start/eight-short/stop) driven by a simple
//! transient detector, M/S stereo per band, a simple masking estimate
//! (power-law noise shaping plus the absolute threshold of hearing), a
//! bisection rate loop and a bit reservoir. No TNS, pulse data or
//! intensity stereo.
//!
//! Clean room: written from ISO/IEC 13818-7:2004 (syntax clause 6,
//! noiseless coding clause 9, quantization 10, scalefactors 11, M/S 12.1,
//! filterbank 15; tables from Annex A and clause 8.9, transcribed by
//! `tests/vectors/aacenc/gen_tables.py`) and general MDCT literature.

mod bits;
pub(crate) mod encoder;
mod huffman;
mod mdct;
#[rustfmt::skip]
mod tables;
#[cfg(test)]
mod tests;

use crate::error::{Error, Result};

/// Samples per channel in one access unit.
pub const FRAME_LEN: usize = 1024;

/// The sampling frequencies of `sampling_frequency_index` 0..=11.
const RATES: [u32; 12] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
];

/// An AAC-LC encoder for interleaved 16-bit PCM.
pub struct Encoder {
    core: encoder::Core,
    sample_rate: u32,
    channels: u8,
    fs_index: u8,
}

impl Encoder {
    /// `channels` is 1 or 2; `bitrate_bps` is the long-term average target
    /// (at least 8 kbit/s per channel, at most what the decoder buffer
    /// allows: 6144 bits per channel and frame).
    pub fn new(sample_rate: u32, channels: u8, bitrate_bps: u32) -> Result<Encoder> {
        let fs_index = RATES
            .iter()
            .position(|&r| r == sample_rate)
            .ok_or_else(|| Error::unsupported(format!("aacenc: sample rate {sample_rate}")))?
            as u8;
        if !(1..=2).contains(&channels) {
            return Err(Error::unsupported(format!("aacenc: {channels} channels")));
        }
        let max = (6144u64 * sample_rate as u64 / FRAME_LEN as u64) * channels as u64;
        let min = 8000 * channels as u64;
        if (bitrate_bps as u64) < min || bitrate_bps as u64 > max {
            return Err(Error::unsupported(format!(
                "aacenc: bitrate {bitrate_bps} outside {min}..={max}"
            )));
        }
        Ok(Encoder {
            core: encoder::Core::new(
                fs_index as usize,
                sample_rate,
                channels as usize,
                bitrate_bps,
            ),
            sample_rate,
            channels,
            fs_index,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> u8 {
        self.channels
    }

    /// Encodes exactly [`FRAME_LEN`] samples per channel (interleaved) and
    /// returns one raw access unit (no ADTS header). Output lags input by
    /// [`Encoder::delay_samples`].
    pub fn encode(&mut self, pcm: &[i16]) -> Result<Vec<u8>> {
        let want = FRAME_LEN * self.channels as usize;
        if pcm.len() != want {
            return Err(Error::malformed(format!(
                "aacenc: got {} samples, want {want}",
                pcm.len()
            )));
        }
        Ok(self.core.encode(pcm))
    }

    /// Encodes silence to push the buffered input out: the access units
    /// that complete the stream after the last [`Encoder::encode`].
    pub fn flush(&mut self) -> Vec<Vec<u8>> {
        let zeros = vec![0i16; FRAME_LEN * self.channels as usize];
        (0..self.delay_samples() / FRAME_LEN)
            .map(|_| self.core.encode(&zeros))
            .collect()
    }

    /// Samples (per channel) between an input sample and the same sample
    /// in the decoder's output: one frame of MDCT overlap plus one frame
    /// of lookahead for block switching.
    pub fn delay_samples(&self) -> usize {
        2 * FRAME_LEN
    }

    /// The AudioSpecificConfig (ISO/IEC 14496-3 §1.6.2.1): object type 2
    /// (AAC LC), the frequency index, the channel configuration and an
    /// empty GASpecificConfig (1024-sample frames, no core coder, no
    /// extension).
    pub fn audio_specific_config(&self) -> Vec<u8> {
        let v: u16 = (2 << 11) | ((self.fs_index as u16) << 7) | ((self.channels as u16) << 3);
        v.to_be_bytes().to_vec()
    }

    /// Wraps one access unit in a 7-byte ADTS header (ISO/IEC 13818-7
    /// §6.2, no CRC), e.g. for feeding ffmpeg in tests.
    pub fn adts(&self, au: &[u8]) -> Vec<u8> {
        adts_header(self.fs_index, self.channels, au)
    }
}

fn adts_header(fs_index: u8, channels: u8, au: &[u8]) -> Vec<u8> {
    let len = (au.len() + 7).min(0x1fff) as u32;
    let mut w = bits::BitWriter::new();
    use bits::BitSink;
    w.put(0xfff, 12); // syncword
    w.put(0, 1); // ID: MPEG-4
    w.put(0, 2); // layer
    w.put(1, 1); // protection_absent
    w.put(1, 2); // profile: LC (object type - 1)
    w.put(fs_index as u32, 4);
    w.put(0, 1); // private_bit
    w.put(channels as u32, 3);
    w.put(0, 4); // original/copy, home, copyright id bit/start
    w.put(len, 13);
    w.put(0x7ff, 11); // buffer fullness: VBR
    w.put(0, 2); // one raw_data_block
    let mut out = w.finish();
    out.extend_from_slice(au);
    out
}

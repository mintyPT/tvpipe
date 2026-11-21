//! H.264 bitstream helpers: NAL unit iteration (AVCC and Annex B), the
//! `avcC` decoder configuration record, SPS parsing and IDR detection.
//!
//! Sources: ITU-T H.264 (08/2021) §7.3.1 (NAL unit syntax), §7.3.2.1.1
//! (SPS), §7.4.2.1.1 (cropping semantics, Table 6-1), Annex B (byte stream),
//! Annex E.1.1 (VUI); ISO/IEC 14496-15 §5.3.3.1 (AVCDecoderConfigurationRecord).

use crate::error::{Error, Result};
use crate::util::bytes::{Reader, Writer};
use crate::util::ratio::Ratio;

/// NAL unit types we care about (H.264 Table 7-1).
pub mod nal_type {
    pub const NON_IDR: u8 = 1;
    pub const IDR: u8 = 5;
    pub const SEI: u8 = 6;
    pub const SPS: u8 = 7;
    pub const PPS: u8 = 8;
    pub const AUD: u8 = 9;
    pub const SPS_EXT: u8 = 13;
}

/// The `nal_unit_type` of a NAL unit (its first byte's low 5 bits).
pub fn nal_unit_type(nal: &[u8]) -> Option<u8> {
    nal.first().map(|b| b & 0x1f)
}

/// Iterates the NAL units of an AVCC buffer (big-endian length prefixes of
/// `length_size` bytes). Yields an error once and then stops if a length
/// runs past the end.
pub struct AvccNals<'a> {
    r: Reader<'a>,
    length_size: usize,
    failed: bool,
}

impl<'a> Iterator for AvccNals<'a> {
    type Item = Result<&'a [u8]>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.r.is_at_end() {
            return None;
        }
        if !matches!(self.length_size, 1 | 2 | 4) {
            self.failed = true;
            return Some(Err(self.r.error("invalid NAL length size")));
        }
        let rv = self
            .r
            .uint_be(self.length_size)
            .and_then(|len| self.r.bytes(len as usize));
        if rv.is_err() {
            self.failed = true;
        }
        Some(rv)
    }
}

/// NAL units of an AVCC buffer. `length_size` must be 1, 2 or 4 (from the
/// `avcC` record); anything else yields an error.
pub fn avcc_nals(data: &[u8], length_size: usize) -> AvccNals<'_> {
    AvccNals {
        r: Reader::new(data, "h264 avcc"),
        length_size,
        failed: false,
    }
}

/// Iterates the NAL units of an Annex B byte stream (start codes
/// `00 00 01` or `00 00 00 01`). Bytes before the first start code are
/// skipped; trailing zero bytes of each NAL unit are dropped. Never fails.
pub struct AnnexBNals<'a> {
    data: &'a [u8],
    pos: usize,
}

/// Position just after the next start code at or after `from`.
fn find_start_code(data: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut i = from;
    while i + 3 <= data.len() {
        if data[i + 2] > 1 {
            i += 3;
        } else if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            return Some((i, i + 3));
        } else {
            i += 1;
        }
    }
    None
}

impl<'a> Iterator for AnnexBNals<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<&'a [u8]> {
        loop {
            if self.pos >= self.data.len() {
                return None;
            }
            let start = match find_start_code(self.data, self.pos) {
                Some((_, after)) if self.pos == 0 => after,
                _ if self.pos == 0 => {
                    self.pos = self.data.len();
                    return None;
                }
                _ => self.pos,
            };
            let end = match find_start_code(self.data, start) {
                Some((at, after)) => {
                    self.pos = after;
                    at
                }
                None => {
                    self.pos = self.data.len();
                    self.data.len()
                }
            };
            let mut nal = &self.data[start..end];
            while let [rest @ .., 0] = nal {
                nal = rest;
            }
            if !nal.is_empty() {
                return Some(nal);
            }
        }
    }
}

pub fn annexb_nals(data: &[u8]) -> AnnexBNals<'_> {
    AnnexBNals { data, pos: 0 }
}

/// Converts an Annex B access unit to AVCC with 4-byte lengths.
pub fn annexb_to_avcc(data: &[u8]) -> Vec<u8> {
    let mut w = Writer::with_capacity(data.len() + 16);
    for nal in annexb_nals(data) {
        w.u32_be(nal.len() as u32).bytes(nal);
    }
    w.into_vec()
}

/// Whether an AVCC access unit contains an IDR slice.
pub fn is_idr(data: &[u8], length_size: usize) -> Result<bool> {
    for nal in avcc_nals(data, length_size) {
        if nal_unit_type(nal?) == Some(nal_type::IDR) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Removes emulation prevention bytes (`00 00 03` → `00 00`), giving the
/// RBSP of a NAL unit (H.264 §7.4.1).
pub fn unescape_rbsp(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &b in nal {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

/// MSB-first bit reader with Exp-Golomb codes (H.264 §7.2, §9.1).
struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> BitReader<'a> {
        BitReader { data, bit: 0 }
    }

    fn eof() -> Error {
        Error::malformed("h264 sps: unexpected end of data")
    }

    fn u1(&mut self) -> Result<u32> {
        let byte = *self.data.get(self.bit / 8).ok_or_else(Self::eof)?;
        let v = (byte >> (7 - (self.bit % 8))) & 1;
        self.bit += 1;
        Ok(v as u32)
    }

    fn flag(&mut self) -> Result<bool> {
        Ok(self.u1()? == 1)
    }

    fn u(&mut self, n: u32) -> Result<u32> {
        debug_assert!(n <= 32);
        let mut v = 0u64;
        for _ in 0..n {
            v = (v << 1) | self.u1()? as u64;
        }
        Ok(v as u32)
    }

    /// ue(v). Values above `u32::MAX - 1` are rejected.
    fn ue(&mut self) -> Result<u32> {
        let mut zeros = 0;
        while self.u1()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return Err(Error::malformed("h264 sps: exp-golomb code too long"));
            }
        }
        let rest = self.u(zeros)? as u64;
        let v = (1u64 << zeros) - 1 + rest;
        u32::try_from(v).map_err(|_| Error::malformed("h264 sps: exp-golomb value too large"))
    }

    /// se(v).
    fn se(&mut self) -> Result<i32> {
        let k = self.ue()? as i64;
        let v = if k % 2 == 1 { (k + 1) / 2 } else { -(k / 2) };
        Ok(v as i32)
    }
}

/// The parts of a sequence parameter set we need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sps {
    pub profile_idc: u8,
    /// `constraint_set0_flag` .. `constraint_set5_flag` plus the two
    /// reserved bits, as the byte that follows `profile_idc`.
    pub constraint_flags: u8,
    pub level_idc: u8,
    pub sps_id: u32,
    /// 0 = monochrome, 1 = 4:2:0, 2 = 4:2:2, 3 = 4:4:4.
    pub chroma_format_idc: u32,
    pub separate_colour_plane: bool,
    pub bit_depth_luma: u32,
    pub bit_depth_chroma: u32,
    pub frame_mbs_only: bool,
    /// Display width after cropping.
    pub width: u32,
    /// Display height after cropping.
    pub height: u32,
    /// `time_scale / (2 * num_units_in_tick)` from the VUI, if present.
    pub fps: Option<Ratio>,
    /// VUI `max_num_reorder_frames` (frames that may precede another in
    /// decode order and follow it in output order: 0 means no B-frame
    /// reordering), when the SPS has `bitstream_restriction_flag`. `None`
    /// when absent or when the VUI tail does not parse.
    pub max_num_reorder_frames: Option<u32>,
    /// VUI `max_dec_frame_buffering`, under the same conditions.
    pub max_dec_frame_buffering: Option<u32>,
    /// VUI sample (pixel) aspect ratio, when `aspect_ratio_info_present_flag`
    /// is set with a known or extended (`255`) `aspect_ratio_idc` (Table
    /// E-1). `None`: unspecified, which receivers treat as square.
    pub sar: Option<(u32, u32)>,
    /// Bits of the RBSP (after the NAL header) before
    /// `vui_parameters_present_flag`: everything a decoder needs to read
    /// slices. See [`same_decoding`].
    pub bits_before_vui: usize,
}

impl Sps {
    /// Whether output order equals decode order, as far as the SPS says:
    /// `max_num_reorder_frames == 0`, or a profile without B-slices
    /// (Baseline / Constrained Baseline), or the inference of H.264
    /// E.2.1 for intra-only profiles (constraint_set3_flag). `None` when
    /// the SPS does not tell.
    pub fn no_reordering(&self) -> Option<bool> {
        if let Some(n) = self.max_num_reorder_frames {
            return Some(n == 0);
        }
        let set3 = self.constraint_flags & 0x10 != 0;
        if self.profile_idc == 66
            || (set3 && matches!(self.profile_idc, 44 | 86 | 100 | 110 | 122 | 244))
        {
            return Some(true);
        }
        None
    }
}

/// Profiles whose SPS carries chroma format / bit depth / scaling lists
/// (H.264 §7.3.2.1.1).
fn has_chroma_info(profile_idc: u8) -> bool {
    matches!(
        profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    )
}

fn skip_scaling_list(br: &mut BitReader<'_>, size: usize) -> Result<()> {
    let mut last = 8i32;
    let mut next = 8i32;
    for _ in 0..size {
        if next != 0 {
            let delta = br.se()?;
            if !(-128..=127).contains(&delta) {
                return Err(Error::malformed("h264 sps: delta_scale out of range"));
            }
            next = (last + delta + 256) % 256;
        }
        if next != 0 {
            last = next;
        }
    }
    Ok(())
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// Parses an SPS NAL unit (including its one-byte NAL header, with
/// emulation prevention bytes still in place).
pub fn parse_sps(nal: &[u8]) -> Result<Sps> {
    if nal_unit_type(nal) != Some(nal_type::SPS) {
        return Err(Error::malformed("h264 sps: not an SPS NAL unit"));
    }
    let rbsp = unescape_rbsp(&nal[1..]);
    let mut br = BitReader::new(&rbsp);
    let profile_idc = br.u(8)? as u8;
    let constraint_flags = br.u(8)? as u8;
    let level_idc = br.u(8)? as u8;
    let sps_id = br.ue()?;
    if sps_id > 31 {
        return Err(Error::malformed(
            "h264 sps: seq_parameter_set_id out of range",
        ));
    }
    let mut chroma_format_idc = 1;
    let mut separate_colour_plane = false;
    let mut bit_depth_luma = 8;
    let mut bit_depth_chroma = 8;
    if has_chroma_info(profile_idc) {
        chroma_format_idc = br.ue()?;
        if chroma_format_idc > 3 {
            return Err(Error::malformed("h264 sps: chroma_format_idc out of range"));
        }
        if chroma_format_idc == 3 {
            separate_colour_plane = br.flag()?;
        }
        bit_depth_luma = br.ue()?.saturating_add(8);
        bit_depth_chroma = br.ue()?.saturating_add(8);
        if bit_depth_luma > 14 || bit_depth_chroma > 14 {
            return Err(Error::malformed("h264 sps: bit depth out of range"));
        }
        let _qpprime_y_zero_transform_bypass = br.flag()?;
        if br.flag()? {
            let lists = if chroma_format_idc == 3 { 12 } else { 8 };
            for i in 0..lists {
                if br.flag()? {
                    skip_scaling_list(&mut br, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    let _log2_max_frame_num_minus4 = br.ue()?;
    match br.ue()? {
        0 => {
            let _log2_max_pic_order_cnt_lsb_minus4 = br.ue()?;
        }
        1 => {
            let _delta_pic_order_always_zero = br.flag()?;
            let _offset_for_non_ref_pic = br.se()?;
            let _offset_for_top_to_bottom_field = br.se()?;
            let n = br.ue()?;
            if n > 255 {
                return Err(Error::malformed(
                    "h264 sps: too many ref frames in poc cycle",
                ));
            }
            for _ in 0..n {
                br.se()?;
            }
        }
        2 => {}
        _ => {
            return Err(Error::malformed(
                "h264 sps: pic_order_cnt_type out of range",
            ))
        }
    }
    let _max_num_ref_frames = br.ue()?;
    let _gaps_in_frame_num_allowed = br.flag()?;
    let width_mbs = br.ue()? as u64 + 1;
    let height_map_units = br.ue()? as u64 + 1;
    let frame_mbs_only = br.flag()?;
    if !frame_mbs_only {
        let _mb_adaptive_frame_field = br.flag()?;
    }
    let _direct_8x8_inference = br.flag()?;
    let (mut crop_l, mut crop_r, mut crop_t, mut crop_b) = (0u64, 0u64, 0u64, 0u64);
    if br.flag()? {
        crop_l = br.ue()? as u64;
        crop_r = br.ue()? as u64;
        crop_t = br.ue()? as u64;
        crop_b = br.ue()? as u64;
    }
    let field_factor = if frame_mbs_only { 1 } else { 2 };
    // Table 6-1 and §7.4.2.1.1 (frame_crop_*_offset semantics).
    let chroma_array_type = if separate_colour_plane {
        0
    } else {
        chroma_format_idc
    };
    let (crop_x, crop_y) = match chroma_array_type {
        0 => (1, field_factor),
        1 => (2, 2 * field_factor),
        2 => (2, field_factor),
        _ => (1, field_factor),
    };
    let coded_w = width_mbs * 16;
    let coded_h = height_map_units * 16 * field_factor;
    let crop_w = (crop_l + crop_r) * crop_x;
    let crop_h = (crop_t + crop_b) * crop_y;
    if crop_w >= coded_w || crop_h >= coded_h {
        return Err(Error::malformed("h264 sps: cropping exceeds picture size"));
    }
    let width = u32::try_from(coded_w - crop_w)
        .map_err(|_| Error::malformed("h264 sps: width too large"))?;
    let height = u32::try_from(coded_h - crop_h)
        .map_err(|_| Error::malformed("h264 sps: height too large"))?;
    let mut sar = None;
    let bits_before_vui = br.bit;
    let (fps, restriction) = if br.flag()? {
        let fps = parse_vui_fps(&mut br, &mut sar)?;
        // The rest of the VUI only adds information; a stream whose tail
        // we cannot read keeps its size and rate.
        (fps.0, parse_vui_tail(&mut br, fps.1).ok().flatten())
    } else {
        (None, None)
    };
    Ok(Sps {
        profile_idc,
        constraint_flags,
        level_idc,
        sps_id,
        chroma_format_idc,
        separate_colour_plane,
        bit_depth_luma,
        bit_depth_chroma,
        frame_mbs_only,
        width,
        height,
        fps,
        max_num_reorder_frames: restriction.map(|r| r.0),
        max_dec_frame_buffering: restriction.map(|r| r.1),
        sar,
        bits_before_vui,
    })
}

/// Whether two SPS NAL units differ at most in their VUI (video
/// usability information: colour description, timing, buffering hints),
/// so slices coded against one decode with the other. Browsers' encoders
/// change the VUI between their first frames (Chrome's VideoToolbox
/// encoder on macOS switches the transfer characteristics from sRGB to
/// BT.709), and again after a page shares again.
pub fn same_decoding(a: &[u8], b: &[u8]) -> bool {
    let (Ok(sa), Ok(sb)) = (parse_sps(a), parse_sps(b)) else {
        return false;
    };
    let n = sa.bits_before_vui;
    if n != sb.bits_before_vui {
        return false;
    }
    let (ra, rb) = (unescape_rbsp(&a[1..]), unescape_rbsp(&b[1..]));
    let (Some(pa), Some(pb)) = (ra.get(..n / 8), rb.get(..n / 8)) else {
        return false;
    };
    let rest = n % 8;
    let mask = !(0xffu8 >> rest);
    let tail = |r: &[u8]| r.get(n / 8).map_or(0, |b| b & mask);
    pa == pb && (rest == 0 || tail(&ra) == tail(&rb))
}

/// `aspect_ratio_idc` 0..=16 (H.264 Table E-1); 0 is unspecified.
const SAR_TABLE: [Option<(u32, u32)>; 17] = [
    None,
    Some((1, 1)),
    Some((12, 11)),
    Some((10, 11)),
    Some((16, 11)),
    Some((40, 33)),
    Some((24, 11)),
    Some((20, 11)),
    Some((32, 11)),
    Some((80, 33)),
    Some((18, 11)),
    Some((15, 11)),
    Some((64, 33)),
    Some((160, 99)),
    Some((4, 3)),
    Some((3, 2)),
    Some((2, 1)),
];

/// Reads the VUI up to and including the timing info (H.264 E.1.1).
/// Returns the frame rate and whether the reader stands right after the
/// timing info (so [`parse_vui_tail`] can go on).
fn parse_vui_fps(
    br: &mut BitReader<'_>,
    sar: &mut Option<(u32, u32)>,
) -> Result<(Option<Ratio>, bool)> {
    if br.flag()? {
        // aspect_ratio_info_present_flag
        let idc = br.u(8)?;
        *sar = if idc == 255 {
            let w = br.u(16)?;
            let h = br.u(16)?;
            Some((w, h)).filter(|&(w, h)| w > 0 && h > 0)
        } else {
            SAR_TABLE.get(idc as usize).copied().flatten()
        };
    }
    if br.flag()? {
        // overscan_info_present_flag
        br.flag()?;
    }
    if br.flag()? {
        // video_signal_type_present_flag
        br.u(3)?;
        br.flag()?;
        if br.flag()? {
            br.u(24)?;
        }
    }
    if br.flag()? {
        // chroma_loc_info_present_flag
        br.ue()?;
        br.ue()?;
    }
    if !br.flag()? {
        return Ok((None, true));
    }
    let num_units_in_tick = br.u(32)? as u64;
    let time_scale = br.u(32)? as u64;
    // fixed_frame_rate_flag; a stream that ends right here keeps its rate.
    let at_tail = br.flag().is_ok();
    if num_units_in_tick == 0 || time_scale == 0 {
        return Ok((None, at_tail));
    }
    let den = 2 * num_units_in_tick;
    let g = gcd(time_scale, den);
    let (num, den) = (time_scale / g, den / g);
    Ok((
        match (u32::try_from(num), u32::try_from(den)) {
            (Ok(num), Ok(den)) => Some(Ratio::new(num, den)),
            _ => None,
        },
        at_tail,
    ))
}

/// Skips hrd_parameters() (H.264 E.1.2).
fn skip_hrd(br: &mut BitReader<'_>) -> Result<()> {
    let cpb_cnt = br.ue()? as u64 + 1;
    if cpb_cnt > 32 {
        return Err(Error::malformed("h264 sps: cpb_cnt_minus1 out of range"));
    }
    br.u(8)?; // bit_rate_scale, cpb_size_scale
    for _ in 0..cpb_cnt {
        br.ue()?;
        br.ue()?;
        br.flag()?;
    }
    br.u(20)?; // four 5-bit delay/offset lengths
    Ok(())
}

/// Reads the VUI after the timing info: `(max_num_reorder_frames,
/// max_dec_frame_buffering)` when bitstream_restriction_flag is set
/// (H.264 E.1.1).
fn parse_vui_tail(br: &mut BitReader<'_>, at_tail: bool) -> Result<Option<(u32, u32)>> {
    if !at_tail {
        return Ok(None);
    }
    let nal_hrd = br.flag()?;
    if nal_hrd {
        skip_hrd(br)?;
    }
    let vcl_hrd = br.flag()?;
    if vcl_hrd {
        skip_hrd(br)?;
    }
    if nal_hrd || vcl_hrd {
        br.flag()?; // low_delay_hrd_flag
    }
    br.flag()?; // pic_struct_present_flag
    if !br.flag()? {
        return Ok(None);
    }
    br.flag()?; // motion_vectors_over_pic_boundaries_flag
    for _ in 0..4 {
        br.ue()?; // max_bytes_per_pic_denom .. log2_max_mv_length_vertical
    }
    let reorder = br.ue()?;
    let buffering = br.ue()?;
    if reorder > 16 || buffering > 16 {
        return Err(Error::malformed(
            "h264 sps: bitstream_restriction out of range",
        ));
    }
    Ok(Some((reorder, buffering)))
}

/// The `avcC` record (AVCDecoderConfigurationRecord).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvcConfig {
    pub profile_idc: u8,
    pub profile_compatibility: u8,
    pub level_idc: u8,
    /// Length prefix size of the samples (1, 2 or 4).
    pub length_size: u8,
    pub sps: Vec<Vec<u8>>,
    pub pps: Vec<Vec<u8>>,
    /// High-profile extension: (chroma_format, bit_depth_luma_minus8,
    /// bit_depth_chroma_minus8, SPS extension NAL units).
    pub ext: Option<AvcConfigExt>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvcConfigExt {
    pub chroma_format: u8,
    pub bit_depth_luma_minus8: u8,
    pub bit_depth_chroma_minus8: u8,
    pub sps_ext: Vec<Vec<u8>>,
}

/// Whether the avcC extension fields are written for a profile. ISO/IEC
/// 14496-15 lists 100/110/122/144; ffmpeg also writes them for 244 and
/// every other non-baseline/main/extended profile, so we follow that to
/// produce byte-identical records.
fn avcc_has_ext(profile_idc: u8) -> bool {
    !matches!(profile_idc, 66 | 77 | 88)
}

impl AvcConfig {
    pub fn parse(data: &[u8]) -> Result<AvcConfig> {
        let mut r = Reader::new(data, "h264 avcC");
        if r.u8()? != 1 {
            return Err(r.error("unsupported configurationVersion"));
        }
        let profile_idc = r.u8()?;
        let profile_compatibility = r.u8()?;
        let level_idc = r.u8()?;
        let length_size = (r.u8()? & 0x03) + 1;
        if length_size == 3 {
            return Err(r.error("invalid lengthSizeMinusOne"));
        }
        let n_sps = r.u8()? & 0x1f;
        let mut sps = Vec::with_capacity(n_sps as usize);
        for _ in 0..n_sps {
            let len = r.u16_be()? as usize;
            sps.push(r.bytes(len)?.to_vec());
        }
        let n_pps = r.u8()?;
        let mut pps = Vec::with_capacity(n_pps as usize);
        for _ in 0..n_pps {
            let len = r.u16_be()? as usize;
            pps.push(r.bytes(len)?.to_vec());
        }
        // The extension is optional in practice even for high profiles.
        let mut ext = None;
        if avcc_has_ext(profile_idc) && r.remaining() >= 4 {
            let chroma_format = r.u8()? & 0x03;
            let bit_depth_luma_minus8 = r.u8()? & 0x07;
            let bit_depth_chroma_minus8 = r.u8()? & 0x07;
            let n = r.u8()?;
            let mut sps_ext = Vec::with_capacity(n as usize);
            for _ in 0..n {
                let len = r.u16_be()? as usize;
                sps_ext.push(r.bytes(len)?.to_vec());
            }
            ext = Some(AvcConfigExt {
                chroma_format,
                bit_depth_luma_minus8,
                bit_depth_chroma_minus8,
                sps_ext,
            });
        }
        Ok(AvcConfig {
            profile_idc,
            profile_compatibility,
            level_idc,
            length_size,
            sps,
            pps,
            ext,
        })
    }

    /// Undoes parameter sets whose NAL header byte is written twice
    /// (`67 67 42 c0 …`, `68 68 cb …`), as Firefox 160's avcC on Linux has
    /// them (tvpipe issue #6). An SPS shows it without doubt: its second
    /// byte is `profile_idc`, and a repeated SPS header (0x07, 0x27, 0x47,
    /// 0x67) is no profile. Only when every SPS has it are PPSs whose first
    /// two bytes are equal undone too (one byte alone could be a real PPS).
    /// Returns whether anything changed.
    pub fn undouble_headers(&mut self) -> bool {
        let doubled = |nal: &[u8]| nal.len() > 2 && nal[0] == nal[1];
        if self.sps.is_empty()
            || !self
                .sps
                .iter()
                .all(|s| nal_unit_type(s) == Some(nal_type::SPS) && doubled(s))
        {
            return false;
        }
        for nal in self.sps.iter_mut().chain(self.pps.iter_mut()) {
            if doubled(nal) {
                nal.remove(0);
            }
        }
        true
    }

    /// Builds a record from parameter sets (4-byte lengths). Profile, level
    /// and extension fields come from the first SPS.
    pub fn from_parameter_sets(sps: Vec<Vec<u8>>, pps: Vec<Vec<u8>>) -> Result<AvcConfig> {
        let first = sps
            .first()
            .ok_or_else(|| Error::malformed("h264 avcC: no SPS"))?;
        if pps.is_empty() {
            return Err(Error::malformed("h264 avcC: no PPS"));
        }
        let parsed = parse_sps(first)?;
        let ext = avcc_has_ext(parsed.profile_idc).then(|| AvcConfigExt {
            chroma_format: parsed.chroma_format_idc as u8,
            bit_depth_luma_minus8: (parsed.bit_depth_luma - 8) as u8,
            bit_depth_chroma_minus8: (parsed.bit_depth_chroma - 8) as u8,
            sps_ext: Vec::new(),
        });
        Ok(AvcConfig {
            profile_idc: parsed.profile_idc,
            profile_compatibility: parsed.constraint_flags,
            level_idc: parsed.level_idc,
            length_size: 4,
            sps,
            pps,
            ext,
        })
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let too_many = || Error::malformed("h264 avcC: too many parameter sets");
        let mut w = Writer::new();
        w.u8(1)
            .u8(self.profile_idc)
            .u8(self.profile_compatibility)
            .u8(self.level_idc)
            .u8(0xfc | (self.length_size.wrapping_sub(1) & 0x03));
        if self.sps.len() > 31 || self.pps.len() > 255 {
            return Err(too_many());
        }
        w.u8(0xe0 | self.sps.len() as u8);
        for nal in &self.sps {
            put_ps(&mut w, nal)?;
        }
        w.u8(self.pps.len() as u8);
        for nal in &self.pps {
            put_ps(&mut w, nal)?;
        }
        if let Some(ext) = &self.ext {
            if ext.sps_ext.len() > 255 {
                return Err(too_many());
            }
            w.u8(0xfc | (ext.chroma_format & 0x03))
                .u8(0xf8 | (ext.bit_depth_luma_minus8 & 0x07))
                .u8(0xf8 | (ext.bit_depth_chroma_minus8 & 0x07))
                .u8(ext.sps_ext.len() as u8);
            for nal in &ext.sps_ext {
                put_ps(&mut w, nal)?;
            }
        }
        Ok(w.into_vec())
    }
}

fn put_ps(w: &mut Writer, nal: &[u8]) -> Result<()> {
    let len = u16::try_from(nal.len())
        .map_err(|_| Error::malformed("h264 avcC: parameter set too long"))?;
    w.u16_be(len).bytes(nal);
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn sps_vui_changes_keep_decoding() {
        // Chrome 157 (VideoToolbox) 1280x720 Constrained Baseline: the
        // first keyframe's SPS says sRGB transfer, later ones BT.709.
        let first = crate::util::hex::decode("2742001f898a300a00b74d40434041e10084d0").unwrap();
        let later = crate::util::hex::decode("2742001f898a300a00b74d40404041e10084d0").unwrap();
        let (a, b) = (parse_sps(&first).unwrap(), parse_sps(&later).unwrap());
        assert_eq!((a.width, a.height), (1280, 720));
        assert_eq!(a.bits_before_vui, b.bits_before_vui);
        assert!(same_decoding(&first, &later));
        assert!(same_decoding(&later, &first));
        // Another size (the built-in encoder's 64x48) is not.
        let enc = crate::media::h264enc::Encoder::new(crate::media::h264enc::Config {
            width: 64,
            height: 48,
            ..crate::media::h264enc::Config::default()
        })
        .unwrap();
        let other = AvcConfig::parse(&enc.avcc()).unwrap().sps[0].clone();
        assert!(!same_decoding(&first, &other));
        // A changed field before the VUI (level_idc).
        let mut level = first.clone();
        level[3] = 0x20;
        assert!(!same_decoding(&first, &level));
        assert!(!same_decoding(&first, &[0x68, 0xce, 0x3c, 0x80]));
        assert!(!same_decoding(&first, &first[..6]));
    }
    use crate::util::vectors;

    /// Firefox 160 on Linux (tvpipe issue #6): the avcC's SPS and PPS
    /// carry their NAL header twice.
    pub(crate) const FIREFOX_DOUBLED_AVCC: &str =
        "0142c02803010019676742c028d900780227e5840000030004007a12003c60c9200100056868cb8cb2";

    #[test]
    fn avcc_doubled_headers() {
        let data = crate::util::hex::decode(FIREFOX_DOUBLED_AVCC).unwrap();
        let mut cfg = AvcConfig::parse(&data).unwrap();
        let e = parse_sps(&cfg.sps[0]).unwrap_err();
        assert!(e.to_string().contains("cropping exceeds"), "{e}");
        assert!(cfg.undouble_headers());
        assert_eq!(
            crate::util::hex::encode(&cfg.sps[0]),
            "6742c028d900780227e5840000030004007a12003c60c920"
        );
        assert_eq!(crate::util::hex::encode(&cfg.pps[0]), "68cb8cb2");
        let sps = parse_sps(&cfg.sps[0]).unwrap();
        assert_eq!((sps.profile_idc, sps.level_idc), (66, 40));
        assert_eq!((sps.width, sps.height), (1920, 1080));
        // Written back as a well-formed record, and done once only.
        let fixed = AvcConfig::parse(&cfg.to_bytes().unwrap()).unwrap();
        assert_eq!(fixed, cfg);
        assert!(!cfg.undouble_headers());

        // A PPS that starts with its header's value is left alone when the
        // SPS is fine (Chrome's 1280x720 SPS, a made-up PPS).
        let sps = crate::util::hex::decode("2742001f898a300a00b74d40434041e10084d0").unwrap();
        let mut cfg =
            AvcConfig::from_parameter_sets(vec![sps], vec![vec![0x68, 0x68, 0xce]]).unwrap();
        let before = cfg.clone();
        assert!(!cfg.undouble_headers());
        assert_eq!(cfg, before);
    }

    #[test]
    fn sps_vectors() {
        let blocks = vectors::load("h264/sps.txt");
        assert!(blocks.len() >= 8);
        for b in &blocks {
            let name = b.name();
            let sps = parse_sps(&b.hex("sps")).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(sps.profile_idc, b.parse::<u8>("profile_idc"), "{name}");
            assert_eq!(sps.level_idc, b.parse::<u8>("level_idc"), "{name}");
            assert_eq!(sps.width, b.parse::<u32>("width"), "{name}");
            assert_eq!(sps.height, b.parse::<u32>("height"), "{name}");
            if b.str("chroma_format_idc") != "-" {
                assert_eq!(sps.chroma_format_idc, b.parse::<u32>("chroma_format_idc"));
            }
            if b.str("bit_depth_luma_minus8") != "-" {
                assert_eq!(
                    sps.bit_depth_luma,
                    8 + b.parse::<u32>("bit_depth_luma_minus8")
                );
            }
            assert_eq!(sps.frame_mbs_only, b.str("frame_mbs_only_flag") == "1");
            assert_eq!(sps.frame_mbs_only, b.str("interlaced") == "0", "{name}");
            let fps = match (b.str("num_units_in_tick"), b.str("time_scale")) {
                ("-", _) | (_, "-") => None,
                (n, t) => {
                    let (n, t): (u64, u64) = (n.parse().unwrap(), t.parse().unwrap());
                    let g = gcd(t, 2 * n);
                    Some(Ratio::new((t / g) as u32, (2 * n / g) as u32))
                }
            };
            assert_eq!(sps.fps, fps, "{name}");
            // x264 signals the encoder's rate in the VUI.
            if fps.is_some() {
                assert_eq!(fps, Some(b.str("encoder_fps").parse().unwrap()), "{name}");
            }
        }
    }

    #[test]
    fn reorder_vectors() {
        let blocks = vectors::load("h264/reorder.txt");
        assert!(blocks.len() >= 5);
        for b in &blocks {
            let name = b.name();
            let sps = parse_sps(&b.hex("sps")).unwrap_or_else(|e| panic!("{name}: {e}"));
            let want = |k: &str| match b.str(k) {
                "-" => None,
                v => Some(v.parse::<u32>().unwrap()),
            };
            assert_eq!(
                sps.max_num_reorder_frames,
                want("max_num_reorder_frames"),
                "{name}"
            );
            assert_eq!(
                sps.max_dec_frame_buffering,
                want("max_dec_frame_buffering"),
                "{name}"
            );
            if let Some(n) = sps.max_num_reorder_frames {
                assert_eq!(sps.no_reordering(), Some(n == 0), "{name}");
            }
        }
        // Older vectors: all x264 without B-frame options but High
        // profiles reorder; baseline never does.
        for b in vectors::load("h264/sps.txt") {
            let sps = parse_sps(&b.hex("sps")).unwrap();
            if sps.profile_idc == 66 {
                assert_eq!(sps.no_reordering(), Some(true));
            }
        }
    }

    #[test]
    fn avcc_vectors() {
        for b in vectors::load("h264/sps.txt") {
            let name = b.name();
            let raw = b.hex("avcc");
            let cfg = AvcConfig::parse(&raw).unwrap_or_else(|e| panic!("{name}: {e}"));
            // The vectors strip trailing zero bytes (Annex B
            // trailing_zero_8bits); ffmpeg keeps them in avcC.
            assert_eq!(cfg.sps.len(), 1);
            assert_eq!(cfg.pps.len(), 1);
            assert!(cfg.sps[0].starts_with(&b.hex("sps")), "{name}");
            assert!(cfg.pps[0].starts_with(&b.hex("pps")), "{name}");
            assert_eq!(cfg.length_size, 4);
            assert_eq!(cfg.to_bytes().unwrap(), raw, "{name}: reserialize");
            let built = AvcConfig::from_parameter_sets(cfg.sps.clone(), cfg.pps.clone()).unwrap();
            assert_eq!(built.to_bytes().unwrap(), raw, "{name}: build");
        }
    }

    #[test]
    fn avcc_truncated_never_panics() {
        let raw = vectors::load("h264/sps.txt")[0].hex("avcc");
        for n in 0..raw.len() {
            let _ = AvcConfig::parse(&raw[..n]);
        }
        let sps = vectors::load("h264/sps.txt")[0].hex("sps");
        for n in 0..sps.len() {
            let _ = parse_sps(&sps[..n]);
        }
        // High profile without the optional extension still parses.
        let hi = vectors::load("h264/sps.txt")
            .into_iter()
            .find(|b| b.name() == "high1080")
            .unwrap()
            .hex("avcc");
        let cfg = AvcConfig::parse(&hi[..hi.len() - 4]).unwrap();
        assert!(cfg.ext.is_none());
    }

    #[test]
    fn annexb_iteration() {
        let data = [
            0xff, 0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 0, 1, 0x65, 0, 0, 3, 1, 0,
        ];
        let nals: Vec<&[u8]> = annexb_nals(&data).collect();
        assert_eq!(nals, [&[0x67, 1, 2][..], &[0x68, 3], &[0x65, 0, 0, 3, 1]]);
        let avcc = annexb_to_avcc(&data);
        assert_eq!(
            avcc,
            [0, 0, 0, 3, 0x67, 1, 2, 0, 0, 0, 2, 0x68, 3, 0, 0, 0, 5, 0x65, 0, 0, 3, 1]
        );
        assert!(is_idr(&avcc, 4).unwrap());
        assert_eq!(annexb_nals(&[1, 2, 3]).count(), 0);
        assert_eq!(annexb_nals(&[0, 0, 1]).count(), 0);
        assert_eq!(annexb_nals(&[]).count(), 0);
    }

    #[test]
    fn avcc_iteration_errors() {
        let ok = [0, 2, 0x41, 9, 0, 1, 0x65];
        let nals: Vec<_> = avcc_nals(&ok, 2).map(|n| n.unwrap()).collect();
        assert_eq!(nals, [&[0x41, 9][..], &[0x65]]);
        assert!(is_idr(&ok, 2).unwrap());
        assert!(!is_idr(&[0, 1, 0x41], 2).unwrap());
        let bad = [0, 0, 0, 9, 0x65];
        let mut it = avcc_nals(&bad, 4);
        assert!(it.next().unwrap().is_err());
        assert!(it.next().is_none());
        assert!(avcc_nals(&ok, 3).next().unwrap().is_err());
        assert!(is_idr(&bad, 4).is_err());
    }

    #[test]
    fn rbsp_unescape() {
        assert_eq!(
            unescape_rbsp(&[0, 0, 3, 1, 0, 0, 3, 0, 0, 3]),
            [0, 0, 1, 0, 0, 0, 0]
        );
    }

    /// MSB-first bit writer for synthetic SPS tests.
    struct Bits(Vec<bool>);

    impl Bits {
        fn u(&mut self, v: u64, n: u32) -> &mut Self {
            for i in (0..n).rev() {
                self.0.push((v >> i) & 1 == 1);
            }
            self
        }
        fn ue(&mut self, v: u64) -> &mut Self {
            let len = 64 - (v + 1).leading_zeros();
            self.u(0, len - 1).u(v + 1, len)
        }
        fn se(&mut self, v: i64) -> &mut Self {
            self.ue(if v > 0 {
                2 * v as u64 - 1
            } else {
                (-2 * v) as u64
            })
        }
        fn bytes(&self) -> Vec<u8> {
            let mut bits = self.0.clone();
            bits.push(true);
            while bits.len() % 8 != 0 {
                bits.push(false);
            }
            bits.chunks(8)
                .map(|c| c.iter().fold(0u8, |a, &b| (a << 1) | b as u8))
                .collect()
        }
    }

    #[test]
    fn synthetic_sps_with_scaling_lists_and_poc_type_1() {
        // High 4:4:4 with seq_scaling_matrix_present_flag, 12 lists (some
        // present, one ending early via nextScale == 0), POC type 1 and a
        // VUI with every optional block before timing.
        let mut b = Bits(Vec::new());
        b.u(0x67, 8).u(244, 8).u(0, 8).u(31, 8).ue(0);
        b.ue(3).u(0, 1).ue(2).ue(2).u(0, 1).u(1, 1);
        for i in 0..12 {
            let present = i % 3 != 1;
            b.u(present as u64, 1);
            if present {
                let size = if i < 6 { 16 } else { 64 };
                if i == 0 {
                    // nextScale becomes 0 at once: one delta only.
                    b.se(-8);
                } else {
                    for j in 0..size {
                        b.se(if j % 2 == 0 { 5 } else { -5 });
                    }
                }
            }
        }
        b.ue(0).ue(1).u(1, 1).se(-1).se(2).ue(2).se(3).se(-4);
        b.ue(4).u(0, 1).ue(119).ue(67).u(1, 1).u(1, 1);
        b.u(1, 1).ue(0).ue(0).ue(0).ue(4); // crop bottom 4 rows
        b.u(1, 1); // vui
        b.u(1, 1).u(255, 8).u(4, 16).u(3, 16);
        b.u(1, 1).u(1, 1);
        b.u(1, 1).u(5, 3).u(0, 1).u(1, 1).u(0x010101, 24);
        b.u(1, 1).ue(1).ue(1);
        b.u(1, 1).u(1001, 32).u(120000, 32).u(1, 1);
        let sps = parse_sps(&b.bytes()).unwrap();
        assert_eq!(sps.chroma_format_idc, 3);
        assert_eq!(sps.bit_depth_luma, 10);
        assert_eq!((sps.width, sps.height), (1920, 1084));
        assert_eq!(sps.fps, Some(Ratio::new(60000, 1001)));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_sps(&[]).is_err());
        assert!(parse_sps(&[0x68, 1, 2]).is_err());
        // All-zero payload: exp-golomb code too long.
        assert!(parse_sps(&[0x67, 100, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
        // Cropping larger than the picture.
        let mut b = Bits(Vec::new());
        b.u(0x67, 8).u(66, 8).u(0, 8).u(30, 8).ue(0);
        // log2_max_frame_num, poc type 2, refs, gaps, 1x1 MBs, frame_mbs_only,
        // direct_8x8, then crop_left 8 (16 pixels in 4:2:0).
        b.ue(0).ue(2).ue(1).u(0, 1).ue(0).ue(0).u(1, 1).u(1, 1);
        b.u(1, 1).ue(8).ue(0).ue(0).ue(0).u(0, 1);
        assert!(parse_sps(&b.bytes()).is_err());
        assert!(AvcConfig::parse(&[2, 0, 0, 0]).is_err());
        assert!(AvcConfig::from_parameter_sets(vec![], vec![]).is_err());
    }

    #[test]
    fn sample_aspect_ratio() {
        // x264 SPS of 160x120 with setsar=4/3 (Table E-1 idc 14), 1/1
        // (idc 1) and 33/20 (extended, idc 255); ffmpeg-generated.
        for (hex, sar) in [
            ("6764000bacd942847e5c3840000003004000000f03c50a6580", (4, 3)),
            ("6764000bacd942847e5c0440000003004000000f03c50a6580", (1, 1)),
            (
                "6764000bacd942847e5ffc0084005040000003004000000f03c50a6580",
                (33, 20),
            ),
        ] {
            let sps = parse_sps(&crate::util::hex::decode(hex).unwrap()).unwrap();
            assert_eq!((sps.width, sps.height), (160, 120));
            assert_eq!(sps.sar, Some(sar), "{hex}");
        }
    }
}

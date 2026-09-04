use anyhow::{Result, bail};
use las::{
    Color, PointData,
    point::ScanDirection,
    raw::point::{ScanAngle, Waveform},
};

use crate::Point;

/// Attribute columns stay in source order. Spatial records carry only an index
/// into this store, so LOD partitioning and spatial sorting never copy payloads.
#[derive(Debug)]
pub struct LasAttributes {
    pub intensity: Vec<u16>,
    pub return_number: Vec<u8>,
    pub number_of_returns: Vec<u8>,
    pub scan_direction_flag: Vec<bool>,
    pub edge_of_flight_line: Vec<bool>,
    pub classification: Vec<u8>,
    pub synthetic: Vec<bool>,
    pub key_point: Vec<bool>,
    pub withheld: Vec<bool>,
    pub overlap: Vec<bool>,
    pub scanner_channel: Vec<u8>,
    pub scan_angle: Vec<i16>,
    pub user_data: Vec<u8>,
    pub point_source_id: Vec<u16>,
    pub gps_time: Option<Vec<f64>>,
    pub color: Option<Vec<Color>>,
    pub nir: Option<Vec<u16>>,
    pub waveform: Option<Vec<Waveform>>,
    pub extra_bytes_per_point: usize,
    pub extra_bytes: Option<Vec<u8>>,
}

impl LasAttributes {
    pub fn extract(data: &PointData) -> Result<(Vec<Point>, Self)> {
        if data.len() > u32::MAX as usize {
            bail!(
                "more than {} points are not supported by the in-memory PoC",
                u32::MAX
            );
        }
        let format = *data.format();
        let len = data.len();
        let points = data
            .x_raw()
            .zip(data.y_raw())
            .zip(data.z_raw())
            .enumerate()
            .map(|(index, ((x, y), z))| Point {
                x,
                y,
                z,
                source_index: index as u32,
            })
            .collect();

        let extra_bytes_per_point = usize::from(format.extra_bytes);
        let mut scan_direction_flag = Vec::with_capacity(len);
        let mut edge_of_flight_line = Vec::with_capacity(len);
        let mut synthetic = Vec::with_capacity(len);
        let mut key_point = Vec::with_capacity(len);
        let mut withheld = Vec::with_capacity(len);
        let mut overlap = Vec::with_capacity(len);
        let mut scanner_channel = Vec::with_capacity(len);
        let mut scan_angle = Vec::with_capacity(len);
        let mut waveform = format.has_waveform.then(|| Vec::with_capacity(len));
        let mut extra_bytes =
            (extra_bytes_per_point > 0).then(|| Vec::with_capacity(len * extra_bytes_per_point));
        for point in data.points() {
            let point = point?;
            scan_direction_flag.push(point.scan_direction == ScanDirection::LeftToRight);
            edge_of_flight_line.push(point.is_edge_of_flight_line);
            synthetic.push(point.is_synthetic);
            key_point.push(point.is_key_point);
            withheld.push(point.is_withheld);
            overlap.push(point.is_overlap);
            scanner_channel.push(point.scanner_channel);
            if let Some(values) = &mut waveform {
                values.push(
                    point
                        .waveform
                        .expect("waveform point format must decode waveform"),
                );
            }
            if let Some(values) = &mut extra_bytes {
                values.extend_from_slice(&point.extra_bytes);
            }
            scan_angle.push(match point.into_raw(data.transforms())?.scan_angle {
                ScanAngle::Rank(value) => i16::from(value),
                ScanAngle::Scaled(value) => value,
            });
        }

        Ok((
            points,
            Self {
                intensity: data.intensity().collect(),
                return_number: data.return_number().collect(),
                number_of_returns: data.number_of_returns().collect(),
                scan_direction_flag,
                edge_of_flight_line,
                classification: data.classification().collect(),
                synthetic,
                key_point,
                withheld,
                overlap,
                scanner_channel,
                scan_angle,
                user_data: data.user_data().collect(),
                point_source_id: data.point_source_id().collect(),
                gps_time: data.gps_time().map(Iterator::collect),
                color: data.rgb().map(|values| {
                    values
                        .map(|(red, green, blue)| Color { red, green, blue })
                        .collect()
                }),
                nir: data.nir().map(Iterator::collect),
                waveform,
                extra_bytes_per_point,
                extra_bytes,
            },
        ))
    }

    pub fn len(&self) -> usize {
        self.intensity.len()
    }

    pub fn is_empty(&self) -> bool {
        self.intensity.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn defaults(len: usize) -> Self {
        Self {
            intensity: vec![0; len],
            return_number: vec![1; len],
            number_of_returns: vec![1; len],
            scan_direction_flag: vec![false; len],
            edge_of_flight_line: vec![false; len],
            classification: vec![0; len],
            synthetic: vec![false; len],
            key_point: vec![false; len],
            withheld: vec![false; len],
            overlap: vec![false; len],
            scanner_channel: vec![0; len],
            scan_angle: vec![0; len],
            user_data: vec![0; len],
            point_source_id: vec![0; len],
            gps_time: None,
            color: None,
            nir: None,
            waveform: None,
            extra_bytes_per_point: 0,
            extra_bytes: None,
        }
    }
}

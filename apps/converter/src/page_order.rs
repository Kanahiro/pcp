use anyhow::{Result, bail};

use crate::{attributes::LasAttributes, hierarchy::Level};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PageOrder {
    Spatial,
    Hilbert,
    Source,
    GpsTime,
}

impl PageOrder {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Spatial => "spatial",
            Self::Hilbert => "hilbert",
            Self::Source => "source",
            Self::GpsTime => "gps-time",
        }
    }
}

/// Reorders points without changing membership of any Row Group or data page.
/// This preserves every spatial pruning boundary while exposing acquisition-order
/// correlation to the column encoders.
pub fn reorder_pages(
    levels: &mut [Level],
    attributes: &LasAttributes,
    row_group_size: usize,
    page_row_count: usize,
    order: PageOrder,
) -> Result<()> {
    if levels
        .iter()
        .flat_map(|level| &level.points)
        .any(|point| point.source_index as usize >= attributes.len())
    {
        bail!("point source index is outside the attribute store");
    }
    let gps_time = match order {
        PageOrder::GpsTime => Some(attributes.gps_time.as_deref().ok_or_else(|| {
            anyhow::anyhow!("--page-order gps-time requires a LAS point format with GPS time")
        })?),
        _ => None,
    };

    for level in levels {
        for row_group in level.points.chunks_mut(row_group_size) {
            for page in row_group.chunks_mut(page_row_count) {
                match order {
                    PageOrder::Spatial => {}
                    PageOrder::Hilbert => sort_hilbert(page),
                    PageOrder::Source => {
                        page.sort_unstable_by_key(|point| point.source_index);
                    }
                    PageOrder::GpsTime => {
                        let times = gps_time.expect("GPS time was validated above");
                        page.sort_unstable_by(|left, right| {
                            let left_index = left.source_index as usize;
                            let right_index = right.source_index as usize;
                            if left_index >= times.len() || right_index >= times.len() {
                                return left.source_index.cmp(&right.source_index);
                            }
                            times[left_index]
                                .total_cmp(&times[right_index])
                                .then_with(|| left.source_index.cmp(&right.source_index))
                        });
                    }
                }
            }
        }
    }

    Ok(())
}

fn sort_hilbert(points: &mut [crate::Point]) {
    let min = [
        points.iter().map(|point| point.x).min().unwrap_or(0),
        points.iter().map(|point| point.y).min().unwrap_or(0),
        points.iter().map(|point| point.z).min().unwrap_or(0),
    ];
    let max_span = points
        .iter()
        .flat_map(|point| {
            [
                i64::from(point.x) - i64::from(min[0]),
                i64::from(point.y) - i64::from(min[1]),
                i64::from(point.z) - i64::from(min[2]),
            ]
        })
        .max()
        .unwrap_or(0) as u64;
    let source_bits = (u64::BITS - max_span.leading_zeros()).max(1);
    let bits = source_bits.min(21);
    let shift = source_bits.saturating_sub(bits);

    points.sort_unstable_by_key(|point| {
        let coordinates = [point.x, point.y, point.z];
        let coordinates = std::array::from_fn(|axis| {
            ((i64::from(coordinates[axis]) - i64::from(min[axis])) as u64 >> shift) as u32
        });
        (hilbert_index(coordinates, bits), point.source_index)
    });
}

// Skilling's axes-to-transpose transform followed by bit interleaving.
fn hilbert_index(mut axes: [u32; 3], bits: u32) -> u64 {
    let mut q = 1_u32 << (bits - 1);
    while q > 1 {
        let p = q - 1;
        for axis in 0..3 {
            if axes[axis] & q != 0 {
                axes[0] ^= p;
            } else {
                let exchange = (axes[0] ^ axes[axis]) & p;
                axes[0] ^= exchange;
                axes[axis] ^= exchange;
            }
        }
        q >>= 1;
    }
    axes[1] ^= axes[0];
    axes[2] ^= axes[1];
    let mut correction = 0;
    q = 1_u32 << (bits - 1);
    while q > 1 {
        if axes[2] & q != 0 {
            correction ^= q - 1;
        }
        q >>= 1;
    }
    for axis in &mut axes {
        *axis ^= correction;
    }

    let mut index = 0_u64;
    for bit in (0..bits).rev() {
        for axis in axes {
            index = (index << 1) | u64::from((axis >> bit) & 1);
        }
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Point, attributes::LasAttributes};

    fn fixture() -> Vec<Level> {
        vec![Level {
            resolution: 0,
            points: (0..16)
                .rev()
                .map(|source_index| Point {
                    x: source_index as i32,
                    y: 0,
                    z: 0,
                    source_index,
                })
                .collect(),
        }]
    }

    #[test]
    fn source_order_does_not_move_points_between_pages() {
        let mut levels = fixture();
        let before: Vec<Vec<_>> = levels[0]
            .points
            .chunks(4)
            .map(|page| page.iter().map(|point| point.source_index).collect())
            .collect();

        reorder_pages(
            &mut levels,
            &LasAttributes::defaults(16),
            8,
            4,
            PageOrder::Source,
        )
        .unwrap();

        for (page, original) in levels[0].points.chunks(4).zip(before) {
            let mut actual: Vec<_> = page.iter().map(|point| point.source_index).collect();
            let mut expected = original;
            actual.sort_unstable();
            expected.sort_unstable();
            assert_eq!(expected, actual);
            assert!(
                page.windows(2)
                    .all(|pair| pair[0].source_index < pair[1].source_index)
            );
        }
    }

    #[test]
    fn gps_order_requires_gps_time() {
        let mut levels = fixture();
        let error = reorder_pages(
            &mut levels,
            &LasAttributes::defaults(16),
            8,
            4,
            PageOrder::GpsTime,
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("requires a LAS point format with GPS time")
        );
    }

    #[test]
    fn hilbert_order_is_continuous_for_a_two_by_two_by_two_cube() {
        let mut coordinates: Vec<_> = (0..2)
            .flat_map(|x| (0..2).flat_map(move |y| (0..2).map(move |z| [x, y, z])))
            .collect();
        coordinates.sort_unstable_by_key(|coordinates| hilbert_index(*coordinates, 1));
        assert_eq!(8, coordinates.len());
        for pair in coordinates.windows(2) {
            let distance: u32 = (0..3)
                .map(|axis| pair[0][axis].abs_diff(pair[1][axis]))
                .sum();
            assert_eq!(1, distance);
        }
    }
}

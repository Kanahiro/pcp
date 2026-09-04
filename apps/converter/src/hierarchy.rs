use std::collections::HashSet;

use crate::{IntegerBounds, Point};

#[derive(Clone, Debug)]
pub struct Level {
    pub resolution: u8,
    pub points: Vec<Point>,
}

/// Number of levels in the complete quantized-grid ladder. The last level is
/// exact; preceding levels use `ratio^exponent` raw coordinate units per axis.
pub fn automatic_level_count(bounds: IntegerBounds, ratio: u32) -> u8 {
    assert!(ratio >= 2);
    let largest_span = [
        i64::from(bounds.max.x) - i64::from(bounds.min.x),
        i64::from(bounds.max.y) - i64::from(bounds.min.y),
        i64::from(bounds.max.z) - i64::from(bounds.min.z),
    ]
    .into_iter()
    .max()
    .unwrap_or(0) as u64;
    let mut exponent = 0_u8;
    let mut width = 1_u64;
    while width <= largest_span {
        width = width.saturating_mul(u64::from(ratio));
        exponent = exponent.saturating_add(1);
    }
    exponent.saturating_add(1)
}

/// Chooses the smallest ratio-power voxel whose occupied-cell count does not
/// exceed the desired L0 size. This avoids starting from a one-point root.
pub fn automatic_level_count_for_target(
    points: &[Point],
    bounds: IntegerBounds,
    ratio: u32,
    target_points: usize,
) -> u8 {
    assert!(target_points > 0);
    let maximum_levels = automatic_level_count(bounds, ratio);
    let mut lower_exponent = 0_u32;
    let mut upper_exponent = u32::from(maximum_levels - 1);
    while lower_exponent < upper_exponent {
        let exponent = (lower_exponent + upper_exponent) / 2;
        let voxel_width = voxel_width(ratio, exponent);
        if occupied_voxel_count(points, bounds.min, voxel_width, target_points) <= target_points {
            upper_exponent = exponent;
        } else {
            lower_exponent = exponent + 1;
        }
    }
    u8::try_from(lower_exponent.saturating_add(1)).unwrap_or(u8::MAX)
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct Voxel(i64, i64, i64);

/// Builds an additive hierarchy. Each rung selects one point per voxel from
/// points not selected by coarser rungs. The complete ladder is retained even
/// when intermediate levels are empty, making its exponent derivable from the
/// level count. The finest level absorbs every remaining point exactly.
pub fn build_levels(
    points: Vec<Point>,
    levels: u8,
    ratio: u32,
    bounds: IntegerBounds,
) -> Vec<Level> {
    assert!(levels > 0);
    assert!(ratio >= 2);

    let mut remaining: Vec<Option<Point>> = points.into_iter().map(Some).collect();
    let mut output = Vec::with_capacity(levels as usize);

    for resolution in 0..levels {
        let mut selected = Vec::new();

        if resolution + 1 == levels {
            selected.extend(remaining.iter_mut().filter_map(Option::take));
        } else {
            let exponent = u32::from(levels - 1 - resolution);
            let voxel_width = voxel_width(ratio, exponent);
            let mut occupied = HashSet::new();
            for slot in &mut remaining {
                let Some(point) = *slot else { continue };
                let voxel = voxel_for(point, bounds.min, voxel_width);
                if occupied.insert(voxel) {
                    selected.push(point);
                    *slot = None;
                }
            }
        }

        output.push(Level {
            resolution,
            points: selected,
        });
    }
    output
}

fn voxel_width(ratio: u32, exponent: u32) -> u64 {
    u64::from(ratio)
        .checked_pow(exponent)
        .unwrap_or(i64::MAX as u64)
        .min(i64::MAX as u64)
}

fn voxel_for(point: Point, origin: Point, width: u64) -> Voxel {
    let width = width as i64;
    Voxel(
        (i64::from(point.x) - i64::from(origin.x)) / width,
        (i64::from(point.y) - i64::from(origin.y)) / width,
        (i64::from(point.z) - i64::from(origin.z)) / width,
    )
}

fn occupied_voxel_count(
    points: &[Point],
    origin: Point,
    voxel_width: u64,
    stop_after: usize,
) -> usize {
    let mut occupied = HashSet::with_capacity(stop_after.saturating_add(1));
    for &point in points {
        occupied.insert(voxel_for(point, origin, voxel_width));
        if occupied.len() > stop_after {
            break;
        }
    }
    occupied.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigns_every_point_exactly_once() {
        let points: Vec<_> = (0..100)
            .map(|x| Point {
                x,
                y: x % 7,
                z: 0,
                source_index: x as u32,
            })
            .collect();
        let bounds = IntegerBounds::from_points(&points).unwrap();
        let levels = build_levels(points.clone(), 5, 2, bounds);
        assert_eq!(
            points.len(),
            levels.iter().map(|l| l.points.len()).sum::<usize>()
        );
        let unique: HashSet<_> = levels.iter().flat_map(|l| &l.points).copied().collect();
        assert_eq!(points.len(), unique.len());
    }

    #[test]
    fn coarse_level_has_one_point_per_voxel() {
        let points = vec![
            Point {
                x: 0,
                y: 0,
                z: 0,
                source_index: 0,
            },
            Point {
                x: 1,
                y: 1,
                z: 1,
                source_index: 1,
            },
            Point {
                x: 9,
                y: 0,
                z: 0,
                source_index: 2,
            },
        ];
        let bounds = IntegerBounds::from_points(&points).unwrap();
        let levels = build_levels(points, 2, 4, bounds);
        assert_eq!(2, levels[0].points.len());
        assert_eq!(1, levels[1].points.len());
    }

    #[test]
    fn derives_a_complete_ladder_from_quantized_bounds() {
        let points = vec![
            Point {
                x: 0,
                y: 0,
                z: 0,
                source_index: 0,
            },
            Point {
                x: 400_000,
                y: 1,
                z: 1,
                source_index: 1,
            },
        ];
        let bounds = IntegerBounds::from_points(&points).unwrap();
        assert_eq!(20, automatic_level_count(bounds, 2));
    }

    #[test]
    fn starts_the_automatic_ladder_near_the_l0_target() {
        let points: Vec<_> = (0..=100)
            .map(|x| Point {
                x,
                y: 0,
                z: 0,
                source_index: x as u32,
            })
            .collect();
        let bounds = IntegerBounds::from_points(&points).unwrap();
        let levels = automatic_level_count_for_target(&points, bounds, 2, 8);
        assert_eq!(5, levels);
        let hierarchy = build_levels(points, levels, 2, bounds);
        assert_eq!(7, hierarchy[0].points.len());
    }

    #[test]
    fn retains_empty_levels_to_keep_the_ladder_derivable() {
        let points = vec![
            Point {
                x: 0,
                y: 0,
                z: 0,
                source_index: 0,
            },
            Point {
                x: 100,
                y: 0,
                z: 0,
                source_index: 1,
            },
        ];
        let bounds = IntegerBounds::from_points(&points).unwrap();
        let levels = build_levels(points, 10, 2, bounds);
        assert_eq!(10, levels.len());
        assert_eq!(
            2,
            levels.iter().map(|level| level.points.len()).sum::<usize>()
        );
        assert!(levels.iter().skip(2).all(|level| level.points.is_empty()));
    }

    #[test]
    fn finest_level_absorbs_coincident_points_exactly() {
        let points = vec![
            Point {
                x: 0,
                y: 0,
                z: 0,
                source_index: 0,
            },
            Point {
                x: 0,
                y: 0,
                z: 0,
                source_index: 1,
            },
            Point {
                x: 1,
                y: 0,
                z: 0,
                source_index: 2,
            },
        ];
        let bounds = IntegerBounds::from_points(&points).unwrap();
        let levels = build_levels(points, 2, 2, bounds);

        assert_eq!(2, levels.len());
        assert_eq!(1, levels[0].points.len());
        assert_eq!(2, levels[1].points.len());
    }
}

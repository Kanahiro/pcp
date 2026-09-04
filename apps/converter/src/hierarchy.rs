use std::collections::HashSet;

use crate::{IntegerBounds, Point};

#[derive(Clone, Debug)]
pub struct Level {
    pub resolution: u8,
    pub points: Vec<Point>,
}

/// Chooses a power-of-two ladder whose coarsest cubic voxel covers the
/// dataset and whose finest possible edge is the requested quantization
/// precision. The exact level may be reached earlier when the source has no
/// points close enough to require the remaining rungs.
pub fn automatic_level_count(
    bounds: IntegerBounds,
    scales: [f64; 3],
    finest_voxel_size: f64,
) -> u8 {
    let spans = [
        (i64::from(bounds.max.x) - i64::from(bounds.min.x)) as f64 * scales[0],
        (i64::from(bounds.max.y) - i64::from(bounds.min.y)) as f64 * scales[1],
        (i64::from(bounds.max.z) - i64::from(bounds.min.z)) as f64 * scales[2],
    ];
    let largest_span = spans.into_iter().fold(0.0_f64, f64::max);
    let coarsest_exponent = if largest_span <= finest_voxel_size {
        0
    } else {
        (largest_span / finest_voxel_size).log2().ceil() as u32
    };
    u8::try_from(coarsest_exponent.saturating_add(1)).unwrap_or(u8::MAX)
}

/// Chooses the smallest power-of-two voxel whose occupied-cell count does not
/// exceed the desired L0 size. This avoids a one-point root while preserving
/// the half-edge geometric-error ladder used by SSE.
pub fn automatic_level_count_for_target(
    points: &[Point],
    bounds: IntegerBounds,
    scales: [f64; 3],
    finest_voxel_size: f64,
    target_points: usize,
) -> u8 {
    assert!(target_points > 0);
    let maximum_levels = automatic_level_count(bounds, scales, finest_voxel_size);
    let mut lower_exponent = 0_u32;
    let mut upper_exponent = u32::from(maximum_levels - 1);
    while lower_exponent < upper_exponent {
        let exponent = (lower_exponent + upper_exponent) / 2;
        let voxel_size = finest_voxel_size * 2_f64.powi(exponent as i32);
        if occupied_voxel_count(points, bounds.min, scales, voxel_size, target_points)
            <= target_points
        {
            upper_exponent = exponent;
        } else {
            lower_exponent = exponent + 1;
        }
    }
    u8::try_from(lower_exponent.saturating_add(1)).unwrap_or(u8::MAX)
}

pub fn coarsest_voxel_size(levels: u8, finest_voxel_size: f64) -> f64 {
    finest_voxel_size * 2_f64.powi(i32::from(levels - 1))
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct Voxel(i64, i64, i64);

/// Builds an additive hierarchy. Each rung selects one point per voxel from
/// points not selected by coarser rungs. Construction stops as soon as every
/// source point is represented; an explicit final rung absorbs any remaining
/// points so no point is duplicated or dropped.
pub fn build_levels(
    points: Vec<Point>,
    levels: u8,
    base_voxel_size: f64,
    scales: [f64; 3],
    bounds: IntegerBounds,
) -> Vec<Level> {
    assert!(levels > 0);
    assert!(base_voxel_size.is_finite() && base_voxel_size > 0.0);

    let mut remaining: Vec<Option<Point>> = points.into_iter().map(Some).collect();
    let mut remaining_count = remaining.len();
    let mut output = Vec::with_capacity(levels as usize);

    for resolution in 0..levels {
        let is_last = resolution + 1 == levels;
        let mut selected = Vec::new();

        if is_last {
            selected.extend(remaining.iter_mut().filter_map(Option::take));
            remaining_count = 0;
        } else {
            let exponent = u32::from(levels - 1 - resolution);
            let voxel_size = base_voxel_size * 2_f64.powi(exponent as i32);
            let mut occupied = HashSet::new();
            for slot in &mut remaining {
                let Some(point) = *slot else { continue };
                let voxel = voxel_for(point, bounds.min, scales, voxel_size);
                if occupied.insert(voxel) {
                    selected.push(point);
                    *slot = None;
                    remaining_count -= 1;
                }
            }
        }

        output.push(Level {
            resolution,
            points: selected,
        });
        if remaining_count == 0 {
            break;
        }
    }
    output
}

fn voxel_for(point: Point, origin: Point, scales: [f64; 3], size: f64) -> Voxel {
    // Origin-relative coordinates avoid precision loss from large geospatial offsets.
    Voxel(
        ((f64::from(point.x) - f64::from(origin.x)) * scales[0] / size).floor() as i64,
        ((f64::from(point.y) - f64::from(origin.y)) * scales[1] / size).floor() as i64,
        ((f64::from(point.z) - f64::from(origin.z)) * scales[2] / size).floor() as i64,
    )
}

fn occupied_voxel_count(
    points: &[Point],
    origin: Point,
    scales: [f64; 3],
    voxel_size: f64,
    stop_after: usize,
) -> usize {
    let mut occupied = HashSet::with_capacity(stop_after.saturating_add(1));
    for &point in points {
        occupied.insert(voxel_for(point, origin, scales, voxel_size));
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
        let levels = build_levels(points.clone(), 5, 1.0, [1.0; 3], bounds);
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
        let levels = build_levels(points, 2, 4.0, [1.0; 3], bounds);
        assert_eq!(2, levels[0].points.len());
        assert_eq!(1, levels[1].points.len());
    }

    #[test]
    fn derives_a_ladder_from_scale_and_bounds() {
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
        assert_eq!(20, automatic_level_count(bounds, [0.001; 3], 0.001));
        assert_eq!(524.288, coarsest_voxel_size(20, 0.001));
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
        let levels = automatic_level_count_for_target(&points, bounds, [1.0; 3], 1.0, 8);
        assert_eq!(5, levels);
        let hierarchy = build_levels(points, levels, 1.0, [1.0; 3], bounds);
        assert_eq!(7, hierarchy[0].points.len());
    }

    #[test]
    fn stops_when_the_hierarchy_is_already_exact() {
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
        let levels = build_levels(points, 10, 1.0, [1.0; 3], bounds);
        assert!(levels.len() < 10);
        assert_eq!(
            2,
            levels.iter().map(|level| level.points.len()).sum::<usize>()
        );
        assert!(levels.iter().all(|level| !level.points.is_empty()));
    }
}

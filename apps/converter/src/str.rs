use crate::{Point, hierarchy::Level};

/// Packs every resolution independently into spatially compact, fixed-capacity
/// leaves. Chunking the resulting arrays at `row_group_size` yields the STR
/// leaves directly; no Row Group can cross a resolution boundary.
pub fn pack_levels(levels: &mut [Level], row_group_size: usize) {
    assert!(row_group_size > 0);
    for level in levels {
        pack(&mut level.points, row_group_size);
    }
}

fn pack(points: &mut [Point], leaf_capacity: usize) {
    if points.is_empty() {
        return;
    }

    let leaf_count = points.len().div_ceil(leaf_capacity);
    let x_slices = ceil_cube_root(leaf_count);
    points.sort_unstable_by_key(|point| (point.x, point.y, point.z, point.source_index));

    let mut x_offset = 0;
    for x_slice in 0..x_slices {
        let leaves = partition_size(leaf_count, x_slices, x_slice);
        let point_count = (leaves * leaf_capacity).min(points.len() - x_offset);
        let slab = &mut points[x_offset..x_offset + point_count];
        pack_yz(slab, leaves, leaf_capacity);
        x_offset += point_count;
    }
}

fn pack_yz(points: &mut [Point], leaf_count: usize, leaf_capacity: usize) {
    let y_slices = ceil_square_root(leaf_count);
    points.sort_unstable_by_key(|point| (point.y, point.x, point.z, point.source_index));

    let mut y_offset = 0;
    for y_slice in 0..y_slices {
        let leaves = partition_size(leaf_count, y_slices, y_slice);
        let point_count = (leaves * leaf_capacity).min(points.len() - y_offset);
        points[y_offset..y_offset + point_count]
            .sort_unstable_by_key(|point| (point.z, point.x, point.y, point.source_index));
        y_offset += point_count;
    }
}

fn partition_size(total: usize, partitions: usize, index: usize) -> usize {
    total / partitions + usize::from(index < total % partitions)
}

fn ceil_square_root(value: usize) -> usize {
    let mut root = (value as f64).sqrt() as usize;
    while root.saturating_mul(root) < value {
        root += 1;
    }
    while root > 1 && (root - 1).saturating_mul(root - 1) >= value {
        root -= 1;
    }
    root
}

fn ceil_cube_root(value: usize) -> usize {
    let mut root = (value as f64).cbrt() as usize;
    while root.saturating_pow(3) < value {
        root += 1;
    }
    while root > 1 && (root - 1).saturating_pow(3) >= value {
        root -= 1;
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_group_chunks_are_compact_3d_tiles() {
        let mut levels = vec![Level {
            resolution: 0,
            points: (0..4)
                .flat_map(|x| {
                    (0..4).flat_map(move |y| {
                        (0..4).map(move |z| Point {
                            x,
                            y,
                            z,
                            source_index: (x * 16 + y * 4 + z) as u32,
                        })
                    })
                })
                .rev()
                .collect(),
        }];

        pack_levels(&mut levels, 8);

        for chunk in levels[0].points.chunks(8) {
            let span = |coordinate: fn(&Point) -> i32| {
                let min = chunk.iter().map(coordinate).min().unwrap();
                let max = chunk.iter().map(coordinate).max().unwrap();
                max - min
            };
            assert!(span(|point| point.x) <= 1);
            assert!(span(|point| point.y) <= 1);
            assert!(span(|point| point.z) <= 1);
        }
    }

    #[test]
    fn keeps_a_partial_leaf_at_the_end() {
        let mut levels = vec![Level {
            resolution: 0,
            points: (0..19)
                .rev()
                .map(|x| Point {
                    x,
                    y: x % 3,
                    z: x % 5,
                    source_index: x as u32,
                })
                .collect(),
        }];

        pack_levels(&mut levels, 8);

        assert_eq!(19, levels[0].points.len());
        assert_eq!(3, levels[0].points.chunks(8).count());
        assert_eq!(3, levels[0].points.chunks(8).last().unwrap().len());
    }
}

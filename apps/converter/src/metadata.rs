use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PointCloudMetadata {
    pub version: String,
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub bounds: [f64; 6],
    /// Exclusive Row Group end for each resolution level. Starts are the
    /// previous entries (or zero), so storing them would be redundant.
    pub level_row_group_ends: Vec<u32>,
    pub base_voxel_size: f64,
    pub coarsest_voxel_size: f64,
    pub hierarchy: String,
    pub spatial_order: String,
    pub source_las: SourceLasMetadata,
}

pub fn build_level_row_group_ends(
    point_counts: impl IntoIterator<Item = usize>,
    row_group_size: usize,
) -> Vec<u32> {
    assert!(row_group_size > 0);
    let mut row_group_end = 0_u32;
    point_counts
        .into_iter()
        .map(|point_count| {
            row_group_end += point_count.div_ceil(row_group_size) as u32;
            row_group_end
        })
        .collect()
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SourceLasMetadata {
    pub point_format: u8,
    pub extra_bytes_per_point: u16,
    pub scan_angle_scale: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_only_cumulative_row_group_ends() {
        assert_eq!(build_level_row_group_ends([2, 0, 5], 2), vec![1, 1, 4]);
    }
}

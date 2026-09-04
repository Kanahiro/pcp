use std::{path::PathBuf, time::Instant};

use anyhow::{Context, Result, bail};
use clap::Parser;
use las::Reader;
use pcp_convert::{
    IntegerBounds,
    attributes::LasAttributes,
    hierarchy::{automatic_level_count_for_target, build_levels, coarsest_voxel_size},
    metadata::{PointCloudMetadata, SourceLasMetadata, build_level_row_group_ends},
    str::pack_levels,
    writer::write_parquet,
};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(version, about)]
struct Args {
    /// Input LAS or LAZ file.
    input: PathBuf,
    /// Output Parquet file.
    output: PathBuf,
    /// Maximum number of additive levels. Defaults to a scale/bounds-derived ladder.
    #[arg(long, value_parser = clap::value_parser!(u8).range(1..))]
    levels: Option<u8>,
    /// Finest candidate voxel edge in the LAS coordinate reference system.
    /// Defaults to the largest LAS quantization scale.
    #[arg(long)]
    base_voxel_size: Option<f64>,
    /// Approximate upper bound for points in automatically generated L0.
    #[arg(long, default_value_t = 8_192)]
    coarse_points: usize,
    /// Target points per Row Group. Resolution boundaries always end a group.
    #[arg(long, default_value_t = 65_536)]
    row_group_size: usize,
    /// Maximum rows per Parquet data page. Smaller pages improve bbox pruning.
    #[arg(long, default_value_t = 8_192)]
    page_row_count: usize,
    /// ZSTD compression level accepted by parquet-rs (-7 through 22).
    #[arg(long, default_value_t = 3)]
    zstd_level: i32,
}

#[derive(Serialize)]
struct Summary {
    input_points: usize,
    output_bytes: u64,
    bytes_per_point: f64,
    row_group_size: usize,
    page_row_count: usize,
    coarse_points: usize,
    base_voxel_size: f64,
    coarsest_voxel_size: f64,
    level_points: Vec<usize>,
    elapsed_seconds: f64,
}

fn main() -> Result<()> {
    let args = Args::parse();
    if args.row_group_size == 0 {
        bail!("--row-group-size must be greater than zero");
    }
    if args.page_row_count == 0 {
        bail!("--page-row-count must be greater than zero");
    }
    if args.coarse_points == 0 {
        bail!("--coarse-points must be greater than zero");
    }
    let started = Instant::now();
    let mut reader = Reader::from_path(&args.input)
        .with_context(|| format!("failed to open LAS/LAZ input {}", args.input.display()))?;
    let transforms = *reader.header().transforms();
    let source_bounds = reader.header().bounds();
    let point_format = *reader.header().point_format();
    let point_data = reader
        .read_all()
        .context("failed to decode LAS/LAZ points")?;
    let (points, attributes) = LasAttributes::extract(&point_data)?;
    drop(point_data);
    let Some(integer_bounds) = IntegerBounds::from_points(&points) else {
        bail!("input contains no points");
    };

    let scales = [transforms.x.scale, transforms.y.scale, transforms.z.scale];
    let base_voxel_size = args
        .base_voxel_size
        .unwrap_or_else(|| scales.into_iter().fold(f64::NEG_INFINITY, f64::max));
    if !base_voxel_size.is_finite() || base_voxel_size <= 0.0 {
        bail!("--base-voxel-size must be finite and greater than zero");
    }
    let requested_levels = args.levels.unwrap_or_else(|| {
        automatic_level_count_for_target(
            &points,
            integer_bounds,
            scales,
            base_voxel_size,
            args.coarse_points,
        )
    });
    let coarsest_voxel_size = coarsest_voxel_size(requested_levels, base_voxel_size);

    let mut levels = build_levels(
        points,
        requested_levels,
        base_voxel_size,
        scales,
        integer_bounds,
    );
    pack_levels(&mut levels, args.row_group_size);
    let level_points: Vec<_> = levels.iter().map(|level| level.points.len()).collect();
    let metadata = PointCloudMetadata {
        version: "0.1.0".to_owned(),
        scale: scales,
        offset: [
            transforms.x.offset,
            transforms.y.offset,
            transforms.z.offset,
        ],
        bounds: [
            source_bounds.min.x,
            source_bounds.min.y,
            source_bounds.min.z,
            source_bounds.max.x,
            source_bounds.max.y,
            source_bounds.max.z,
        ],
        level_row_group_ends: build_level_row_group_ends(
            level_points.iter().copied(),
            args.row_group_size,
        ),
        base_voxel_size,
        coarsest_voxel_size,
        hierarchy: "additive_voxel_first".to_owned(),
        spatial_order: "str_3d_row_group".to_owned(),
        source_las: SourceLasMetadata {
            point_format: point_format.to_u8()?,
            extra_bytes_per_point: point_format.extra_bytes,
            scan_angle_scale: if point_format.is_extended { 0.006 } else { 1.0 },
        },
    };
    write_parquet(
        &args.output,
        &levels,
        &attributes,
        &metadata,
        args.row_group_size,
        args.page_row_count,
        args.zstd_level,
    )?;

    let output_bytes = std::fs::metadata(&args.output)?.len();
    let input_points = levels.iter().map(|level| level.points.len()).sum::<usize>();
    let summary = Summary {
        input_points,
        output_bytes,
        bytes_per_point: output_bytes as f64 / input_points as f64,
        row_group_size: args.row_group_size,
        page_row_count: args.page_row_count,
        coarse_points: args.coarse_points,
        base_voxel_size,
        coarsest_voxel_size,
        level_points,
        elapsed_seconds: started.elapsed().as_secs_f64(),
    };
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

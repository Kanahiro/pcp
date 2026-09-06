use std::{path::PathBuf, time::Instant};

use anyhow::{Result, bail};
use clap::{Parser, ValueEnum};
use pcp_convert::{
    IntegerBounds,
    hierarchy::{automatic_level_count_for_target, build_levels},
    input::read_inputs,
    metadata::{PointCloudMetadata, build_level_row_group_ends},
    page_order::{PageOrder, reorder_pages},
    str::{pack_levels, pack_pages},
    writer::{IntensityEncoding, write_parquet},
};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(version, about)]
struct Args {
    /// Input LAS or LAZ files. Shell globs such as ./src/*.laz are supported.
    #[arg(required = true)]
    inputs: Vec<PathBuf>,
    /// Output Parquet file.
    #[arg(short, long)]
    output: PathBuf,
    /// Number of levels in the complete voxel ladder, including the exact finest level.
    #[arg(long, value_parser = clap::value_parser!(u8).range(1..))]
    levels: Option<u8>,
    /// Per-axis voxel edge ratio between adjacent levels.
    #[arg(long, default_value_t = 2, value_parser = clap::value_parser!(u32).range(2..))]
    voxel_edge_ratio: u32,
    /// Approximate upper bound for points in automatically generated L0.
    #[arg(long, default_value_t = 8_192)]
    coarse_points: usize,
    /// Target points per Row Group. Resolution boundaries always end a group.
    #[arg(long, default_value_t = 262_144)]
    row_group_size: usize,
    /// Maximum rows per Parquet data page. Smaller pages improve bbox pruning.
    #[arg(long, default_value_t = 8_192)]
    page_row_count: usize,
    /// Ordering applied within each data page after STR fixes its spatial membership.
    #[arg(long, value_enum, default_value_t = PageOrderArg::Spatial)]
    page_order: PageOrderArg,
    /// Parquet encoding used for the intensity column.
    #[arg(long, value_enum, default_value_t = IntensityEncodingArg::Delta)]
    intensity_encoding: IntensityEncodingArg,
    /// ZSTD compression level accepted by parquet-rs (-7 through 22).
    #[arg(long, default_value_t = 9)]
    zstd_level: i32,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum PageOrderArg {
    Spatial,
    Hilbert,
    Source,
    GpsTime,
}

impl From<PageOrderArg> for PageOrder {
    fn from(value: PageOrderArg) -> Self {
        match value {
            PageOrderArg::Spatial => Self::Spatial,
            PageOrderArg::Hilbert => Self::Hilbert,
            PageOrderArg::Source => Self::Source,
            PageOrderArg::GpsTime => Self::GpsTime,
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum IntensityEncodingArg {
    Delta,
    Dictionary,
    Plain,
}

impl From<IntensityEncodingArg> for IntensityEncoding {
    fn from(value: IntensityEncodingArg) -> Self {
        match value {
            IntensityEncodingArg::Delta => Self::Delta,
            IntensityEncodingArg::Dictionary => Self::Dictionary,
            IntensityEncodingArg::Plain => Self::Plain,
        }
    }
}

#[derive(Serialize)]
struct Summary {
    input_files: usize,
    input_points: usize,
    output_bytes: u64,
    bytes_per_point: f64,
    row_group_size: usize,
    page_row_count: usize,
    page_order: &'static str,
    intensity_encoding: &'static str,
    zstd_level: i32,
    coarse_points: usize,
    voxel_edge_ratio: u32,
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
    let inputs = read_inputs(&args.inputs)?;
    let points = inputs.points;
    let attributes = inputs.attributes;
    let Some(integer_bounds) = IntegerBounds::from_points(&points) else {
        bail!("inputs contain no points");
    };

    let scales = inputs.scales;
    let requested_levels = args.levels.unwrap_or_else(|| {
        automatic_level_count_for_target(
            &points,
            integer_bounds,
            scales,
            args.voxel_edge_ratio,
            args.coarse_points,
        )
    });

    let mut levels = build_levels(
        points,
        requested_levels,
        scales,
        args.voxel_edge_ratio,
        integer_bounds,
    );
    pack_levels(&mut levels, args.row_group_size);
    pack_pages(&mut levels, args.row_group_size, args.page_row_count);
    let page_order = PageOrder::from(args.page_order);
    reorder_pages(
        &mut levels,
        &attributes,
        args.row_group_size,
        args.page_row_count,
        page_order,
    )?;
    let level_points: Vec<_> = levels.iter().map(|level| level.points.len()).collect();
    let metadata = PointCloudMetadata {
        version: "0.1.0".to_owned(),
        scale: scales,
        offset: [inputs.offsets[0], inputs.offsets[1], inputs.offsets[2]],
        bounds: [
            f64::from(integer_bounds.min.x) * scales[0] + inputs.offsets[0],
            f64::from(integer_bounds.min.y) * scales[1] + inputs.offsets[1],
            f64::from(integer_bounds.min.z) * scales[2] + inputs.offsets[2],
            f64::from(integer_bounds.max.x) * scales[0] + inputs.offsets[0],
            f64::from(integer_bounds.max.y) * scales[1] + inputs.offsets[1],
            f64::from(integer_bounds.max.z) * scales[2] + inputs.offsets[2],
        ],
        level_row_group_ends: build_level_row_group_ends(
            level_points.iter().copied(),
            args.row_group_size,
        ),
        voxel_edge_ratio: args.voxel_edge_ratio,
        crs: inputs.crs,
    };
    write_parquet(
        &args.output,
        &levels,
        &attributes,
        &metadata,
        args.row_group_size,
        args.page_row_count,
        args.zstd_level,
        args.intensity_encoding.into(),
    )?;

    let output_bytes = std::fs::metadata(&args.output)?.len();
    let input_points = levels.iter().map(|level| level.points.len()).sum::<usize>();
    let summary = Summary {
        input_files: args.inputs.len(),
        input_points,
        output_bytes,
        bytes_per_point: output_bytes as f64 / input_points as f64,
        row_group_size: args.row_group_size,
        page_row_count: args.page_row_count,
        page_order: page_order.name(),
        intensity_encoding: IntensityEncoding::from(args.intensity_encoding).name(),
        zstd_level: args.zstd_level,
        coarse_points: args.coarse_points,
        voxel_edge_ratio: args.voxel_edge_ratio,
        level_points,
        elapsed_seconds: started.elapsed().as_secs_f64(),
    };
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

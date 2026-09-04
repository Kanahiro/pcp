use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use las::{Reader, point::Format};

use crate::{Point, attributes::LasAttributes};

pub struct LasInputs {
    pub points: Vec<Point>,
    pub attributes: LasAttributes,
    pub scales: [f64; 3],
    pub offsets: [f64; 3],
    point_format: Format,
    pub crs: serde_json::Value,
}

/// Reads compatible LAS/LAZ files as one logical point cloud.
///
/// A Parquet output has one coordinate transform and one column layout. Rejecting
/// incompatible inputs here prevents individual source details from leaking into
/// hierarchy construction and writing.
pub fn read_inputs(paths: &[PathBuf]) -> Result<LasInputs> {
    let mut combined: Option<LasInputs> = None;

    for path in paths {
        let mut reader = Reader::from_path(path)
            .with_context(|| format!("failed to open LAS/LAZ input {}", path.display()))?;
        let transforms = *reader.header().transforms();
        let scales = [transforms.x.scale, transforms.y.scale, transforms.z.scale];
        let offsets = [
            transforms.x.offset,
            transforms.y.offset,
            transforms.z.offset,
        ];
        let point_format = *reader.header().point_format();
        let crs = read_crs(reader.header(), path)?;

        if let Some(inputs) = &combined {
            if scales != inputs.scales || offsets != inputs.offsets {
                bail!(
                    "LAS/LAZ input {} uses different coordinate scale/offset values",
                    path.display()
                );
            }
            if point_format != inputs.point_format {
                bail!(
                    "LAS/LAZ input {} uses a different point format",
                    path.display()
                );
            }
            if crs != inputs.crs {
                bail!(
                    "LAS/LAZ input {} uses a different CRS definition",
                    path.display()
                );
            }
        }

        let point_data = reader
            .read_all()
            .with_context(|| format!("failed to decode LAS/LAZ points from {}", path.display()))?;
        let (mut points, attributes) = LasAttributes::extract(&point_data)?;
        drop(point_data);

        if let Some(inputs) = &mut combined {
            let source_index_offset =
                u32::try_from(inputs.attributes.len()).with_context(|| {
                    format!(
                        "more than {} total points are not supported by the in-memory PoC",
                        u32::MAX
                    )
                })?;
            if points.len() > (u32::MAX - source_index_offset) as usize {
                bail!(
                    "more than {} total points are not supported by the in-memory PoC",
                    u32::MAX
                );
            }
            for point in &mut points {
                point.source_index += source_index_offset;
            }
            inputs.points.append(&mut points);
            inputs.attributes.append(attributes)?;
        } else {
            combined = Some(LasInputs {
                points,
                attributes,
                scales,
                offsets,
                point_format,
                crs,
            });
        }
    }

    combined.ok_or_else(|| anyhow::anyhow!("at least one LAS/LAZ input is required"))
}

fn read_crs(header: &las::Header, path: &Path) -> Result<serde_json::Value> {
    let definition = if let Some(bytes) = header.get_wkt_crs_bytes() {
        std::str::from_utf8(bytes)
            .with_context(|| format!("CRS WKT in {} is not valid UTF-8", path.display()))?
            .trim_end_matches('\0')
            .to_owned()
    } else if let Some(geotiff) = header
        .get_geotiff_crs()
        .with_context(|| format!("failed to parse GeoTIFF CRS in {}", path.display()))?
    {
        if geotiff
            .get_vertical_crs_geo_key_value()
            .is_some_and(is_epsg_code)
        {
            bail!(
                "GeoTIFF CRS in {} has a separate vertical CRS that cannot yet be normalized",
                path.display()
            );
        }
        let code = geotiff
            .get_projected_crs_geo_key_value()
            .or_else(|| geotiff.get_geodetic_crs_geo_key_value())
            .filter(|code| is_epsg_code(*code))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "GeoTIFF CRS in {} has no supported EPSG identifier",
                    path.display()
                )
            })?;
        format!("EPSG:{code}")
    } else {
        return Ok(serde_json::Value::Null);
    };

    let crs = proj_wkt::parse_crs(&definition)
        .with_context(|| format!("failed to parse CRS in {}", path.display()))?;
    let projjson = proj_wkt::to_projjson(&crs)
        .with_context(|| format!("failed to encode CRS in {} as PROJJSON", path.display()))?;
    serde_json::from_str(&projjson)
        .with_context(|| format!("generated invalid PROJJSON for {}", path.display()))
}

fn is_epsg_code(code: u16) -> bool {
    (1024..=32766).contains(&code)
}

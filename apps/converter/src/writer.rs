use std::{fs::File, path::Path, sync::Arc};

use anyhow::{Context, Result, ensure};
use arrow_array::{
    ArrayRef, BooleanArray, Float32Array, Float64Array, Int32Array, RecordBatch, UInt8Array,
    UInt16Array, UInt32Array, UInt64Array, builder::BinaryBuilder,
};
use arrow_schema::{DataType, Field, Schema};
use parquet::{
    arrow::ArrowWriter,
    basic::{Compression, Encoding, ZstdLevel},
    file::{metadata::KeyValue, properties::WriterProperties},
    schema::types::ColumnPath,
};

use crate::{
    attributes::LasAttributes,
    hierarchy::Level,
    metadata::{PointCloudMetadata, build_level_row_group_ends},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IntensityEncoding {
    Delta,
    Dictionary,
    Plain,
}

impl IntensityEncoding {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Delta => "delta",
            Self::Dictionary => "dictionary",
            Self::Plain => "plain",
        }
    }
}

pub fn write_parquet(
    path: &Path,
    levels: &[Level],
    attributes: &LasAttributes,
    metadata: &PointCloudMetadata,
    row_group_size: usize,
    page_row_count: usize,
    zstd_level: i32,
    intensity_encoding: IntensityEncoding,
) -> Result<()> {
    ensure!(
        metadata.level_row_group_ends
            == build_level_row_group_ends(
                levels.iter().map(|level| level.points.len()),
                row_group_size,
            ),
        "metadata level layout does not match the supplied points and Row Group size"
    );
    let schema = Arc::new(Schema::new(vec![
        Field::new("x", DataType::Int32, false),
        Field::new("y", DataType::Int32, false),
        Field::new("z", DataType::Int32, false),
        Field::new("red", DataType::UInt16, true),
        Field::new("green", DataType::UInt16, true),
        Field::new("blue", DataType::UInt16, true),
        Field::new("intensity", DataType::UInt16, false),
        Field::new("return_number", DataType::UInt8, false),
        Field::new("number_of_returns", DataType::UInt8, false),
        Field::new("scan_direction_flag", DataType::Boolean, false),
        Field::new("edge_of_flight_line", DataType::Boolean, false),
        Field::new("classification", DataType::UInt8, false),
        Field::new("synthetic", DataType::Boolean, false),
        Field::new("key_point", DataType::Boolean, false),
        Field::new("withheld", DataType::Boolean, false),
        Field::new("overlap", DataType::Boolean, false),
        Field::new("scanner_channel", DataType::UInt8, false),
        Field::new("scan_angle", DataType::Float32, false),
        Field::new("user_data", DataType::UInt8, false),
        Field::new("point_source_id", DataType::UInt16, false),
        Field::new("gps_time", DataType::Float64, true),
        Field::new("nir", DataType::UInt16, true),
        Field::new("wave_packet_descriptor_index", DataType::UInt8, true),
        Field::new("waveform_data_offset", DataType::UInt64, true),
        Field::new("waveform_packet_size", DataType::UInt32, true),
        Field::new("return_point_waveform_location", DataType::Float32, true),
        Field::new("waveform_x_t", DataType::Float32, true),
        Field::new("waveform_y_t", DataType::Float32, true),
        Field::new("waveform_z_t", DataType::Float32, true),
        Field::new("extra_bytes", DataType::Binary, true),
    ]));
    ensure!(!attributes.is_empty(), "attribute store is empty");
    let point_cloud_json = serde_json::to_string(metadata)?;
    let mut properties = WriterProperties::builder()
        .set_writer_version(parquet::file::properties::WriterVersion::PARQUET_2_0)
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(zstd_level)?))
        .set_max_row_group_row_count(Some(row_group_size))
        .set_data_page_row_count_limit(page_row_count)
        .set_key_value_metadata(Some(vec![KeyValue::new(
            "point_cloud".to_owned(),
            point_cloud_json,
        )]));
    // STR packing bounds the coordinate ranges within each Row Group. Explicit
    // delta encoding then exposes the remaining local similarity to ZSTD.
    for column in ["x", "y", "z", "waveform_data_offset"] {
        let path = ColumnPath::from(column);
        properties = properties
            .set_column_dictionary_enabled(path.clone(), false)
            .set_column_encoding(path, Encoding::DELTA_BINARY_PACKED);
    }
    let intensity = ColumnPath::from("intensity");
    properties = match intensity_encoding {
        IntensityEncoding::Delta => properties
            .set_column_dictionary_enabled(intensity.clone(), false)
            .set_column_encoding(intensity, Encoding::DELTA_BINARY_PACKED),
        IntensityEncoding::Dictionary => properties.set_column_dictionary_enabled(intensity, true),
        IntensityEncoding::Plain => properties
            .set_column_dictionary_enabled(intensity.clone(), false)
            .set_column_encoding(intensity, Encoding::PLAIN),
    };
    let gps_time = ColumnPath::from("gps_time");
    properties = properties
        .set_column_dictionary_enabled(gps_time.clone(), false)
        .set_column_encoding(gps_time, Encoding::BYTE_STREAM_SPLIT);
    let properties = properties.build();

    let file = File::create(path)
        .with_context(|| format!("failed to create output {}", path.display()))?;
    let mut writer = ArrowWriter::try_new(file, Arc::clone(&schema), Some(properties))?;

    for level in levels {
        for chunk in level.points.chunks(row_group_size) {
            let x = Int32Array::from_iter_values(chunk.iter().map(|point| point.x));
            let y = Int32Array::from_iter_values(chunk.iter().map(|point| point.y));
            let z = Int32Array::from_iter_values(chunk.iter().map(|point| point.z));
            let index = |point: &crate::Point| point.source_index as usize;
            ensure!(
                chunk.iter().all(|point| index(point) < attributes.len()),
                "point source index is outside the attribute store"
            );
            let mut extra_bytes = BinaryBuilder::new();
            for point in chunk {
                if let Some(data) = &attributes.extra_bytes {
                    let start = index(point) * attributes.extra_bytes_per_point;
                    extra_bytes
                        .append_value(&data[start..start + attributes.extra_bytes_per_point]);
                } else {
                    extra_bytes.append_null();
                }
            }
            let batch = RecordBatch::try_new(
                Arc::clone(&schema),
                vec![
                    Arc::new(x) as ArrayRef,
                    Arc::new(y),
                    Arc::new(z),
                    Arc::new(UInt16Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .color
                            .as_ref()
                            .map(|values| values[index(point)].red)
                    }))),
                    Arc::new(UInt16Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .color
                            .as_ref()
                            .map(|values| values[index(point)].green)
                    }))),
                    Arc::new(UInt16Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .color
                            .as_ref()
                            .map(|values| values[index(point)].blue)
                    }))),
                    Arc::new(UInt16Array::from_iter_values(
                        chunk.iter().map(|point| attributes.intensity[index(point)]),
                    )),
                    Arc::new(UInt8Array::from_iter_values(
                        chunk
                            .iter()
                            .map(|point| attributes.return_number[index(point)]),
                    )),
                    Arc::new(UInt8Array::from_iter_values(
                        chunk
                            .iter()
                            .map(|point| attributes.number_of_returns[index(point)]),
                    )),
                    Arc::new(
                        chunk
                            .iter()
                            .map(|point| attributes.scan_direction_flag[index(point)])
                            .collect::<BooleanArray>(),
                    ),
                    Arc::new(
                        chunk
                            .iter()
                            .map(|point| attributes.edge_of_flight_line[index(point)])
                            .collect::<BooleanArray>(),
                    ),
                    Arc::new(UInt8Array::from_iter_values(
                        chunk
                            .iter()
                            .map(|point| attributes.classification[index(point)]),
                    )),
                    Arc::new(
                        chunk
                            .iter()
                            .map(|point| attributes.synthetic[index(point)])
                            .collect::<BooleanArray>(),
                    ),
                    Arc::new(
                        chunk
                            .iter()
                            .map(|point| attributes.key_point[index(point)])
                            .collect::<BooleanArray>(),
                    ),
                    Arc::new(
                        chunk
                            .iter()
                            .map(|point| attributes.withheld[index(point)])
                            .collect::<BooleanArray>(),
                    ),
                    Arc::new(
                        chunk
                            .iter()
                            .map(|point| attributes.overlap[index(point)])
                            .collect::<BooleanArray>(),
                    ),
                    Arc::new(UInt8Array::from_iter_values(
                        chunk
                            .iter()
                            .map(|point| attributes.scanner_channel[index(point)]),
                    )),
                    Arc::new(Float32Array::from_iter_values(
                        chunk
                            .iter()
                            .map(|point| attributes.scan_angle[index(point)]),
                    )),
                    Arc::new(UInt8Array::from_iter_values(
                        chunk.iter().map(|point| attributes.user_data[index(point)]),
                    )),
                    Arc::new(UInt16Array::from_iter_values(
                        chunk
                            .iter()
                            .map(|point| attributes.point_source_id[index(point)]),
                    )),
                    Arc::new(Float64Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .gps_time
                            .as_ref()
                            .map(|values| values[index(point)])
                    }))),
                    Arc::new(UInt16Array::from_iter(chunk.iter().map(|point| {
                        attributes.nir.as_ref().map(|values| values[index(point)])
                    }))),
                    Arc::new(UInt8Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .waveform
                            .as_ref()
                            .map(|values| values[index(point)].wave_packet_descriptor_index)
                    }))),
                    Arc::new(UInt64Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .waveform
                            .as_ref()
                            .map(|values| values[index(point)].byte_offset_to_waveform_data)
                    }))),
                    Arc::new(UInt32Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .waveform
                            .as_ref()
                            .map(|values| values[index(point)].waveform_packet_size_in_bytes)
                    }))),
                    Arc::new(Float32Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .waveform
                            .as_ref()
                            .map(|values| values[index(point)].return_point_waveform_location)
                    }))),
                    Arc::new(Float32Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .waveform
                            .as_ref()
                            .map(|values| values[index(point)].x_t)
                    }))),
                    Arc::new(Float32Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .waveform
                            .as_ref()
                            .map(|values| values[index(point)].y_t)
                    }))),
                    Arc::new(Float32Array::from_iter(chunk.iter().map(|point| {
                        attributes
                            .waveform
                            .as_ref()
                            .map(|values| values[index(point)].z_t)
                    }))),
                    Arc::new(extra_bytes.finish()),
                ],
            )?;
            writer.write(&batch)?;
        }
        // A row group must never mix resolution levels. File metadata maps
        // each level to this physical range, so no per-point level column is needed.
        writer.flush()?;
    }
    writer.close()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs::File;

    use parquet::file::reader::{FileReader, SerializedFileReader};

    use super::*;
    use crate::{Point, attributes::LasAttributes, metadata::build_level_row_group_ends};

    #[test]
    fn preserves_level_boundaries_as_row_group_boundaries() {
        let temporary = tempfile::NamedTempFile::new().unwrap();
        let levels = vec![
            Level {
                resolution: 0,
                points: vec![
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
                ],
            },
            Level {
                resolution: 1,
                points: vec![
                    Point {
                        x: 10,
                        y: 10,
                        z: 10,
                        source_index: 2,
                    },
                    Point {
                        x: 11,
                        y: 11,
                        z: 11,
                        source_index: 3,
                    },
                    Point {
                        x: 12,
                        y: 12,
                        z: 12,
                        source_index: 4,
                    },
                ],
            },
        ];
        let point_cloud = PointCloudMetadata {
            version: "0.1.0".into(),
            scale: [0.01; 3],
            offset: [0.0; 3],
            bounds: [0.0, 0.0, 0.0, 0.12, 0.12, 0.12],
            level_row_group_ends: build_level_row_group_ends([2, 3], 2),
            voxel_edge_ratio: 2,
            crs: serde_json::Value::Null,
        };
        write_parquet(
            temporary.path(),
            &levels,
            &LasAttributes::defaults(5),
            &point_cloud,
            2,
            2,
            3,
            IntensityEncoding::Delta,
        )
        .unwrap();

        let reader = SerializedFileReader::new(File::open(temporary.path()).unwrap()).unwrap();
        let metadata = reader.metadata();
        assert_eq!(3, metadata.num_row_groups());
        assert_eq!(2, metadata.row_group(0).num_rows());
        assert_eq!(2, metadata.row_group(1).num_rows());
        assert_eq!(1, metadata.row_group(2).num_rows());
        let key_values = metadata.file_metadata().key_value_metadata().unwrap();
        let stored = key_values
            .iter()
            .find(|entry| entry.key == "point_cloud")
            .unwrap();
        assert_eq!(
            serde_json::to_string(&point_cloud).unwrap(),
            stored.value.as_deref().unwrap()
        );
    }
}

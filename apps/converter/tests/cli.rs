use std::{fs::File, process::Command};

use arrow_array::{
    BinaryArray, BooleanArray, Float32Array, Float64Array, UInt8Array, UInt16Array, UInt32Array,
    UInt64Array,
};
use las::{
    Builder, Color, Point, Reader, Writer,
    point::{Classification, Format, ScanDirection},
    raw::point::Waveform,
};
use parquet::{
    arrow::arrow_reader::ParquetRecordBatchReaderBuilder,
    file::reader::{FileReader, SerializedFileReader},
};

fn write_simple_las(path: &std::path::Path, start: u16, count: u16) {
    let builder = Builder::from((1, 4));
    let mut header = builder.into_header().unwrap();
    header
        .set_wkt_crs(
            br#"GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]"#
                .to_vec(),
        )
        .unwrap();
    let mut writer = Writer::from_path(path, header).unwrap();
    for index in start..start + count {
        writer
            .write_point(Point {
                x: f64::from(index) * 0.01,
                y: 0.0,
                z: 0.0,
                intensity: index,
                ..Point::default()
            })
            .unwrap();
    }
    writer.close().unwrap();
}

#[test]
fn combines_multiple_las_inputs_into_one_parquet() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first.las");
    let second = directory.path().join("second.las");
    let output = directory.path().join("combined.parquet");
    write_simple_las(&first, 1, 3);
    write_simple_las(&second, 10, 2);

    let result = Command::new(env!("CARGO_BIN_EXE_pcp-convert"))
        .args([&first, &second])
        .arg("--output")
        .arg(&output)
        .args(["--levels", "1"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let summary: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(2, summary["input_files"]);
    assert_eq!(5, summary["input_points"]);

    let reader = SerializedFileReader::new(File::open(&output).unwrap()).unwrap();
    assert_eq!(5, reader.metadata().file_metadata().num_rows());
    let stored = reader
        .metadata()
        .file_metadata()
        .key_value_metadata()
        .unwrap()
        .iter()
        .find(|entry| entry.key == "point_cloud")
        .unwrap()
        .value
        .as_deref()
        .unwrap();
    let point_cloud: serde_json::Value = serde_json::from_str(stored).unwrap();
    assert_eq!("GeographicCRS", point_cloud["crs"]["type"]);
    assert_eq!("EPSG", point_cloud["crs"]["id"]["authority"]);
    assert_eq!(4326, point_cloud["crs"]["id"]["code"]);

    let mut batches = ParquetRecordBatchReaderBuilder::try_new(File::open(output).unwrap())
        .unwrap()
        .build()
        .unwrap();
    let batch = batches.next().unwrap().unwrap();
    let intensity = batch
        .column(batch.schema().index_of("intensity").unwrap())
        .as_any()
        .downcast_ref::<UInt16Array>()
        .unwrap();
    let mut values: Vec<_> = intensity.values().iter().copied().collect();
    values.sort_unstable();
    assert_eq!(vec![1, 2, 3, 10, 11], values);
}

#[test]
fn converts_las_to_prunable_parquet() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("fixture.las");
    let output = directory.path().join("fixture.parquet");
    let mut builder = Builder::from((1, 4));
    builder.point_format = Format::new(10).unwrap();
    builder.point_format.extra_bytes = 2;
    let mut writer = Writer::from_path(&input, builder.into_header().unwrap()).unwrap();
    for index in 0..40 {
        writer
            .write_point(Point {
                x: f64::from(index) * 0.01,
                y: f64::from(index % 5) * 0.01,
                z: f64::from(index % 3) * 0.01,
                intensity: 1000 + index,
                return_number: 1,
                number_of_returns: 2,
                scan_direction: if index % 2 == 0 {
                    ScanDirection::LeftToRight
                } else {
                    ScanDirection::RightToLeft
                },
                is_edge_of_flight_line: index == 39,
                classification: Classification::Ground,
                is_synthetic: index % 2 == 0,
                is_key_point: index % 3 == 0,
                is_withheld: index % 5 == 0,
                is_overlap: index % 7 == 0,
                scanner_channel: (index % 4) as u8,
                scan_angle: f32::from(index) * 0.006,
                user_data: index as u8,
                point_source_id: 200 + index,
                gps_time: Some(1_000_000.0 + f64::from(index)),
                color: Some(Color::new(10 + index, 20 + index, 30 + index)),
                nir: Some(40 + index),
                waveform: Some(Waveform {
                    wave_packet_descriptor_index: 1,
                    byte_offset_to_waveform_data: u64::from(index) * 64,
                    waveform_packet_size_in_bytes: 64,
                    return_point_waveform_location: 0.5,
                    x_t: 1.0,
                    y_t: 2.0,
                    z_t: 3.0,
                }),
                extra_bytes: vec![index as u8, 255 - index as u8],
            })
            .unwrap();
    }
    writer.close().unwrap();
    let mut source_reader = Reader::from_path(&input).unwrap();
    let source_data = source_reader.read_all().unwrap();
    let source_scan_angles: Vec<f32> = source_data
        .points()
        .map(|point| point.unwrap().scan_angle)
        .collect();

    let result = Command::new(env!("CARGO_BIN_EXE_pcp-convert"))
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .args([
            "--levels",
            "3",
            "--row-group-size",
            "8",
            "--page-row-count",
            "4",
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let reader = SerializedFileReader::new(File::open(output).unwrap()).unwrap();
    let metadata = reader.metadata();
    assert_eq!(40, metadata.file_metadata().num_rows());
    assert!(metadata.num_row_groups() >= 3);
    assert_eq!(30, metadata.file_metadata().schema_descr().num_columns());
    let column_names: Vec<_> = metadata
        .file_metadata()
        .schema_descr()
        .columns()
        .iter()
        .map(|column| column.name())
        .collect();
    assert_eq!(&column_names[..6], &["x", "y", "z", "red", "green", "blue"]);
    assert!(
        metadata
            .file_metadata()
            .schema_descr()
            .columns()
            .iter()
            .all(|column| column.name() != "resolution")
    );
    for row_group in metadata.row_groups() {
        for column_index in 0..3 {
            assert!(row_group.column(column_index).statistics().is_some());
        }
        assert!(row_group.column(0).offset_index_offset().is_some());
        assert!(row_group.column(0).column_index_offset().is_some());
    }
    let stored = metadata
        .file_metadata()
        .key_value_metadata()
        .unwrap()
        .iter()
        .find(|entry| entry.key == "point_cloud")
        .unwrap()
        .value
        .as_deref()
        .unwrap();
    let point_cloud: serde_json::Value = serde_json::from_str(stored).unwrap();
    assert_eq!(
        3,
        point_cloud["level_row_group_ends"]
            .as_array()
            .unwrap()
            .len()
    );
    assert!(point_cloud.get("levels").is_none());
    assert!(point_cloud.get("resolution_levels").is_none());

    let mut batches = ParquetRecordBatchReaderBuilder::try_new(
        File::open(directory.path().join("fixture.parquet")).unwrap(),
    )
    .unwrap()
    .build()
    .unwrap();
    let batch = batches.next().unwrap().unwrap();
    let column = |name: &str| batch.column(batch.schema().index_of(name).unwrap());
    let intensity = column("intensity")
        .as_any()
        .downcast_ref::<UInt16Array>()
        .unwrap();
    let red = column("red")
        .as_any()
        .downcast_ref::<UInt16Array>()
        .unwrap();
    let green = column("green")
        .as_any()
        .downcast_ref::<UInt16Array>()
        .unwrap();
    let blue = column("blue")
        .as_any()
        .downcast_ref::<UInt16Array>()
        .unwrap();
    let nir = column("nir")
        .as_any()
        .downcast_ref::<UInt16Array>()
        .unwrap();
    let gps = column("gps_time")
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap();
    let direction = column("scan_direction_flag")
        .as_any()
        .downcast_ref::<BooleanArray>()
        .unwrap();
    let classification = column("classification")
        .as_any()
        .downcast_ref::<UInt8Array>()
        .unwrap();
    let scan_angle = column("scan_angle")
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    let waveform_offset = column("waveform_data_offset")
        .as_any()
        .downcast_ref::<UInt64Array>()
        .unwrap();
    let waveform_size = column("waveform_packet_size")
        .as_any()
        .downcast_ref::<UInt32Array>()
        .unwrap();
    let waveform_x = column("waveform_x_t")
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    let extra = column("extra_bytes")
        .as_any()
        .downcast_ref::<BinaryArray>()
        .unwrap();
    for row in 0..batch.num_rows() {
        let source = red.value(row) - 10;
        assert_eq!(1000 + source, intensity.value(row));
        assert_eq!(20 + source, green.value(row));
        assert_eq!(30 + source, blue.value(row));
        assert_eq!(40 + source, nir.value(row));
        assert_eq!(1_000_000.0 + f64::from(source), gps.value(row));
        assert_eq!(source % 2 == 0, direction.value(row));
        assert_eq!(2, classification.value(row));
        assert!((source_scan_angles[usize::from(source)] - scan_angle.value(row)).abs() < 1e-6);
        assert_eq!(u64::from(source) * 64, waveform_offset.value(row));
        assert_eq!(64, waveform_size.value(row));
        assert_eq!(1.0, waveform_x.value(row));
        assert_eq!([source as u8, 255 - source as u8], extra.value(row));
    }
}

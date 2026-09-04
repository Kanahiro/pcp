pub mod attributes;
pub mod hierarchy;
pub mod metadata;
pub mod str;
pub mod writer;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub source_index: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IntegerBounds {
    pub min: Point,
    pub max: Point,
}

impl IntegerBounds {
    pub fn from_points(points: &[Point]) -> Option<Self> {
        let first = *points.first()?;
        Some(points.iter().copied().skip(1).fold(
            Self {
                min: first,
                max: first,
            },
            |mut bounds, point| {
                bounds.min.x = bounds.min.x.min(point.x);
                bounds.min.y = bounds.min.y.min(point.y);
                bounds.min.z = bounds.min.z.min(point.z);
                bounds.max.x = bounds.max.x.max(point.x);
                bounds.max.y = bounds.max.y.max(point.y);
                bounds.max.z = bounds.max.z.max(point.z);
                bounds
            },
        ))
    }
}

use super::{Sketch, LINEAR_TOLERANCE};
use crate::{
    error::{CoreError, ErrorCode, Result},
    protocol::*,
};

pub struct Line {
    pub from: [f64; 2],
    pub to: [f64; 2],
}
pub struct Rectangle {
    pub id: String,
    pub lines: Vec<String>,
    pub min: [f64; 2],
    pub max: [f64; 2],
}

pub fn validate(parameters: &RectangleParameters) -> Result<()> {
    if !parameters
        .from
        .iter()
        .chain(&parameters.to)
        .all(|v| v.is_finite())
        || (0..2).any(|axis| {
            let extent = (parameters.to[axis] - parameters.from[axis]).abs();
            !extent.is_finite() || extent <= LINEAR_TOLERANCE
        })
    {
        return Err(CoreError::new(
            ErrorCode::InvalidParameter,
            "Rectangle requires finite coordinates and two nonzero dimensions",
        ));
    }
    Ok(())
}

// A rectangle is a convenience command producing ordinary sketch lines.
pub fn add_rectangle(
    sketch: &mut Sketch,
    id: String,
    parameters: RectangleParameters,
) -> RectangleData {
    let min = std::array::from_fn(|i| parameters.from[i].min(parameters.to[i]));
    let max = std::array::from_fn(|i| parameters.from[i].max(parameters.to[i]));
    let points = [min, [max[0], min[1]], max, [min[0], max[1]]];
    let lines: Vec<_> = (0..4)
        .map(|i| {
            let line_id = format!("{id}:line:{i}");
            sketch.lines.insert(
                line_id.clone(),
                Line {
                    from: points[i],
                    to: points[(i + 1) % 4],
                },
            );
            line_id
        })
        .collect();
    let references = lines
        .iter()
        .map(|id| LineRef {
            scene_id: sketch.data.scene_id.clone(),
            sketch_id: sketch.data.id.clone(),
            id: id.clone(),
        })
        .collect();
    sketch.rectangles.push(Rectangle {
        id: id.clone(),
        lines,
        min,
        max,
    });
    RectangleData {
        id,
        lines: references,
    }
}

pub fn add_circle(sketch: &mut Sketch, id: String, circle: CircleParameters) -> Result<CircleData> {
    if !circle.center.iter().all(|v| v.is_finite())
        || !circle.diameter.is_finite()
        || circle.diameter / 2. <= LINEAR_TOLERANCE
    {
        return Err(CoreError::new(
            ErrorCode::InvalidParameter,
            "Circle requires a finite center and radius greater than the linear tolerance",
        ));
    }
    sketch.circles.insert(id.clone(), circle);
    Ok(CircleData { id })
}

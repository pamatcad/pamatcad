use crate::{
    error::{CoreError, ErrorCode, Result},
    kernel::Shape,
    protocol::*,
    sketch::{Boundary, Sketch, LINEAR_TOLERANCE},
};

pub fn evaluate(
    sketch: &Sketch,
    profile: &RegionRef,
    parameters: &ExtrudeParameters,
) -> Result<Shape> {
    let length = parameters.length;
    let cut = parameters.mode == Some(ExtrudeMode::Cut);
    if !length.is_finite() || length.abs() <= LINEAR_TOLERANCE || (!cut && length < 0.) {
        return Err(CoreError::new(ErrorCode::InvalidParameter,
            "Length must be finite and exceed the linear tolerance in magnitude; new-body extrusion requires positive length"));
    }
    let frame = sketch.frame;
    let direction = frame.normal.map(|value| value * length);
    match sketch.profile(profile)? {
        Boundary::Lines(ids) => {
            let points = ids
                .iter()
                .map(|id| frame.point(sketch.lines[id].from))
                .collect::<Vec<_>>();
            Shape::extrude(&points, direction)
        }
        Boundary::Circle(id) => {
            let circle = &sketch.circles[id];
            Shape::extrude_circle(
                frame.point(circle.center),
                circle.diameter / 2.,
                frame.normal,
                direction,
            )
        }
    }
}

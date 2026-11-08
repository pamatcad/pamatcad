use super::{Sketch, LINEAR_TOLERANCE};
use crate::{
    error::{CoreError, ErrorCode, Result},
    protocol::RegionRef,
};

pub struct Region {
    pub reference: RegionRef,
    pub boundary: Boundary,
}

pub enum Boundary {
    Lines(Vec<String>),
    Circle(String),
}

pub fn evaluate(sketch: &Sketch) -> Result<Vec<Region>> {
    for (i, a) in sketch.rectangles.iter().enumerate() {
        for b in &sketch.rectangles[i + 1..] {
            let disjoint = (0..2).any(|axis| {
                a.max[axis] < b.min[axis] - LINEAR_TOLERANCE
                    || b.max[axis] < a.min[axis] - LINEAR_TOLERANCE
            });
            if !disjoint {
                return Err(CoreError::new(
                    ErrorCode::UnsupportedProfile,
                    "Intersecting, touching, and nested profiles are not supported yet",
                ));
            }
        }
    }
    let mut regions = sketch
        .rectangles
        .iter()
        .map(|rectangle| {
            for (i, id) in rectangle.lines.iter().enumerate() {
                let next = &rectangle.lines[(i + 1) % rectangle.lines.len()];
                if sketch.lines[id].to != sketch.lines[next].from {
                    return Err(CoreError::new(
                        ErrorCode::InvalidState,
                        "Profile boundary is not closed",
                    ));
                }
            }
            Ok(Region {
                reference: RegionRef {
                    scene_id: sketch.data.scene_id.clone(),
                    sketch_id: sketch.data.id.clone(),
                    id: format!("{}:region", rectangle.id),
                },
                boundary: Boundary::Lines(rectangle.lines.clone()),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    for (id, circle) in &sketch.circles {
        let [x, y] = circle.center;
        let radius = circle.diameter / 2.;
        // This slice supports disjoint closed profiles. Reject overlaps, touches and nesting.
        let overlaps_rectangle = sketch.rectangles.iter().any(|rect| {
            let dx = x - x.clamp(rect.min[0], rect.max[0]);
            let dy = y - y.clamp(rect.min[1], rect.max[1]);
            dx.hypot(dy) <= radius + LINEAR_TOLERANCE
        });
        let overlaps_circle = sketch
            .circles
            .iter()
            .take_while(|(other_id, _)| *other_id < id)
            .any(|(_, other)| {
                (x - other.center[0]).hypot(y - other.center[1])
                    <= radius + other.diameter / 2. + LINEAR_TOLERANCE
            });
        if overlaps_rectangle || overlaps_circle {
            return Err(CoreError::new(
                ErrorCode::UnsupportedProfile,
                "Intersecting, touching, and nested profiles are not supported yet",
            ));
        }
        regions.push(Region {
            reference: RegionRef {
                scene_id: sketch.data.scene_id.clone(),
                sketch_id: sketch.data.id.clone(),
                id: format!("{id}:region"),
            },
            boundary: Boundary::Circle(id.clone()),
        });
    }
    Ok(regions)
}

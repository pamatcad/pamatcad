use crate::{
    engine::modeling::{ModelingCommand, ProposedChanges},
    error::{CoreError, ErrorCode, Result},
    kernel::Shape,
    model::{Body, Scene},
    protocol::*,
    sketch::{Boundary, Frame, Sketch, LINEAR_TOLERANCE},
};

impl ModelingCommand for Extrude {
    fn scene_id(&self) -> Result<&str> {
        match &self.profile {
            Profiles::Face(face) => Some(face.scene_id()),
            Profiles::Faces(faces) => faces.first().map(FaceRef::scene_id),
            regions => regions.regions().first().map(|r| r.scene_id.as_str()),
        }
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::InvalidParameter,
                "Select at least one extrusion profile",
            )
        })
    }

    fn evaluate(self, scene: &Scene) -> Result<ProposedChanges> {
        let length = self.parameters.length;
        let mode = self.parameters.mode.unwrap_or(ExtrudeMode::NewBody);
        if !length.is_finite()
            || length.abs() <= LINEAR_TOLERANCE
            || (mode == ExtrudeMode::NewBody && length < 0.)
        {
            return Err(CoreError::new(ErrorCode::InvalidParameter,
                "Length must be finite and exceed the linear tolerance in magnitude; new-body extrusion requires positive length"));
        }
        let mut shapes = match &self.profile {
            Profiles::Face(face) => extrude_faces(scene, std::slice::from_ref(face), length)?,
            Profiles::Faces(faces) => extrude_faces(scene, faces, length)?,
            regions => extrude_regions(scene, regions.regions(), length)?,
        };
        for (index, shape) in shapes.iter_mut().enumerate() {
            shape.record_profile(index);
        }
        let (created, changed) = match mode {
            ExtrudeMode::NewBody => {
                if self.targets.is_some() {
                    return Err(CoreError::new(
                        ErrorCode::InvalidParameter,
                        "New-body extrusion does not accept targets",
                    ));
                }
                (shapes, vec![])
            }
            ExtrudeMode::Cut => (
                vec![],
                cut_targets(&targets(scene, self.targets.as_deref())?, &shapes)?,
            ),
            ExtrudeMode::Join => (
                vec![],
                join_targets(&targets(scene, self.targets.as_deref())?, &shapes)?,
            ),
        };
        Ok(ProposedChanges {
            operation: Operation::Extrude {
                inputs: ExtrudeInputs {
                    profile: self.profile,
                    targets: self.targets,
                },
                parameters: self.parameters,
            },
            created,
            changed,
        })
    }
}

fn targets<'a>(scene: &'a Scene, selection: Option<&[BodyRef]>) -> Result<Vec<&'a Body>> {
    let Some(selection) = selection else {
        return Ok(scene.bodies.values().collect());
    };
    let mut seen = std::collections::BTreeSet::new();
    selection
        .iter()
        .map(|target| {
            if target.scene_id != scene.data.id || !seen.insert(&target.id) {
                return Err(CoreError::new(
                    ErrorCode::InvalidParameter,
                    "Targets must be distinct bodies in the profile's scene",
                ));
            }
            scene
                .bodies
                .get(&target.id)
                .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "Target does not exist"))
        })
        .collect()
}

fn cut_targets(targets: &[&Body], shapes: &[Shape]) -> Result<Vec<Body>> {
    let mut changed = Vec::new();
    for body in targets {
        let mut candidate = None;
        for tool in shapes {
            if let Some(next) = candidate.as_ref().unwrap_or(&body.shape).cut(tool)? {
                candidate = Some(next);
            }
        }
        if let Some(shape) = candidate {
            changed.push(Body {
                reference: body.reference.clone(),
                shape,
            });
        }
    }
    if changed.is_empty() {
        return Err(CoreError::new(
            ErrorCode::InvalidParameter,
            "Cut removes no material from its targets",
        ));
    }
    Ok(changed)
}

fn join_targets(targets: &[&Body], shapes: &[Shape]) -> Result<Vec<Body>> {
    let mut candidates: Vec<Option<Shape>> = targets.iter().map(|_| None).collect();
    let mut pending: Vec<_> = shapes.iter().collect();
    while !pending.is_empty() {
        let mut remaining = Vec::new();
        for tool in &pending {
            let mut joined = None;
            for (i, body) in targets.iter().enumerate() {
                let target = candidates[i].as_ref().unwrap_or(&body.shape);
                if let Some(shape) = target.join(tool)? {
                    if joined.is_some() {
                        return Err(CoreError::new(
                            ErrorCode::InvalidParameter,
                            "Joining multiple existing bodies into one is not supported",
                        ));
                    }
                    joined = Some((i, shape));
                }
            }
            if let Some((index, shape)) = joined {
                candidates[index] = Some(shape);
            } else {
                remaining.push(*tool);
            }
        }
        if remaining.len() == pending.len() {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Each join profile must add material to a target",
            ));
        }
        pending = remaining;
    }
    Ok(targets
        .iter()
        .zip(candidates)
        .filter_map(|(body, shape)| {
            shape.map(|shape| Body {
                reference: body.reference.clone(),
                shape,
            })
        })
        .collect())
}

fn extrude_faces(scene: &Scene, faces: &[FaceRef], length: f64) -> Result<Vec<Shape>> {
    let mut plane: Option<Frame> = None;
    let mut selected = std::collections::BTreeSet::new();
    let mut shapes = Vec::with_capacity(faces.len());
    for face in faces {
        let (body, slot) = scene.resolve_face(face)?;
        let frame = body.shape.face_frame(slot)?;
        let first = *plane.get_or_insert(frame);
        if !selected.insert((&body.reference.id, slot)) || !first.coplanar_with(frame) {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Select distinct coplanar faces",
            ));
        }
        shapes.push(
            body.shape
                .extrude_face(slot, first.normal.map(|v| v * length))?,
        );
    }
    Ok(shapes)
}

fn extrude_regions(scene: &Scene, regions: &[RegionRef], length: f64) -> Result<Vec<Shape>> {
    let first = regions
        .first()
        .ok_or_else(|| CoreError::new(ErrorCode::InvalidParameter, "Select at least one region"))?;
    let sketch = scene.sketches.get(&first.sketch_id).ok_or_else(|| {
        CoreError::new(ErrorCode::NotFound, "Sketch does not exist in this scene")
    })?;
    let mut selected = std::collections::BTreeSet::new();
    regions
        .iter()
        .map(|region| {
            if region.scene_id != scene.data.id
                || region.sketch_id != sketch.data.id
                || !selected.insert(&region.id)
            {
                return Err(CoreError::new(
                    ErrorCode::InvalidParameter,
                    "Select distinct regions from one sketch",
                ));
            }
            evaluate_profile(sketch, region, length)
        })
        .collect()
}

fn evaluate_profile(sketch: &Sketch, profile: &RegionRef, length: f64) -> Result<Shape> {
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

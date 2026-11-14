use crate::{
    engine::modeling::{BodyUpdate, ModelingCommand, ProposedChanges},
    error::{CoreError, ErrorCode, Result},
    kernel::{CellPartition, PrismOptions, Shape},
    model::{Body, Scene},
    protocol::*,
    sketch::{Boundary, Frame, Sketch},
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
        let mode = self.parameters.mode.unwrap_or(ExtrudeMode::NewBody);
        if mode == ExtrudeMode::NewBody && self.targets.is_some() {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "New-body extrusion does not accept targets",
            ));
        }
        let needs_bounds = matches!(self.parameters.extent1, Some(ExtrudeExtent::ThroughAll))
            || matches!(self.parameters.extent2, Some(ExtrudeExtent::ThroughAll));
        let bodies = if mode != ExtrudeMode::NewBody || needs_bounds {
            targets(scene, self.targets.as_deref())?
        } else {
            Vec::new()
        };
        let resolve = |frame| self.parameters.resolve(scene, frame, &bodies);
        let mut shapes = match &self.profile {
            Profiles::Face(face) => extrude_faces(scene, std::slice::from_ref(face), resolve)?,
            Profiles::Faces(faces) => extrude_faces(scene, faces, resolve)?,
            regions => extrude_regions(scene, regions.regions(), resolve)?,
        };
        let mut changes = ProposedChanges {
            created: vec![],
            updated: vec![],
            removed: vec![],
            operation: Operation::Extrude {
                inputs: ExtrudeInputs {
                    profile: self.profile,
                    targets: self.targets,
                },
                parameters: self.parameters,
            },
        };
        let Operation::Extrude { inputs, .. } = &changes.operation;
        if mode == ExtrudeMode::NewBody {
            for (index, shape) in shapes.iter_mut().enumerate() {
                shape.record_profile(index);
            }
            changes.created = shapes;
        } else {
            let source_faces = match &inputs.profile {
                Profiles::Face(face) => std::slice::from_ref(face),
                Profiles::Faces(faces) => faces.as_slice(),
                _ => &[],
            };
            let sources = source_faces
                .iter()
                .map(|f| {
                    let (body, _) = scene.resolve_face(f)?;
                    Ok(bodies
                        .iter()
                        .position(|target| target.reference == body.reference))
                })
                .collect::<Result<Vec<_>>>()?;
            apply_boolean(&bodies, &shapes, &sources, mode, &mut changes)?;
        }
        Ok(changes)
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

fn apply_boolean(
    targets: &[&Body],
    tools: &[Shape],
    sources: &[Option<usize>],
    mode: ExtrudeMode,
    changes: &mut ProposedChanges,
) -> Result<()> {
    let join = mode == ExtrudeMode::Join;
    if targets.is_empty() {
        return Err(CoreError::new(
            ErrorCode::InvalidParameter,
            "The operation needs a target body",
        ));
    }
    let shapes: Vec<_> = targets.iter().map(|body| &body.shape).collect();
    let mut partition = CellPartition::new(&shapes, tools, join)?;
    for group in 0..partition.group_count {
        let (bodies, profiles) = partition.members(group);
        let oldest = bodies
            .iter()
            .min_by_key(|&&i| targets[i].created_at)
            .copied()
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::InvalidParameter,
                    "Each join profile must connect to a target",
                )
            })?;
        let mut owners = profiles
            .iter()
            .filter_map(|&i| sources.get(i).copied().flatten())
            .filter(|i| bodies.contains(i));
        let survivor = match owners.next() {
            Some(first) if owners.all(|i| i == first) => first,
            _ => oldest,
        };
        let body = targets[survivor];
        let mut offset = body.shape.slot_count();
        let mut absorbed_slots = Vec::new();
        for &i in bodies.iter().filter(|&&i| i != survivor) {
            let end = offset + targets[i].shape.slot_count();
            absorbed_slots.push((targets[i].reference.id.clone(), offset..end));
            changes.removed.push(targets[i].reference.clone());
            offset = end;
        }
        let mut profile_slots = Vec::new();
        for &i in profiles {
            let end = offset + tools[i].slot_count();
            profile_slots.push((i, offset..end));
            offset = end;
        }
        let (shape, material_changed) = partition.result(group, survivor)?;
        if let Some(mut shape) = shape {
            shape.profile_slots = profile_slots;
            changes.updated.push(BodyUpdate {
                body: Body {
                    reference: body.reference.clone(),
                    created_at: body.created_at,
                    shape,
                },
                material_changed,
                absorbed_slots,
            });
        } else if !join {
            changes.removed.push(body.reference.clone());
        } else {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Join neither adds material nor merges bodies",
            ));
        }
    }
    if changes.updated.is_empty() && changes.removed.is_empty() {
        return Err(CoreError::new(
            ErrorCode::InvalidParameter,
            "Cut removes no material from its targets",
        ));
    }
    Ok(())
}

fn extrude_faces<'a>(
    scene: &Scene,
    faces: &[FaceRef],
    resolve: impl Fn(Frame) -> Result<PrismOptions<'a>>,
) -> Result<Vec<Shape>> {
    let first = faces.first().ok_or_else(|| {
        CoreError::new(
            ErrorCode::InvalidParameter,
            "Select at least one extrusion face",
        )
    })?;
    let (first_body, first_slot) = scene.resolve_face(first)?;
    let plane = first_body.shape.face_frame(first_slot)?;
    let options = resolve(plane)?;
    let mut selected = std::collections::BTreeSet::new();
    let mut shapes = Vec::with_capacity(faces.len());
    for face in faces {
        let (body, slot) = scene.resolve_face(face)?;
        let frame = body.shape.face_frame(slot)?;
        if !selected.insert((&body.reference.id, slot)) || !plane.coplanar_with(frame) {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Select distinct coplanar faces",
            ));
        }
        shapes.push(body.shape.extrude_face(slot, &options)?);
    }
    Ok(shapes)
}

fn extrude_regions<'a>(
    scene: &Scene,
    regions: &[RegionRef],
    resolve: impl Fn(Frame) -> Result<PrismOptions<'a>>,
) -> Result<Vec<Shape>> {
    let first = regions
        .first()
        .ok_or_else(|| CoreError::new(ErrorCode::InvalidParameter, "Select at least one region"))?;
    let sketch = scene.sketches.get(&first.sketch_id).ok_or_else(|| {
        CoreError::new(ErrorCode::NotFound, "Sketch does not exist in this scene")
    })?;
    let options = resolve(sketch.frame)?;
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
            evaluate_profile(sketch, region, &options)
        })
        .collect()
}

fn evaluate_profile(sketch: &Sketch, profile: &RegionRef, options: &PrismOptions) -> Result<Shape> {
    let frame = sketch.frame;
    match sketch.profile(profile)? {
        Boundary::Lines(ids) => {
            let points = ids
                .iter()
                .map(|id| frame.point(sketch.lines[id].from))
                .collect::<Vec<_>>();
            Shape::extrude(&points, options)
        }
        Boundary::Circle(id) => {
            let circle = &sketch.circles[id];
            Shape::extrude_circle(frame.point(circle.center), circle.diameter / 2., options)
        }
    }
}

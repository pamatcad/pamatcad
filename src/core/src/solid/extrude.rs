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

    fn evaluate(mut self, scene: &Scene) -> Result<ProposedChanges> {
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
        let target_shapes: Vec<_> = bodies.iter().map(|body| &body.shape).collect();
        let mut partition = if mode != ExtrudeMode::NewBody && !bodies.is_empty() {
            Some(CellPartition::new(&target_shapes, &shapes, mode)?)
        } else {
            None
        };
        let resolved_mode = if mode == ExtrudeMode::Auto {
            partition.as_ref().map_or(ExtrudeMode::NewBody, |p| p.mode)
        } else {
            mode
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
                resolved_mode: (mode == ExtrudeMode::Auto).then_some(resolved_mode),
            },
        };
        let Operation::Extrude { inputs, .. } = &changes.operation;
        if resolved_mode == ExtrudeMode::NewBody {
            drop(partition);
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
            let partition = partition.as_mut().ok_or_else(|| {
                CoreError::new(
                    ErrorCode::InvalidParameter,
                    "The operation needs a target body",
                )
            })?;
            apply_boolean(&bodies, &shapes, &sources, partition, &mut changes)?;
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
    partition: &mut CellPartition<'_>,
    changes: &mut ProposedChanges,
) -> Result<()> {
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
        let mut inherited_slots = vec![(body.reference.id.clone(), 0..offset)];
        for &i in bodies.iter().filter(|&&i| i != survivor) {
            let end = offset + targets[i].shape.slot_count();
            inherited_slots.push((targets[i].reference.id.clone(), offset..end));
            changes.removed.push(targets[i].reference.clone());
            offset = end;
        }
        let mut profile_slots = Vec::new();
        for &i in profiles {
            let end = offset + tools[i].slot_count();
            profile_slots.push((i, offset..end));
            offset = end;
        }
        let (shapes, material_changed) = partition.result(group, survivor)?;
        if shapes.is_empty() && material_changed {
            changes.removed.push(body.reference.clone());
        }
        for (index, mut shape) in shapes.into_iter().enumerate() {
            shape.profile_slots = profile_slots.clone();
            for (source, slots) in &inherited_slots {
                for (old_slot, slot) in slots.clone().enumerate() {
                    let descendants = shape.face_ids(Some(slot..slot + 1))?;
                    shape
                        .inherited_faces
                        .push(((source.clone(), old_slot), descendants));
                }
            }
            if index == 0 {
                changes.updated.push(BodyUpdate {
                    body: Body {
                        reference: body.reference.clone(),
                        created_at: body.created_at,
                        revision: 0,
                        shape,
                    },
                    material_changed,
                });
            } else {
                changes.created.push(shape);
            }
        }
    }
    if changes.updated.is_empty() && changes.removed.is_empty() {
        return Err(CoreError::new(
            ErrorCode::InvalidParameter,
            match partition.mode {
                ExtrudeMode::Join => "Join neither adds material nor merges bodies",
                ExtrudeMode::Intersect => {
                    "Intersect removes no material from its overlapping targets"
                }
                _ => "Cut removes no material from its targets",
            },
        ));
    }
    Ok(())
}

fn extrude_faces<'a>(
    scene: &Scene,
    faces: &[FaceRef],
    resolve: impl FnOnce(Frame) -> Result<PrismOptions<'a>>,
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
    resolve: impl FnOnce(Frame) -> Result<PrismOptions<'a>>,
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

use crate::{
    engine::modeling::{ModelingCommand, ProposedChanges},
    error::{CoreError, ErrorCode, Result},
    kernel::Shape,
    model::{Body, Scene},
    protocol::*,
    sketch::{Boundary, Sketch, LINEAR_TOLERANCE},
};

impl Extrude {
    fn first_profile(&self) -> Result<&RegionRef> {
        self.profile.regions().first().ok_or_else(|| {
            CoreError::new(ErrorCode::InvalidParameter, "Select at least one region")
        })
    }
}

impl ModelingCommand for Extrude {
    fn scene_id(&self) -> Result<&str> {
        Ok(&self.first_profile()?.scene_id)
    }

    fn evaluate(self, scene: &Scene) -> Result<ProposedChanges> {
        let sketch = scene
            .sketches
            .get(&self.first_profile()?.sketch_id)
            .ok_or_else(|| {
                CoreError::new(ErrorCode::NotFound, "Sketch does not exist in this scene")
            })?;
        let mut selected = std::collections::BTreeSet::new();
        let mut shapes = Vec::new();
        for profile in self.profile.regions() {
            if profile.scene_id != scene.data.id
                || profile.sketch_id != sketch.data.id
                || !selected.insert(&profile.id)
            {
                return Err(CoreError::new(
                    ErrorCode::InvalidParameter,
                    "Select distinct regions from one sketch",
                ));
            }
            shapes.push(evaluate_profile(sketch, profile, &self.parameters)?);
        }
        let (created, changed) = match self.parameters.mode.unwrap_or(ExtrudeMode::NewBody) {
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
                cut_targets(scene, self.targets.as_deref(), &shapes)?,
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

fn cut_targets(scene: &Scene, targets: Option<&[BodyRef]>, shapes: &[Shape]) -> Result<Vec<Body>> {
    let targets = targets.map(<[BodyRef]>::to_vec).unwrap_or_else(|| {
        scene
            .bodies
            .values()
            .map(|body| body.reference.clone())
            .collect()
    });
    let mut changed = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for target in targets {
        if target.scene_id != scene.data.id || !seen.insert(target.id.clone()) {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Cut targets must be distinct bodies in the profile's scene",
            ));
        }
        let body = scene
            .bodies
            .get(&target.id)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "Cut target does not exist"))?;
        let mut candidate = None;
        for tool in shapes {
            if let Some(next) = candidate.as_ref().unwrap_or(&body.shape).cut(tool)? {
                candidate = Some(next);
            }
        }
        if let Some(shape) = candidate {
            changed.push(Body {
                reference: target,
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

fn evaluate_profile(
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

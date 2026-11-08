use crate::{
    error::{CoreError, ErrorCode, Result},
    model::{Body, Scene},
    protocol::*,
    sketch::{self, Frame, Sketch},
    solid,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub struct Engine {
    scenes: BTreeMap<String, Scene>,
    next_id: u64,
}

impl Engine {
    fn id(&mut self, kind: &str) -> String {
        self.next_id += 1;
        format!("{kind}-{}", self.next_id)
    }

    fn scene(&self, id: &str) -> Result<&Scene> {
        self.scenes
            .get(id)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "Scene does not exist"))
    }

    fn sketch(&self, reference: &SketchRef) -> Result<&Sketch> {
        self.scene(&reference.scene_id)?
            .sketches
            .get(&reference.id)
            .ok_or_else(|| {
                CoreError::new(ErrorCode::NotFound, "Sketch does not exist in this scene")
            })
    }

    fn body(&self, reference: &BodyRef) -> Result<&Body> {
        self.scene(&reference.scene_id)?
            .bodies
            .get(&reference.id)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "Body does not exist in this scene"))
    }

    fn face_frame(&self, face: &FaceRef) -> Result<Frame> {
        let scene = self.scene(&face.scene_id)?;
        let body = BodyRef {
            scene_id: face.scene_id.clone(),
            id: face.body_id.clone(),
        };
        let generated_by_feature = scene
            .features
            .get(&face.origin.feature)
            .is_some_and(|f| f.new_solids.contains(&body));
        if !generated_by_feature {
            return Err(CoreError::new(
                ErrorCode::NotFound,
                "This feature did not create the selected body",
            ));
        }
        match face.origin.role {
            FaceRole::EndCap => self.body(&body)?.shape.end_cap_frame(),
        }
    }

    fn extrude(&mut self, input: Extrude) -> Result<ExtrudeFeature> {
        let scene_id = input.profile.scene_id.clone();
        let sketch = self.sketch(&SketchRef {
            scene_id: scene_id.clone(),
            id: input.profile.sketch_id.clone(),
        })?;
        let shape = solid::extrude::evaluate(sketch, &input.profile, &input.parameters)?;
        let mut new_solids = Vec::new();
        let mut affected_solids = Vec::new();
        // No body is changed until every candidate solid has been built and validated.
        let bodies = match input.parameters.mode.unwrap_or(ExtrudeMode::NewBody) {
            ExtrudeMode::NewBody => {
                if input.targets.is_some() {
                    return Err(CoreError::new(
                        ErrorCode::InvalidParameter,
                        "New-body extrusion does not accept targets",
                    ));
                }
                let reference = BodyRef {
                    scene_id: scene_id.clone(),
                    id: self.id("body"),
                };
                new_solids.push(reference.clone());
                vec![Body { reference, shape }]
            }
            ExtrudeMode::Cut => {
                let scene = self.scene(&scene_id)?;
                let targets = input.targets.clone().unwrap_or_else(|| {
                    scene.bodies.values().map(|b| b.reference.clone()).collect()
                });
                let mut candidates = Vec::new();
                let mut seen = BTreeSet::new();
                for target in targets {
                    if target.scene_id != scene_id || !seen.insert(target.id.clone()) {
                        return Err(CoreError::new(
                            ErrorCode::InvalidParameter,
                            "Cut targets must be distinct bodies in the profile's scene",
                        ));
                    }
                    if let Some(result) = self.body(&target)?.shape.cut(&shape)? {
                        affected_solids.push(target.clone());
                        candidates.push(Body {
                            reference: target,
                            shape: result,
                        });
                    }
                }
                if candidates.is_empty() {
                    return Err(CoreError::new(
                        ErrorCode::InvalidParameter,
                        "Cut removes no material from its targets",
                    ));
                }
                candidates
            }
        };
        let feature = ExtrudeFeature {
            id: self.id("feature"),
            operation: Operation::Extrude {
                inputs: ExtrudeInputs {
                    profile: input.profile,
                    targets: input.targets,
                },
                parameters: input.parameters,
            },
            new_solids,
            affected_solids,
        };
        let scene = self.scenes.get_mut(&scene_id).unwrap();
        for body in bodies {
            scene.bodies.insert(body.reference.id.clone(), body);
        }
        scene.features.insert(feature.id.clone(), feature.clone());
        Ok(feature)
    }

    pub fn execute(&mut self, request: Request) -> Result<Response> {
        match request {
            Request::SceneCreate(input) => {
                let scene = Scene::new(self.id("scene"), input.name);
                let data = scene.data.clone();
                self.scenes.insert(data.id.clone(), scene);
                Ok(Response::SceneCreate(data))
            }
            Request::SketchCreate(input) => {
                let frame = match &input.plane {
                    SketchSupport::Plane(plane) => {
                        if !self.scene(&plane.scene_id)?.has_plane(plane) {
                            return Err(CoreError::new(
                                ErrorCode::NotFound,
                                "Construction plane does not exist",
                            ));
                        }
                        Frame::builtin(plane.plane)
                    }
                    SketchSupport::Face(face) => self.face_frame(face)?,
                };
                let sketch = Sketch::new(self.id("sketch"), input.plane, frame);
                let data = sketch.data.clone();
                self.scenes
                    .get_mut(&data.scene_id)
                    .unwrap()
                    .sketches
                    .insert(data.id.clone(), sketch);
                Ok(Response::SketchCreate(data))
            }
            Request::PrimitiveAdd(input) => {
                self.sketch(&input.sketch)?.ensure_editable()?;
                let id = match &input.primitive {
                    Primitive::Rectangle(params) => {
                        sketch::primitives::validate(params)?;
                        self.id("rectangle")
                    }
                    Primitive::Circle(_) => self.id("circle"),
                };
                let sketch = self
                    .scenes
                    .get_mut(&input.sketch.scene_id)
                    .unwrap()
                    .sketches
                    .get_mut(&input.sketch.id)
                    .unwrap();
                let data = match input.primitive {
                    Primitive::Rectangle(params) => PrimitiveData::Rectangle(
                        sketch::primitives::add_rectangle(sketch, id, params),
                    ),
                    Primitive::Circle(params) => {
                        PrimitiveData::Circle(sketch::primitives::add_circle(sketch, id, params)?)
                    }
                };
                Ok(Response::PrimitiveAdd(data))
            }
            Request::SketchComplete(input) => {
                self.sketch(&input.sketch)?;
                let sketch = self
                    .scenes
                    .get_mut(&input.sketch.scene_id)
                    .unwrap()
                    .sketches
                    .get_mut(&input.sketch.id)
                    .unwrap();
                Ok(Response::SketchComplete(sketch.complete()?))
            }
            Request::RegionOnly(input) => Ok(Response::RegionOnly(
                self.sketch(&input.sketch)?.only_region()?,
            )),
            Request::SolidExtrude(input) => Ok(Response::SolidExtrude(self.extrude(input)?)),
            Request::FaceOnly(input) => {
                let face = FaceRef {
                    scene_id: input.body.scene_id,
                    body_id: input.body.id,
                    origin: input.origin,
                };
                self.face_frame(&face)?;
                Ok(Response::FaceOnly(face))
            }
            Request::BodyGet(input) => {
                Ok(Response::BodyGet(self.body(&input.body)?.reference.clone()))
            }
            Request::BodyProperties(input) => Ok(Response::BodyProperties(BodyProperties {
                volume: Volume {
                    value: self.body(&input.body)?.shape.volume()?,
                    unit: VolumeUnit::CubicMillimetres,
                },
            })),
        }
    }
}

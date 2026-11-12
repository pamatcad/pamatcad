pub(crate) mod modeling;

use crate::{
    error::{CoreError, ErrorCode, Result},
    model::{Body, Scene},
    protocol::*,
    sketch::{self, Frame, Sketch},
};
use std::collections::BTreeMap;

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
        match face {
            FaceRef::Origin {
                scene_id,
                body_id,
                origin,
            } => {
                let scene = self.scene(scene_id)?;
                let body = BodyRef {
                    scene_id: scene_id.clone(),
                    id: body_id.clone(),
                };
                if !scene
                    .features
                    .get(&origin.feature)
                    .is_some_and(|f| f.new_solids.contains(&body))
                {
                    return Err(CoreError::new(
                        ErrorCode::NotFound,
                        "This feature did not create the selected body",
                    ));
                }
                match origin.role {
                    FaceRole::EndCap => self.body(&body)?.shape.face_frame(0),
                }
            }
            FaceRef::Selected {
                scene_id,
                body_id,
                face_id,
            } => self
                .body(&BodyRef {
                    scene_id: scene_id.clone(),
                    id: body_id.clone(),
                })?
                .shape
                .face_frame(*face_id),
        }
    }

    pub fn execute(&mut self, request: Request) -> Result<Response> {
        match request {
            Request::SceneExport(input) => Ok(Response::SceneExport(
                self.scene(&input.scene_id)?
                    .export_step(input.bodies.as_deref())?,
            )),
            Request::SceneCapture(input) => Ok(Response::SceneCapture(
                self.scene(&input.scene_id)?.capture(&input)?,
            )),
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
                let scene = self.scenes.get_mut(&input.sketch.scene_id).unwrap();
                let data = scene
                    .sketches
                    .get_mut(&input.sketch.id)
                    .unwrap()
                    .complete()?;
                scene.timeline.push(TimelineEntry::Sketch {
                    id: data.id.clone(),
                });
                Ok(Response::SketchComplete(data))
            }
            Request::TimelineList(input) => Ok(Response::TimelineList(
                self.scene(&input.scene_id)?.timeline.clone(),
            )),
            Request::RegionsAll(input) => Ok(Response::RegionsAll(
                self.sketch(&input.sketch)?.all_regions()?,
            )),
            Request::RegionOnly(input) => Ok(Response::RegionOnly(
                self.sketch(&input.sketch)?.only_region()?,
            )),
            Request::SolidExtrude(input) => self
                .execute_modeling(input.preview.unwrap_or(false), input)
                .map(Response::SolidExtrude),
            Request::FaceOnly(input) => {
                let face = match input {
                    FaceQuery::Origin { body, origin } => {
                        let face = FaceRef::Origin {
                            scene_id: body.scene_id,
                            body_id: body.id,
                            origin,
                        };
                        self.face_frame(&face)?;
                        face
                    }
                    FaceQuery::Normal { body, normal } => {
                        let face_id = self.body(&body)?.shape.face_by_normal(normal)?;
                        FaceRef::Selected {
                            scene_id: body.scene_id,
                            body_id: body.id,
                            face_id,
                        }
                    }
                };
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

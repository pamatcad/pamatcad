pub(crate) mod modeling;

use crate::{
    error::{CoreError, ErrorCode, Result},
    formula::FormulaEvaluator,
    model::{Body, Scene},
    protocol::*,
    sketch::{self, Frame, Sketch},
};
use std::collections::BTreeMap;

#[derive(Default)]
pub struct Engine {
    scenes: BTreeMap<String, Scene>,
    next_id: u64,
    next_revision: u64,
    previews: BTreeMap<(u64, String), modeling::PreviewOverlay>,
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
        let (body, slot) = self.scene(face.scene_id())?.resolve_face(face)?;
        body.shape.face_frame(slot)
    }

    pub fn execute(&mut self, request: Request) -> Result<Response> {
        self.execute_for(0, request)
    }

    pub fn end_session(&mut self, session: u64) {
        self.previews.retain(|(owner, _), _| *owner != session);
    }

    fn invalidate_previews(&mut self, scene: &str) {
        self.previews.retain(|(_, id), _| id != scene);
    }

    pub fn execute_for(&mut self, session: u64, request: Request) -> Result<Response> {
        match request {
            Request::SceneExport(input) => Ok(Response::SceneExport(
                self.scene(&input.scene_id)?
                    .export_step(input.bodies.as_deref())?,
            )),
            Request::SceneCapture(input) => Ok(Response::SceneCapture(
                self.scene(&input.scene_id)?.capture(&input)?,
            )),
            Request::SceneCreate(input) => {
                let scene = Scene::new(
                    self.id("scene"),
                    input.name,
                    input.units.unwrap_or_default(),
                );
                let data = scene.data.clone();
                self.scenes.insert(data.id.clone(), scene);
                Ok(Response::SceneCreate(data))
            }
            Request::SceneEvaluateFormula(input) => {
                let units = self.scene(&input.scene_id)?.data.units;
                let result = FormulaEvaluator::evaluate(
                    &input.expression,
                    units.unit(input.expected_dimension),
                )?;
                Ok(Response::SceneEvaluateFormula(result))
            }
            Request::SceneClose(query) => {
                self.scenes.remove(&query.scene_id).ok_or_else(|| {
                    CoreError::new(ErrorCode::NotFound, "Scene does not exist")
                })?;
                self.invalidate_previews(&query.scene_id);
                Ok(Response::SceneClose(()))
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
                self.invalidate_previews(&data.scene_id);
                Ok(Response::SketchCreate(data))
            }
            Request::SketchGetProxy(query) => Ok(Response::SketchGetProxy(
                self.sketch(&query.sketch)?.proxy()?,
            )),
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
                self.invalidate_previews(&input.sketch.scene_id);
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
                self.invalidate_previews(&input.sketch.scene_id);
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
                .execute_modeling(session, input)
                .map(Response::SolidExtrude),
            Request::BodiesAll(input) => Ok(Response::BodiesAll(
                self.scene(&input.scene_id)?
                    .bodies
                    .values()
                    .map(|body| body.reference.clone())
                    .collect(),
            )),
            Request::ExtrudeFacesAll(input) => Ok(Response::ExtrudeFacesAll(
                self.scene(input.profile.scene_id())?
                    .extrude_faces_for(&input)?,
            )),
            Request::ExtrudeFaceOnly(input) => {
                let matches = self
                    .scene(input.profile.scene_id())?
                    .extrude_faces_for(&input)?;
                match matches.as_slice() {
                    [face] => Ok(Response::ExtrudeFaceOnly(face.clone())),
                    [] => Err(CoreError::new(
                        ErrorCode::NotFound,
                        "No surviving face matches this extrusion selector",
                    )),
                    _ => Err(CoreError::new(
                        ErrorCode::AmbiguousFace,
                        "Multiple faces match this extrusion selector",
                    )),
                }
            }
            Request::FaceProperties(face) => {
                let (body, slot) = self.scene(face.scene_id())?.resolve_face(&face)?;
                Ok(Response::FaceProperties(body.shape.face_properties(slot)?))
            }
            Request::FacesAll(input) => {
                let ids = self.body(&input.body)?.shape.face_ids(None)?;
                Ok(Response::FacesAll(
                    ids.into_iter()
                        .map(|face_id| FaceRef::Selected {
                            scene_id: input.body.scene_id.clone(),
                            body_id: input.body.id.clone(),
                            face_id,
                        })
                        .collect(),
                ))
            }
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
            Request::BodyRevisions(query) => Ok(Response::BodyRevisions(
                self.scene(&query.scene_id)?
                    .bodies
                    .values()
                    .map(|b| BodyRevision {
                        body: b.reference.clone(),
                        revision: b.revision.to_string(),
                    })
                    .collect(),
            )),
            Request::SceneGetProxyFor(query) => self
                .proxy_for(session, query)
                .map(Response::SceneGetProxyFor),
            Request::SceneDiscardPreview(query) => {
                self.scene(&query.scene_id)?;
                self.previews.remove(&(session, query.scene_id));
                Ok(Response::SceneDiscardPreview(()))
            }
            Request::BodyMesh(input) => Ok(Response::BodyMesh(
                self.body(&input.body)?.shape.triangle_mesh()?,
            )),
            Request::BodyProperties(input) => Ok(Response::BodyProperties(BodyProperties {
                volume: Volume {
                    value: self.body(&input.body)?.shape.volume()?,
                    unit: VolumeUnit::CubicMillimetres,
                },
            })),
        }
    }
}

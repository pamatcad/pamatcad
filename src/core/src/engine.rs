pub(crate) mod modeling;
mod sketching;

use crate::{
    error::{CoreError, ErrorCode, Result},
    model::{Body, Scene},
    protocol::*,
    sketch::{Frame, Sketch},
};
use std::collections::BTreeMap;

#[derive(Default)]
pub struct Engine {
    scenes: BTreeMap<String, Scene>,
    next_id: u64,
    next_revision: u64,
    previews: BTreeMap<(u64, String), modeling::PreviewOverlay>,
    sketch_previews: BTreeMap<(u64, String), Sketch>,
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
        self.sketch_previews
            .retain(|(owner, _), _| *owner != session);
    }

    fn invalidate_previews(&mut self, scene: &str) {
        self.previews.retain(|(_, id), _| id != scene);
        self.sketch_previews.retain(|(_, id), _| id != scene);
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
                let result = self
                    .scene(&input.scene_id)?
                    .evaluate_formula(&input.expression, units.unit(input.expected_dimension))?;
                Ok(Response::SceneEvaluateFormula(result))
            }
            Request::SceneClose(query) => {
                self.scenes
                    .remove(&query.scene_id)
                    .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "Scene does not exist"))?;
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
                let mut sketch = Sketch::new(self.id("sketch"), input.plane, frame);
                sketch.data.name = input.name;
                self.validate_sketch_name(
                    &sketch.data.scene_id,
                    &sketch.data.id,
                    sketch.data.name.as_deref(),
                )?;
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
                self.view_sketch(session, &query)?.proxy()?,
            )),
            Request::PrimitiveAdd(mut input) => {
                if let Primitive::Text(p) = &mut input.primitive {
                    let scene = self.scene(&input.sketch.scene_id)?;
                    let evaluated = scene.evaluate_formula(&p.size, scene.data.units.length)?;
                    p.size = Formula::Number(
                        evaluated.computed.value
                            * FormulaUnit::Length(evaluated.computed.unit).scale(),
                    );
                }
                let data = self.update_sketch_for(
                    session,
                    input.preview.unwrap_or(false),
                    &input.sketch,
                    |sketch| sketch.add_primitive(input.primitive),
                )?;
                Ok(Response::PrimitiveAdd(data))
            }
            Request::SketchComplete(input) => {
                self.complete_sketch(input).map(Response::SketchComplete)
            }
            Request::SketchFind(input) => self.find_sketch(input).map(Response::SketchFind),
            Request::SketchState(input) => Ok(Response::SketchState(
                self.view_sketch(session, &input)?.state(),
            )),
            Request::SketchEdit(input) => self.edit_sketch(input).map(Response::SketchEdit),
            Request::SketchCancel(input) => self.cancel_sketch(input).map(Response::SketchCancel),
            Request::SketchSettings(input) => {
                self.sketch_settings(input).map(Response::SketchSettings)
            }
            Request::SketchRecompute(input) => {
                self.sketch(&input.sketch)?.ensure_editable()?;
                self.recompute_sketch(&input.sketch)?;
                Ok(Response::SketchRecompute(
                    self.sketch(&input.sketch)?.status.clone(),
                ))
            }
            Request::SketchConstraintAdd(input) => self
                .update_sketch(&input.sketch, |sketch| {
                    sketch.add_constraint(input.kind, input.parameters)
                })
                .map(Response::SketchConstraintAdd),
            Request::SketchDimensionAdd(input) => self
                .add_sketch_dimension(input)
                .map(Response::SketchDimensionAdd),
            Request::SketchDimensionUpdate(input) => self
                .update_sketch_dimension(input)
                .map(Response::SketchDimensionUpdate),
            Request::SketchRemove(input) => {
                self.remove_sketch_items(input).map(Response::SketchRemove)
            }
            Request::SketchModifyCurves(input) => self
                .modify_sketch_curves(session, input)
                .map(Response::SketchModifyCurves),
            Request::SketchTransform(input) => self
                .transform_sketch(session, input)
                .map(Response::SketchTransform),
            Request::SketchConstruction(input) => {
                self.update_sketch(&input.sketch, |s| {
                    for id in s.selected_entities(&input.entities)? {
                        if id != "origin" {
                            s.entities.get_mut(&id).unwrap().construction = input.construction;
                        }
                    }
                    Ok(())
                })?;
                Ok(Response::SketchConstruction(
                    self.sketch(&input.sketch)?.state(),
                ))
            }
            Request::SketchProject(input) => {
                self.project_geometry(input).map(Response::SketchProject)
            }
            Request::SketchSupportUpdate(input) => self
                .update_sketch_support(input)
                .map(Response::SketchSupportUpdate),
            Request::SketchDrag(input) => self.drag_sketch_point(input).map(Response::SketchDrag),
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
                self.sketch_previews
                    .remove(&(session, query.scene_id.clone()));
                self.previews.remove(&(session, query.scene_id));
                Ok(Response::SceneDiscardPreview(()))
            }
            Request::BodyVertices(input) => {
                let body = self.body(&input.body)?;
                Ok(Response::BodyVertices(
                    body.shape
                        .vertices(&body.reference, &body.revision.to_string())?,
                ))
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
